import { randomUUID } from "node:crypto";

import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { CanonicalRequest, RoutingMode } from "@vartma/canonical";
import type { RouterConfig } from "@vartma/config";
import {
  checkDatabase,
  PrismaUsageAnalyticsStore,
  PrismaSessionStateStore,
  type AttemptStore,
  type RouterDatabase,
  type UsageAnalyticsStore,
} from "@vartma/database";
import { ProviderError } from "@vartma/providers";
import {
  CircuitBreakerRegistry,
  InMemorySessionStateStore,
  ModelRegistry,
  RoutingEngine,
  RoutingError,
  SessionCoordinator,
  type SessionStateStore,
} from "@vartma/routing";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from "express";
import pino, { type Logger } from "pino";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";

import { createApiKeyAuth } from "./auth.js";
import { normalizeAnthropicRequest } from "./anthropic/normalize.js";
import { collectAnthropicResponse, toAnthropicSse } from "./anthropic/response.js";
import { anthropicMessagesRequestSchema } from "./anthropic/schema.js";
import { executeCanonical, setRoutingResponseHeaders } from "./execution.js";
import { GatewayMetrics } from "./metrics.js";
import { normalizeOpenAIChatRequest } from "./openai/chat-normalize.js";
import { collectChatCompletion, toChatCompletionSse } from "./openai/chat-response.js";
import { openAIChatRequestSchema } from "./openai/chat-schema.js";
import { normalizeOpenAIResponseRequest } from "./openai/responses-normalize.js";
import { collectOpenAIResponse, toOpenAIResponseSse } from "./openai/responses-response.js";
import { openAIResponsesRequestSchema } from "./openai/responses-schema.js";
import { sessionOutcomeSchema } from "./outcomes.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { parseUsageAnalyticsQuery } from "./usage.js";

export interface CreateAppOptions {
  config: RouterConfig;
  runtime?: Runtime;
  logger?: Logger;
  database?: RouterDatabase;
  attemptStore?: AttemptStore;
  usageAnalyticsStore?: UsageAnalyticsStore;
  sessionStore?: SessionStateStore;
}

export function createApp(options: CreateAppOptions): Express {
  const { config } = options;
  const logger =
    options.logger ??
    pino({
      level: config.telemetry.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-api-key",
          "headers.authorization",
          "headers.x-api-key",
        ],
        censor: "[REDACTED]",
      },
    });
  const runtime = options.runtime ?? createRuntime(config);
  const sessionStore =
    options.sessionStore ??
    (options.database
      ? new PrismaSessionStateStore(options.database)
      : new InMemorySessionStateStore());
  const sessionCoordinator = new SessionCoordinator(sessionStore, config.routing.session);
  const usageAnalyticsStore =
    options.usageAnalyticsStore ??
    (options.database ? new PrismaUsageAnalyticsStore(options.database) : undefined);
  const circuits = new CircuitBreakerRegistry(config.routing.circuitBreaker);
  const routingEngine = new RoutingEngine({
    models: new ModelRegistry(runtime.models.values()),
    providers: runtime.registry,
    policies: config.routing.policies,
    routerVersion: config.routing.routerVersion,
    sessionPolicy: config.routing.session,
    ...(config.routing.baselineModel ? { baselineModel: config.routing.baselineModel } : {}),
  });
  const metrics = new GatewayMetrics();
  const tracer = trace.getTracer(config.telemetry.serviceName, "0.1.0");
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", config.server.trustProxy);
  app.use(
    pinoHttp({
      logger,
      genReqId(request, response) {
        const incoming = request.headers["x-request-id"];
        const id = typeof incoming === "string" && incoming ? incoming : randomUUID();
        response.setHeader("x-request-id", id);
        response.setHeader("request-id", id);
        return id;
      },
    }),
  );
  app.use(express.json({ limit: config.server.requestBodyLimitBytes }));
  app.use((request, response, next) => {
    const span = tracer.startSpan("vartma.http_request", {
      attributes: {
        "http.request.method": request.method,
        "url.path": request.path,
      },
    });
    response.once("finish", () => {
      span.setAttribute("http.response.status_code", response.statusCode);
      span.setStatus({
        code: response.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      });
      span.end();
    });
    response.once("close", () => {
      if (!response.writableEnded) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: "Client connection closed before response completion.",
        });
        span.end();
      }
    });
    next();
  });

  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.head("/", (_request, response) => {
    response.status(200).end();
  });

  app.get("/readyz", async (_request, response) => {
    const checks = await Promise.all(
      [...runtime.models.values()].map(async (model) => {
        try {
          const adapter = runtime.registry.get(model.provider);
          const health = await adapter.health(model.upstreamModel);
          return {
            provider: model.provider,
            model: model.id,
            healthy: health.healthy,
            reason: health.reason,
          };
        } catch (error) {
          return {
            provider: model.provider,
            model: model.id,
            healthy: false,
            reason: safeErrorMessage(error),
          };
        }
      }),
    );
    const database = await databaseReadiness(options.database);
    const providersReady = checks.some((check) => check.healthy);
    const ready = providersReady && (!config.database.requiredForReadiness || database.healthy);
    response.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      providers: checks,
      database,
    });
  });

  app.get("/metrics", (_request, response) => {
    response.type("text/plain; version=0.0.4").send(metrics.render());
  });

  if (config.auth.enabled) {
    const authenticate = createApiKeyAuth(config.auth.apiKeys);
    app.use("/v1", authenticate);
    app.use("/internal/v1", authenticate);
    app.use("/vartma/v1", authenticate);
  }

  app.get("/vartma/v1/usage", async (request, response, next) => {
    try {
      if (!usageAnalyticsStore) {
        response.status(503).json({
          type: "error",
          error: {
            type: "api_error",
            message: "Usage analytics require a configured PostgreSQL store.",
          },
        });
        return;
      }
      let query;
      try {
        query = parseUsageAnalyticsQuery(request.query);
      } catch (error) {
        if (error instanceof ZodError) {
          throw error;
        }
        throw new InputError(error instanceof Error ? error.message : "Invalid usage query.");
      }
      response.json(await usageAnalyticsStore.query(query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/vartma/v1/usage/requests/:requestId", async (request, response, next) => {
    try {
      if (!usageAnalyticsStore) {
        response.status(503).json({
          type: "error",
          error: {
            type: "api_error",
            message: "Usage analytics require a configured PostgreSQL store.",
          },
        });
        return;
      }
      const requestId = requireIdentifier(request.params["requestId"], "request ID");
      const report = await usageAnalyticsStore.request(requestId);
      if (!report) {
        response.status(404).json({
          type: "error",
          error: {
            type: "not_found_error",
            message: `Usage for request "${requestId}" was not found.`,
          },
        });
        return;
      }
      response.json(report);
    } catch (error) {
      next(error);
    }
  });

  app.get("/v1/models", (_request, response) => {
    const virtualModels = [
      { id: "claude-vartma-quality", display_name: "Vartma.ai: Quality" },
      { id: "claude-vartma-balanced", display_name: "Vartma.ai: Balanced" },
      { id: "claude-vartma-eco", display_name: "Vartma.ai: Eco" },
      { id: "vartma-quality", display_name: "Vartma.ai: Quality" },
      { id: "vartma-balanced", display_name: "Vartma.ai: Balanced" },
      { id: "vartma-eco", display_name: "Vartma.ai: Eco" },
    ];
    const configuredModels = [...runtime.models.values()].map((model) => ({
      id: model.id,
      display_name: model.id,
    }));
    response.json({
      object: "list",
      data: [...virtualModels, ...configuredModels].map((model) => ({
        ...model,
        type: "model",
      })),
      has_more: false,
      first_id: virtualModels[0]?.id ?? null,
      last_id: configuredModels.at(-1)?.id ?? virtualModels.at(-1)?.id ?? null,
    });
  });

  app.post("/v1/messages/count_tokens", async (request, response, next) => {
    try {
      const input = anthropicMessagesRequestSchema.parse({
        ...(request.body as Record<string, unknown>),
        max_tokens: 1,
        stream: false,
      });
      const routingMode = readRoutingMode(
        request,
        routingModeFromModel(input.model) ?? config.routing.defaultMode,
      );
      const canonicalRequest = normalizeAnthropicRequest(input, {
        requestId: `count_${randomUUID()}`,
        routingMode,
      });
      attachClaudeCodeProtocol(request, canonicalRequest);
      applyRoutingHeaders(request, canonicalRequest);
      const defaultModel =
        runtime.models.get(config.routing.defaultModel) ?? runtime.models.values().next().value;
      if (!defaultModel) {
        throw new Error(`Default model "${config.routing.defaultModel}" is unavailable.`);
      }
      const estimate = await runtime.registry
        .get(defaultModel.provider)
        .estimateTokens(canonicalRequest);
      response.json({ input_tokens: estimate.inputTokens });
    } catch (error) {
      next(error);
    }
  });

  app.get("/internal/v1/sessions/:sessionId", async (request, response, next) => {
    try {
      const sessionId = requireSessionId(request.params["sessionId"]);
      const state = await sessionStore.get(sessionId);
      if (!state) {
        response.status(404).json({
          type: "error",
          error: { type: "not_found_error", message: `Session "${sessionId}" was not found.` },
        });
        return;
      }
      response.json({ session: state });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/v1/sessions/:sessionId/outcomes", async (request, response, next) => {
    try {
      if (!config.routing.session.enabled) {
        throw new InputError("Session routing is disabled.");
      }
      const sessionId = requireSessionId(request.params["sessionId"]);
      const input = sessionOutcomeSchema.parse(request.body);
      const existing = await sessionStore.get(sessionId);
      const result = await sessionCoordinator.recordOutcome(
        sessionId,
        existing?.routingMode ?? config.routing.defaultMode,
        {
          kind: input.kind,
          ...(input.request_id ? { requestId: input.request_id } : {}),
          ...(input.source ? { source: input.source } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
      );
      metrics.sessionOutcome(result.escalated, result.deescalated);
      response.status(202).json({
        session_id: sessionId,
        escalation_level: result.state.escalationLevel,
        consecutive_failures: result.state.consecutiveFailures,
        successful_outcomes: result.state.successfulOutcomes,
        escalated: result.escalated,
        deescalated: result.deescalated,
        cooldown_until: result.state.cooldownUntil ?? null,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/responses", async (request, response, next) => {
    const requestId =
      typeof request.id === "string" || typeof request.id === "number"
        ? String(request.id)
        : randomUUID();
    const abortController = createRequestAbortController(request, response);
    metrics.requestStarted();

    try {
      const input = openAIResponsesRequestSchema.parse(request.body);
      const routingMode = readRoutingMode(
        request,
        routingModeFromModel(input.model) ?? config.routing.defaultMode,
      );
      const sessionId = readSessionId(request);
      const canonicalRequest = normalizeOpenAIResponseRequest(input, {
        requestId,
        routingMode,
        ...(sessionId ? { sessionId } : {}),
      });
      applyRoutingHeaders(request, canonicalRequest);
      const execution = await executeCanonical({
        request: canonicalRequest,
        requestId,
        routingMode,
        ...(sessionId ? { sessionId } : {}),
        runtime,
        routingEngine,
        sessionCoordinator,
        circuits,
        config,
        metrics,
        ...(options.attemptStore ? { attemptStore: options.attemptStore } : {}),
        signal: abortController.signal,
      });
      setRoutingResponseHeaders(
        (name, value) => {
          response.setHeader(name, value);
        },
        execution,
        routingMode,
      );

      if (input.stream) {
        setStreamingHeaders(response);
        for await (const chunk of toOpenAIResponseSse(execution.events, input)) {
          if (!response.write(chunk)) {
            await waitForDrain(response, abortController.signal);
          }
        }
        response.end();
      } else {
        response.status(200).json(await collectOpenAIResponse(execution.events, input));
      }
      metrics.requestCompleted(execution.terminalState.completed ? "completed" : "failed");
    } catch (error) {
      metrics.requestCompleted(abortController.signal.aborted ? "cancelled" : "failed");
      if (response.headersSent) {
        if (!response.writableEnded) {
          response.write(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              code: classifyError(error),
              message: safeErrorMessage(error),
            })}\n\n`,
          );
          response.end();
        }
        return;
      }
      next(error);
    }
  });

  app.post("/v1/chat/completions", async (request, response, next) => {
    const requestId =
      typeof request.id === "string" || typeof request.id === "number"
        ? String(request.id)
        : randomUUID();
    const abortController = createRequestAbortController(request, response);
    metrics.requestStarted();

    try {
      const input = openAIChatRequestSchema.parse(request.body);
      const routingMode = readRoutingMode(
        request,
        routingModeFromModel(input.model) ?? config.routing.defaultMode,
      );
      const sessionId = readSessionId(request);
      const canonicalRequest = normalizeOpenAIChatRequest(input, {
        requestId,
        routingMode,
        ...(sessionId ? { sessionId } : {}),
      });
      applyRoutingHeaders(request, canonicalRequest);
      const execution = await executeCanonical({
        request: canonicalRequest,
        requestId,
        routingMode,
        ...(sessionId ? { sessionId } : {}),
        runtime,
        routingEngine,
        sessionCoordinator,
        circuits,
        config,
        metrics,
        ...(options.attemptStore ? { attemptStore: options.attemptStore } : {}),
        signal: abortController.signal,
      });
      setRoutingResponseHeaders(
        (name, value) => {
          response.setHeader(name, value);
        },
        execution,
        routingMode,
      );

      if (input.stream) {
        setStreamingHeaders(response);
        for await (const chunk of toChatCompletionSse(execution.events, {
          includeUsage: input.stream_options?.include_usage ?? false,
        })) {
          if (!response.write(chunk)) {
            await waitForDrain(response, abortController.signal);
          }
        }
        response.end();
      } else {
        response.status(200).json(await collectChatCompletion(execution.events));
      }
      metrics.requestCompleted(execution.terminalState.completed ? "completed" : "failed");
    } catch (error) {
      metrics.requestCompleted(abortController.signal.aborted ? "cancelled" : "failed");
      if (response.headersSent) {
        if (!response.writableEnded) {
          response.write(
            `data: ${JSON.stringify({
              error: {
                message: safeErrorMessage(error),
                type: classifyError(error),
                code: null,
              },
            })}\n\ndata: [DONE]\n\n`,
          );
          response.end();
        }
        return;
      }
      next(error);
    }
  });

  app.post("/v1/messages", async (request, response, next) => {
    const requestId =
      typeof request.id === "string" || typeof request.id === "number"
        ? String(request.id)
        : randomUUID();
    const abortController = createRequestAbortController(request, response);
    metrics.requestStarted();

    try {
      const input = anthropicMessagesRequestSchema.parse(request.body);
      const routingMode = readRoutingMode(
        request,
        routingModeFromModel(input.model) ?? config.routing.defaultMode,
      );
      const sessionId = readSessionId(request);
      const canonicalRequest = normalizeAnthropicRequest(input, {
        requestId,
        routingMode,
        ...(sessionId ? { sessionId } : {}),
      });
      attachClaudeCodeProtocol(request, canonicalRequest);
      applyRoutingHeaders(request, canonicalRequest);
      const execution = await executeCanonical({
        request: canonicalRequest,
        requestId,
        routingMode,
        ...(sessionId ? { sessionId } : {}),
        runtime,
        routingEngine,
        sessionCoordinator,
        circuits,
        config,
        metrics,
        ...(options.attemptStore ? { attemptStore: options.attemptStore } : {}),
        signal: abortController.signal,
      });
      setRoutingResponseHeaders(
        (name, value) => {
          response.setHeader(name, value);
        },
        execution,
        routingMode,
      );

      const events = execution.events;
      if (input.stream) {
        setStreamingHeaders(response);

        for await (const chunk of toAnthropicSse(events)) {
          if (!response.write(chunk)) {
            await waitForDrain(response, abortController.signal);
          }
        }
        response.end();
      } else {
        const message = await collectAnthropicResponse(events);
        response.status(200).json(message);
      }

      metrics.requestCompleted(execution.terminalState.completed ? "completed" : "failed");
    } catch (error) {
      metrics.requestCompleted(abortController.signal.aborted ? "cancelled" : "failed");

      if (response.headersSent) {
        if (!response.writableEnded) {
          response.write(
            `event: error\ndata: ${JSON.stringify({
              type: "error",
              error: {
                type: classifyError(error),
                message: safeErrorMessage(error),
              },
            })}\n\n`,
          );
          response.end();
        }
        return;
      }
      next(error);
    }
  });

  app.use((_request, response) => {
    response.status(404).json({
      type: "error",
      error: { type: "not_found_error", message: "Route not found." },
    });
  });

  const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    void _next;
    request.log.error({ err: error }, "Request failed");
    const status = errorStatus(error);
    if (request.path === "/v1/responses" || request.path === "/v1/chat/completions") {
      response.status(status).json({
        error: {
          message: safeErrorMessage(error),
          type: classifyError(error),
          param: null,
          code: null,
        },
      });
      return;
    }
    response.status(status).json({
      type: "error",
      error: {
        type: classifyError(error),
        message: safeErrorMessage(error),
      },
    });
  };
  app.use(errorHandler);

  return app;
}

function requireSessionId(value: string | undefined): string {
  const sessionId = value?.trim();
  if (!sessionId || sessionId.length > 200) {
    throw new InputError("A non-empty session ID of at most 200 characters is required.");
  }
  return sessionId;
}

function requireIdentifier(value: string | undefined, label: string): string {
  const identifier = value?.trim();
  if (!identifier || identifier.length > 300) {
    throw new InputError(`A non-empty ${label} of at most 300 characters is required.`);
  }
  return identifier;
}

function readRoutingMode(request: Request, fallback: RoutingMode): RoutingMode {
  const value = request.header("x-vartma-mode");
  if (!value) {
    return fallback;
  }
  if (value === "quality" || value === "balanced" || value === "eco" || value === "fixed") {
    return value;
  }
  throw new InputError(
    `Invalid x-vartma-mode "${value}". Expected quality, balanced, eco, or fixed.`,
  );
}

function readSessionId(request: Request): string | undefined {
  const value = request.header("x-vartma-session-id") ?? request.header("x-claude-code-session-id");
  return value === undefined ? undefined : requireSessionId(value);
}

function routingModeFromModel(model: string): RoutingMode | undefined {
  switch (model) {
    case "vartma-quality":
    case "claude-vartma-quality":
      return "quality";
    case "vartma-balanced":
    case "claude-vartma-balanced":
      return "balanced";
    case "vartma-eco":
    case "claude-vartma-eco":
      return "eco";
    default:
      return undefined;
  }
}

function setStreamingHeaders(response: Response): void {
  response.status(200);
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders();
}

function attachClaudeCodeProtocol(request: Request, canonicalRequest: CanonicalRequest): void {
  const headers: Record<string, string> = {};
  for (const name of Object.keys(request.headers)) {
    if (!name.startsWith("anthropic-")) {
      continue;
    }
    const value = request.header(name);
    if (value !== undefined) {
      headers[name] = value;
    }
  }
  if (canonicalRequest.protocolPassthrough) {
    canonicalRequest.protocolPassthrough.headers = headers;
  }
  const claudeSessionId = request.header("x-claude-code-session-id");
  const agentId = request.header("x-claude-code-agent-id");
  const parentAgentId = request.header("x-claude-code-parent-agent-id");
  if (claudeSessionId) {
    canonicalRequest.metadata["claude_code_session_id"] = claudeSessionId;
  }
  if (agentId) {
    canonicalRequest.metadata["claude_code_agent_id"] = agentId;
  }
  if (parentAgentId) {
    canonicalRequest.metadata["claude_code_parent_agent_id"] = parentAgentId;
  }
}

function createRequestAbortController(request: Request, response: Response): AbortController {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort(new Error("Client aborted request.")));
  response.once("close", () => {
    if (!response.writableEnded) {
      controller.abort(new Error("Client connection closed."));
    }
  });
  return controller;
}

async function waitForDrain(response: Response, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    signal.throwIfAborted();
  }
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(asError(signal.reason, "Request aborted."));
    };
    const cleanup = () => {
      response.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    response.once("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function classifyError(error: unknown): string {
  if (error instanceof ZodError || error instanceof InputError || error instanceof RoutingError) {
    return "invalid_request_error";
  }
  if (hasStatus(error, 400)) {
    return "invalid_request_error";
  }
  if (hasStatus(error, 413)) {
    return "request_too_large";
  }
  if (error instanceof ProviderError) {
    switch (error.code) {
      case "invalid_request":
        return "invalid_request_error";
      case "request_too_large":
        return "request_too_large";
      case "rate_limit":
        return "rate_limit_error";
      case "overloaded":
        return "overloaded_error";
      case "authentication":
      case "billing":
      case "permission":
      case "not_found":
      case "conflict":
      case "timeout":
      case "cancelled":
      case "upstream":
      case "network":
      case "protocol":
        return "api_error";
    }
  }
  return "api_error";
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    return issue
      ? `Invalid request at ${issue.path.join(".") || "body"}: ${issue.message}`
      : "Invalid request body.";
  }
  if (hasStatus(error, 400)) {
    return "The request body is not valid JSON.";
  }
  if (hasStatus(error, 413)) {
    return "The request body exceeds the configured size limit.";
  }
  if (
    error instanceof InputError ||
    error instanceof RoutingError ||
    error instanceof ProviderError
  ) {
    return error.message;
  }
  return "An unexpected error occurred.";
}

class InputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function errorStatus(error: unknown): number {
  if (
    error instanceof ZodError ||
    error instanceof InputError ||
    error instanceof RoutingError ||
    hasStatus(error, 400)
  ) {
    return 400;
  }
  if (hasStatus(error, 413)) {
    return 413;
  }
  if (error instanceof ProviderError) {
    switch (error.code) {
      case "invalid_request":
        return 400;
      case "request_too_large":
        return 413;
      case "rate_limit":
        return 429;
      case "timeout":
        return 504;
      case "overloaded":
        return 529;
      case "authentication":
      case "billing":
      case "permission":
      case "not_found":
      case "conflict":
      case "cancelled":
      case "upstream":
      case "network":
      case "protocol":
        return 502;
    }
  }
  return 500;
}

function applyRoutingHeaders(request: Request, canonicalRequest: CanonicalRequest): void {
  const forcedModel = optionalHeader(request, "x-vartma-model");
  const forcedProvider = optionalHeader(request, "x-vartma-provider");
  const requiredRegion = optionalHeader(request, "x-vartma-region");
  if (forcedModel) {
    canonicalRequest.constraints.forcedModel = forcedModel;
  }
  if (forcedProvider) {
    canonicalRequest.constraints.forcedProvider = forcedProvider;
  }
  if (requiredRegion) {
    canonicalRequest.constraints.requiredRegion = requiredRegion;
  }

  assignCsvHeader(request, "x-vartma-allowed-providers", (values) => {
    canonicalRequest.constraints.allowedProviders = values;
  });
  assignCsvHeader(request, "x-vartma-denied-providers", (values) => {
    canonicalRequest.constraints.deniedProviders = values;
  });
  assignCsvHeader(request, "x-vartma-allowed-models", (values) => {
    canonicalRequest.constraints.allowedModels = values;
  });
  assignCsvHeader(request, "x-vartma-denied-models", (values) => {
    canonicalRequest.constraints.deniedModels = values;
  });

  const maxCost = optionalNonnegativeNumberHeader(request, "x-vartma-max-cost-usd");
  if (maxCost !== undefined) {
    canonicalRequest.constraints.maxEstimatedCostUsd = maxCost;
  }
  const maxLatency = optionalPositiveIntegerHeader(request, "x-vartma-max-latency-ms");
  if (maxLatency !== undefined) {
    canonicalRequest.constraints.maxLatencyMs = maxLatency;
  }
}

function assignCsvHeader(request: Request, name: string, assign: (values: string[]) => void): void {
  const raw = optionalHeader(request, name);
  if (!raw) {
    return;
  }
  const values = [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (values.length === 0) {
    throw new InputError(`Header "${name}" must contain at least one value.`);
  }
  assign(values);
}

function optionalHeader(request: Request, name: string): string | undefined {
  const value = request.header(name)?.trim();
  return value || undefined;
}

function optionalNonnegativeNumberHeader(request: Request, name: string): number | undefined {
  const raw = optionalHeader(request, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new InputError(`Header "${name}" must be a nonnegative number.`);
  }
  return value;
}

function optionalPositiveIntegerHeader(request: Request, name: string): number | undefined {
  const raw = optionalHeader(request, name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new InputError(`Header "${name}" must be a positive integer.`);
  }
  return value;
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" && error !== null && "status" in error && error.status === status
  );
}

async function databaseReadiness(
  database: RouterDatabase | undefined,
): Promise<{ healthy: boolean; reason?: string }> {
  if (!database) {
    return { healthy: false, reason: "Database is not configured in this process." };
  }
  try {
    await checkDatabase(database);
    return { healthy: true };
  } catch (error) {
    return { healthy: false, reason: safeErrorMessage(error) };
  }
}
