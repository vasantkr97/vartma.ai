import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";

import type { RouterConfig } from "@vartma/config";
import { routerConfigSchema } from "@vartma/config";
import type { EvaluationStore, InspectionStore } from "@vartma/database";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CapabilitySet,
  HealthStatus,
  ModelDefinition,
  TokenEstimate,
} from "@vartma/canonical";
import {
  FakeProvider,
  ProviderError,
  ProviderRegistry,
  type ProviderAdapter,
} from "@vartma/providers";
import { InMemoryCanonicalHistoryStore } from "@vartma/routing";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/index.js";
import type { Runtime } from "../src/runtime.js";

function testConfig(): RouterConfig {
  return routerConfigSchema.parse({
    environment: "test",
    server: {
      host: "127.0.0.1",
      port: 8080,
      trustProxy: false,
      requestBodyLimitBytes: 1_048_576,
    },
    auth: {
      enabled: true,
      apiKeys: ["test-api-key"],
    },
    database: {
      url: "postgresql://vartma:vartma@localhost:5432/vartma",
      requiredForReadiness: false,
    },
    routing: {
      defaultMode: "balanced",
      defaultModel: "fake/default",
      routerVersion: "rules-v0",
    },
    providers: [
      {
        id: "fake",
        type: "fake",
        enabled: true,
        models: [
          {
            id: "fake/default",
            provider: "fake",
            upstreamModel: "fake-default",
            enabled: true,
            capabilities: {
              text: true,
              vision: false,
              streaming: true,
              tools: true,
              structuredOutput: true,
              reasoning: false,
            },
            contextWindow: 100_000,
            maxOutputTokens: 4096,
            qualityTier: 1,
            expectedLatencyTier: 1,
            pricing: {
              currency: "USD",
              effectiveFrom: "2026-07-23",
              verifiedAt: "2026-07-23",
              source: "gateway test fixture",
              inputPerMillion: 0,
              cachedInputPerMillion: 0,
              outputPerMillion: 0,
            },
          },
        ],
      },
    ],
    telemetry: {
      serviceName: "router-test",
      logLevel: "error",
      langSmith: {
        enabled: false,
        apiKeyEnv: "LANGSMITH_API_KEY",
        project: "router-test",
        exportContent: false,
      },
    },
  });
}

function app() {
  return createApp({
    config: testConfig(),
    logger: pino({ level: "silent" }),
  });
}

function routingApp() {
  return createApp({
    config: testConfig(),
    runtime: routingRuntime(),
    logger: pino({ level: "silent" }),
  });
}

function baseRequest(stream = false) {
  return {
    model: "fake/default",
    max_tokens: 256,
    stream,
    messages: [{ role: "user", content: "hello router" }],
  };
}

describe("gateway", () => {
  it("reports liveness without authentication", async () => {
    const response = await request(app()).get("/healthz");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("serves the React operator console without exposing API data anonymously", async () => {
    const gateway = app();
    const consoleResponse = await request(gateway).get("/console/");
    expect(consoleResponse.status).toBe(200);
    expect(consoleResponse.text).toContain("Vartma.ai Router Console");

    expect((await request(gateway).get("/vartma/v1/config-summary")).status).toBe(401);
    const summary = await request(gateway)
      .get("/vartma/v1/config-summary")
      .set("x-api-key", "test-api-key");
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      defaultMode: "balanced",
      defaultModel: "fake/default",
      calibration: { version: "uncalibrated" },
      providers: [{ id: "fake", credentialPresent: true }],
    });
    expect(JSON.stringify(summary.body)).not.toContain("test-api-key");
  });

  it("lists recent metadata-only sessions for the operator console", async () => {
    const gateway = routingApp();
    await request(gateway)
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-session-id", "console-session")
      .send(baseRequest());

    const response = await request(gateway)
      .get("/vartma/v1/sessions?limit=10")
      .set("x-api-key", "test-api-key");
    expect(response.status).toBe(200);
    expect(response.body.sessions).toEqual([
      expect.objectContaining({ id: "console-session", turnCount: 1 }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain("hello router");
  });

  it("lists redacted routing and failure summaries for the operator console", async () => {
    const inspectionStore: InspectionStore = {
      trace: () => Promise.resolve(undefined),
      sessions: () => Promise.resolve([]),
      session: () => Promise.resolve(undefined),
      requests: (limit, failuresOnly) => {
        expect(limit).toBe(25);
        expect(failuresOnly).toBe(true);
        return Promise.resolve([
          {
            id: "request-console",
            sessionId: "session-console",
            routingMode: "balanced",
            status: "FAILED",
            selectedProvider: "deepseek",
            selectedModel: "deepseek/reasoner",
            taskClass: "debugging",
            explanation: "Selected the lowest expected cost per successful attempt.",
            selectedReasons: ["Measured success fit"],
            attemptCount: 2,
            fallbackCount: 1,
            startedAt: "2026-08-24T00:00:00.000Z",
            completedAt: "2026-08-24T00:00:01.000Z",
            errorType: "timeout",
            errorMessage: "Upstream timed out.",
          },
        ]);
      },
    };
    const gateway = createApp({
      config: testConfig(),
      logger: pino({ level: "silent" }),
      inspectionStore,
    });
    const response = await request(gateway)
      .get("/vartma/v1/requests?limit=25&failures_only=true")
      .set("x-api-key", "test-api-key");
    expect(response.status).toBe(200);
    expect(response.body.requests).toEqual([
      expect.objectContaining({
        id: "request-console",
        taskClass: "debugging",
        fallbackCount: 1,
        errorType: "timeout",
      }),
    ]);
    expect(
      (
        await request(gateway)
          .get("/vartma/v1/requests?failures_only=maybe")
          .set("x-api-key", "test-api-key")
      ).status,
    ).toBe(400);
  });

  it("lists persisted evaluation runs for the operator console", async () => {
    const evaluationStore: EvaluationStore = {
      persist: () => Promise.reject(new Error("not used")),
      list: (limit) => {
        expect(limit).toBe(10);
        return Promise.resolve([
          {
            id: "eval-run-1",
            dataset: "coding-public",
            datasetVersion: "1.0.0",
            harnessVersion: "graph-v1",
            target: "router:balanced",
            tasks: 20,
            solved: 18,
            passRate: 0.9,
            attempts: 24,
            actualCostUsd: "1.25",
            p50LatencyMs: 1000,
            p95LatencyMs: 4000,
            routingDistribution: { "deepseek/chat": 14, "openai/frontier": 6 },
            startedAt: "2026-08-24T00:00:00.000Z",
            completedAt: "2026-08-24T00:05:00.000Z",
          },
        ]);
      },
    };
    const gateway = createApp({
      config: testConfig(),
      logger: pino({ level: "silent" }),
      evaluationStore,
    });
    const response = await request(gateway)
      .get("/vartma/v1/evaluations?limit=10")
      .set("x-api-key", "test-api-key");
    expect(response.status).toBe(200);
    expect(response.body.runs).toEqual([
      expect.objectContaining({
        id: "eval-run-1",
        target: "router:balanced",
        solved: 18,
        actualCostUsd: "1.25",
      }),
    ]);
  });

  it("accepts Claude Code's unauthenticated connectivity probe", async () => {
    const response = await request(app()).head("/");
    expect(response.status).toBe(200);
  });

  it("reports provider readiness", async () => {
    const response = await request(app()).get("/readyz");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "ready",
      providers: [{ provider: "fake", model: "fake/default", healthy: true }],
    });
  });

  it("generates and preserves request IDs", async () => {
    const generated = await request(app()).get("/healthz");
    expect(generated.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(generated.headers["request-id"]).toBe(generated.headers["x-request-id"]);

    const supplied = await request(app()).get("/healthz").set("x-request-id", "client-request-123");
    expect(supplied.headers["x-request-id"]).toBe("client-request-123");
    expect(supplied.headers["request-id"]).toBe("client-request-123");
  });

  it("exposes Prometheus metrics for completed requests", async () => {
    const gateway = app();
    const routed = await request(gateway)
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .send(baseRequest());
    expect(routed.status).toBe(200);

    const response = await request(gateway).get("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.text).toContain("vartma_requests_total 1");
    expect(response.text).toContain('vartma_responses_total{status="completed"} 1');
    expect(response.text).toContain("vartma_requests_in_flight 0");
  });

  it("requires an API key on provider-compatible endpoints", async () => {
    const response = await request(app()).post("/v1/messages").send(baseRequest());
    expect(response.status).toBe(401);
    expect(response.body.error.type).toBe("authentication_error");
  });

  it("serves Claude Code model discovery and token counting", async () => {
    const gateway = routingApp();
    const models = await request(gateway)
      .get("/v1/models?limit=1000")
      .set("authorization", "Bearer test-api-key");
    expect(models.status).toBe(200);
    expect(models.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "claude-vartma-quality" }),
        expect.objectContaining({ id: "claude-vartma-balanced" }),
        expect.objectContaining({ id: "claude-vartma-eco" }),
      ]),
    );

    const tokens = await request(gateway)
      .post("/v1/messages/count_tokens")
      .set("x-api-key", "test-api-key")
      .send({
        model: "claude-vartma-balanced",
        messages: [{ role: "user", content: "Count this Claude Code request" }],
      });
    expect(tokens.status).toBe(200);
    expect(tokens.body.input_tokens).toBeGreaterThan(0);
  });

  it("returns an Anthropic-compatible non-streaming message", async () => {
    const response = await request(app())
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .send(baseRequest());

    expect(response.status).toBe(200);
    expect(response.headers["x-vartma-provider"]).toBe("fake");
    expect(response.body).toMatchObject({
      type: "message",
      role: "assistant",
      model: "fake-default",
      stop_reason: "end_turn",
    });
    expect(response.body.content[0].text).toContain("hello router");
    expect(response.body.usage.input_tokens).toBeGreaterThan(0);
  });

  it("streams Anthropic-compatible SSE events", async () => {
    const response = await request(app())
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .send(baseRequest(true));

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.text).toContain("event: message_start");
    expect(response.text).toContain("event: content_block_delta");
    expect(response.text).toContain("event: message_stop");

    const expectedEvents = JSON.parse(
      await readFile(resolve("testdata/anthropic-streams/fake-text-event-types.json"), "utf8"),
    ) as string[];
    expect(readSseEventTypes(response.text)).toEqual(expectedEvents);
  });

  it("propagates an HTTP client disconnect to upstream cancellation", async () => {
    const model = routingModel("fake/default", 1, 0, 1);
    const provider = new AbortProbeProvider(model);
    const registry = new ProviderRegistry();
    registry.register(provider);
    const gateway = createApp({
      config: testConfig(),
      runtime: {
        registry,
        models: new Map([[model.id, model]]),
      },
      logger: pino({ level: "silent" }),
    });
    const server = gateway.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Gateway test server did not expose a TCP address.");
      }

      const body = JSON.stringify(baseRequest(true));
      await new Promise<void>((resolveRequest, rejectRequest) => {
        let settled = false;
        const settle = (error?: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (error) {
            rejectRequest(error);
          } else {
            resolveRequest();
          }
        };
        const clientRequest = httpRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            method: "POST",
            path: "/v1/messages",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              "x-api-key": "test-api-key",
            },
          },
          (clientResponse) => {
            clientResponse.once("data", () => {
              clientRequest.destroy();
              settle();
            });
            clientResponse.on("error", () => settle());
          },
        );
        clientRequest.on("error", (error) => {
          if ((error as NodeJS.ErrnoException).code === "ECONNRESET") {
            settle();
            return;
          }
          settle(error);
        });
        clientRequest.end(body);
      });

      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          provider.abortObserved,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Upstream provider did not observe cancellation.")),
              2_000,
            );
          }),
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
      expect(provider.aborted).toBe(true);
    } finally {
      server.closeAllConnections();
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
    }
  });

  it("preserves a streamed tool call", async () => {
    const response = await request(app())
      .post("/v1/messages")
      .set("authorization", "Bearer test-api-key")
      .send({
        model: "fake/default",
        max_tokens: 256,
        stream: true,
        tools: [
          {
            name: "echo",
            description: "Echo a message",
            input_schema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
        ],
        messages: [{ role: "user", content: "Please use the echo tool" }],
      });

    expect(response.status).toBe(200);
    expect(response.text).toContain('"type":"tool_use"');
    expect(response.text).toContain('"type":"input_json_delta"');
    expect(response.text).toContain('"stop_reason":"tool_use"');
  });

  it("returns a compatible validation error", async () => {
    const response = await request(app())
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .send({ model: "fake/default", messages: [] });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
  });

  it("returns a 400 response for malformed JSON", async () => {
    const response = await request(app())
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("content-type", "application/json")
      .send('{"model":');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "The request body is not valid JSON.",
      },
    });
  });

  it("rejects a model without a required capability", async () => {
    const response = await request(app())
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .send({
        model: "fake/default",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "url",
                  url: "https://example.com/image.png",
                },
              },
            ],
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("vision");
  });

  it.each([
    ["quality", "frontier/best"],
    ["balanced", "balanced/standard"],
    ["eco", "cheap/basic"],
  ] as const)("routes %s mode to %s", async (mode, expectedModel) => {
    const response = await request(routingApp())
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-mode", mode)
      .send({
        model: "client/model-hint",
        max_tokens: 256,
        messages: [{ role: "user", content: "Implement a function that adds two numbers" }],
      });

    expect(response.status).toBe(200);
    expect(response.headers["x-vartma-model"]).toBe(expectedModel);
    expect(response.headers["x-vartma-task-class"]).toBe("code_generation");
    expect(response.headers["x-vartma-decision-id"]).toBeTruthy();
  });

  it("accepts current Claude Code beta requests and maps router model aliases", async () => {
    const response = await request(routingApp())
      .post("/v1/messages?beta=true")
      .set("x-api-key", "test-api-key")
      .set("anthropic-version", "2023-06-01")
      .set("anthropic-beta", "future-capability")
      .send({
        model: "claude-vartma-quality",
        max_tokens: 256,
        messages: [{ role: "user", content: "Implement a function that adds two numbers" }],
        thinking: { type: "adaptive" },
        context_management: { edits: [] },
      });

    expect(response.status).toBe(200);
    expect(response.headers["x-vartma-mode"]).toBe("quality");
    expect(response.headers["x-vartma-model"]).toBe("frontier/best");
  });

  it("accepts signed and redacted thinking blocks from a Claude Code tool history", async () => {
    const response = await request(app())
      .post("/v1/messages?beta=true")
      .set("x-api-key", "test-api-key")
      .set("anthropic-version", "2023-06-01")
      .send({
        model: "fake/default",
        max_tokens: 256,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "thinking",
                thinking: "private prior reasoning",
                signature: "signed-prior-reasoning",
              },
              { type: "redacted_thinking", data: "redacted-value" },
              {
                type: "tool_use",
                id: "tool-1",
                name: "read_file",
                input: { path: "src/index.ts" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: "export const value = 1;",
              },
            ],
          },
        ],
      });

    expect(response.status).toBe(200);
  });

  it("requires a reasoning-capable model when Claude Code requests thinking", async () => {
    const response = await request(app())
      .post("/v1/messages?beta=true")
      .set("x-api-key", "test-api-key")
      .send({
        model: "fake/default",
        max_tokens: 256,
        messages: [{ role: "user", content: "Analyze this carefully" }],
        thinking: { type: "adaptive" },
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("reasoning");
  });

  it("keeps Fixed mode exact and supports an explicit forced-model header", async () => {
    const fixed = await request(routingApp())
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-mode", "fixed")
      .send({
        model: "cheap/basic",
        max_tokens: 256,
        messages: [{ role: "user", content: "Implement a complex feature" }],
      });
    expect(fixed.status).toBe(200);
    expect(fixed.headers["x-vartma-model"]).toBe("cheap/basic");

    const forced = await request(routingApp())
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-model", "balanced/standard")
      .send({
        model: "client/model-hint",
        max_tokens: 256,
        messages: [{ role: "user", content: "Explain this variable" }],
      });
    expect(forced.status).toBe(200);
    expect(forced.headers["x-vartma-model"]).toBe("balanced/standard");
  });

  it("rejects invalid routing constraint headers", async () => {
    const response = await request(routingApp())
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-max-cost-usd", "not-a-number")
      .send(baseRequest());

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain("x-vartma-max-cost-usd");
  });

  it("keeps an eligible model sticky across turns in the same session", async () => {
    const gateway = routingApp();
    const first = await request(gateway)
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-session-id", "sticky-session")
      .set("x-vartma-model", "cheap/basic")
      .send({
        model: "client/model-hint",
        max_tokens: 256,
        messages: [{ role: "user", content: "Implement a function that adds two numbers" }],
      });
    expect(first.status).toBe(200);
    expect(first.headers["x-vartma-model"]).toBe("cheap/basic");

    const second = await request(gateway)
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-session-id", "sticky-session")
      .send({
        model: "client/model-hint",
        max_tokens: 256,
        messages: [{ role: "user", content: "Implement a function that subtracts two numbers" }],
      });
    expect(second.status).toBe(200);
    expect(second.headers["x-vartma-model"]).toBe("cheap/basic");

    const state = await request(gateway)
      .get("/internal/v1/sessions/sticky-session")
      .set("x-api-key", "test-api-key");
    expect(state.status).toBe(200);
    expect(state.body.session).toMatchObject({
      currentModel: "cheap/basic",
      turnCount: 2,
      lastTaskClass: "code_generation",
    });
  });

  it("accepts authenticated outcomes and escalates the next session turn", async () => {
    const gateway = routingApp();
    await request(gateway)
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-session-id", "escalation-session")
      .set("x-vartma-model", "cheap/basic")
      .send({
        model: "client/model-hint",
        max_tokens: 256,
        messages: [{ role: "user", content: "Implement a function that adds two numbers" }],
      });

    const unauthorized = await request(gateway)
      .post("/internal/v1/sessions/escalation-session/outcomes")
      .send({ kind: "test_failure" });
    expect(unauthorized.status).toBe(401);

    const firstOutcome = await request(gateway)
      .post("/internal/v1/sessions/escalation-session/outcomes")
      .set("x-api-key", "test-api-key")
      .send({ kind: "test_failure", source: "test-runner" });
    expect(firstOutcome.status).toBe(202);
    expect(firstOutcome.body.escalated).toBe(false);

    const secondOutcome = await request(gateway)
      .post("/internal/v1/sessions/escalation-session/outcomes")
      .set("x-api-key", "test-api-key")
      .send({ kind: "test_failure", source: "test-runner" });
    expect(secondOutcome.status).toBe(202);
    expect(secondOutcome.body).toMatchObject({
      escalation_level: 1,
      escalated: true,
    });

    const nextTurn = await request(gateway)
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-session-id", "escalation-session")
      .send({
        model: "client/model-hint",
        max_tokens: 256,
        messages: [{ role: "user", content: "Implement a function that adds two numbers" }],
      });
    expect(nextTurn.status).toBe(200);
    expect(nextTurn.headers["x-vartma-model"]).toBe("balanced/standard");
  });

  it("detects an unchanged failing tool loop and automatically escalates only once", async () => {
    const gateway = routingApp();
    const sessionId = "automatic-stuck-session";
    await request(gateway)
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-session-id", sessionId)
      .set("x-vartma-model", "cheap/basic")
      .send({
        model: "client/model-hint",
        max_tokens: 256,
        messages: [{ role: "user", content: "Implement the authentication fix" }],
      });

    const stuckMessages = [
      {
        role: "user",
        content: "Implement the authentication fix",
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "run_tests", input: { suite: "auth" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "FAIL auth.test.ts expected 200 received 500",
            is_error: true,
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-2", name: "run_tests", input: { suite: "auth" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-2",
            content: "FAIL auth.test.ts expected 200 received 500",
            is_error: true,
          },
        ],
      },
    ];
    const sendStuckTurn = () =>
      request(gateway)
        .post("/v1/messages")
        .set("x-api-key", "test-api-key")
        .set("x-vartma-session-id", sessionId)
        .send({ model: "client/model-hint", max_tokens: 256, messages: stuckMessages });

    const escalated = await sendStuckTurn();
    expect(escalated.status).toBe(200);
    expect(escalated.headers["x-vartma-model"]).toBe("frontier/best");
    expect(escalated.headers["x-vartma-escalation-level"]).toBe("1");

    const duplicate = await sendStuckTurn();
    expect(duplicate.status).toBe(200);
    expect(duplicate.headers["x-vartma-escalation-level"]).toBe("1");

    const state = await request(gateway)
      .get(`/internal/v1/sessions/${sessionId}`)
      .set("x-api-key", "test-api-key");
    expect(state.body.session).toMatchObject({
      escalationLevel: 1,
      automaticEscalationLevel: 1,
    });
    expect(JSON.stringify(state.body.session)).not.toContain("auth.test.ts");
  });

  it("uses Claude Code's native session header through a long tool loop", async () => {
    const gateway = routingApp();
    const sessionId = "claude-native-session";
    for (let turn = 0; turn < 20; turn += 1) {
      const messages =
        turn === 0
          ? [{ role: "user" as const, content: "Implement a function with a tool" }]
          : [
              {
                role: "assistant" as const,
                content: [
                  {
                    type: "tool_use" as const,
                    id: `tool-${turn}`,
                    name: "read_file",
                    input: { path: "src/index.ts" },
                  },
                ],
              },
              {
                role: "user" as const,
                content: [
                  {
                    type: "tool_result" as const,
                    tool_use_id: `tool-${turn}`,
                    content: "export const value = 1;",
                  },
                ],
              },
            ];
      const response = await request(gateway)
        .post("/v1/messages?beta=true")
        .set("authorization", "Bearer test-api-key")
        .set("anthropic-version", "2023-06-01")
        .set("x-claude-code-session-id", sessionId)
        .set("x-claude-code-agent-id", "main-agent")
        .send({
          model: "claude-vartma-balanced",
          max_tokens: 128,
          messages,
          tools: [
            {
              name: "read_file",
              input_schema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
              strict: true,
            },
          ],
        });
      expect(response.status).toBe(200);
    }

    const state = await request(gateway)
      .get(`/internal/v1/sessions/${sessionId}`)
      .set("x-api-key", "test-api-key");
    expect(state.status).toBe(200);
    expect(state.body.session.turnCount).toBe(20);
  });

  it("owns tool-call history and joins a delta-only tool result to the next turn", async () => {
    const history = new InMemoryCanonicalHistoryStore();
    const gateway = createApp({
      config: testConfig(),
      runtime: routingRuntime(),
      canonicalHistoryStore: history,
      logger: pino({ level: "silent" }),
    });
    const sessionId = "owned-tool-history";
    const first = await request(gateway)
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-session-id", sessionId)
      .send({
        model: "client/model-hint",
        max_tokens: 128,
        messages: [{ role: "user", content: "Use a tool to inspect the file" }],
        tools: [
          {
            name: "read_file",
            input_schema: { type: "object", properties: {} },
          },
        ],
      });
    expect(first.status).toBe(200);
    const toolCallId = first.body.content[0].id as string;
    expect(await history.get(sessionId)).toEqual([
      { role: "user", content: [{ type: "text", text: "Use a tool to inspect the file" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: toolCallId,
            name: "read_file",
            arguments: { message: "hello from the fake provider" },
          },
        ],
      },
    ]);

    const second = await request(gateway)
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-session-id", sessionId)
      .send({
        model: "client/model-hint",
        max_tokens: 128,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolCallId,
                content: "export const value = 1;",
              },
            ],
          },
        ],
      });
    expect(second.status).toBe(200);
    const transcript = await history.get(sessionId);
    expect(transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [expect.objectContaining({ type: "tool_call", id: toolCallId })],
        }),
        expect.objectContaining({
          role: "user",
          content: [expect.objectContaining({ type: "tool_result", toolCallId })],
        }),
      ]),
    );
  });

  it("returns a compatible response from a fallback model after provider outage", async () => {
    const gateway = createApp({
      config: testConfig(),
      runtime: fallbackRuntime(),
      logger: pino({ level: "silent" }),
    });
    const response = await request(gateway)
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-mode", "quality")
      .send({
        model: "client/model-hint",
        max_tokens: 256,
        messages: [{ role: "user", content: "Implement a function that adds two numbers" }],
      });

    expect(response.status).toBe(200);
    expect(response.headers["x-vartma-model"]).toBe("healthy/backup");
    expect(response.headers["x-vartma-fallback-count"]).toBe("1");
    expect(response.body.content[0].text).toContain("adds two numbers");
  });

  it("opens the failed model circuit and routes later requests around it", async () => {
    const gateway = createApp({
      config: testConfig(),
      runtime: fallbackRuntime(),
      logger: pino({ level: "silent" }),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await request(gateway)
        .post("/v1/messages")
        .set("x-api-key", "test-api-key")
        .set("x-vartma-mode", "quality")
        .send({
          model: "client/model-hint",
          max_tokens: 256,
          messages: [{ role: "user", content: "Implement a function" }],
        });
      expect(response.status).toBe(200);
      expect(response.headers["x-vartma-fallback-count"]).toBe("1");
    }

    const afterCircuitOpened = await request(gateway)
      .post("/v1/messages")
      .set("x-api-key", "test-api-key")
      .set("x-vartma-mode", "quality")
      .send({
        model: "client/model-hint",
        max_tokens: 256,
        messages: [{ role: "user", content: "Implement another function" }],
      });

    expect(afterCircuitOpened.status).toBe(200);
    expect(afterCircuitOpened.headers["x-vartma-model"]).toBe("healthy/backup");
    expect(afterCircuitOpened.headers["x-vartma-fallback-count"]).toBe("0");
  });
});

function routingRuntime(): Runtime {
  const models = [
    routingModel("cheap/basic", 1, 0.1, 1),
    routingModel("balanced/standard", 3, 5, 2),
    routingModel("frontier/best", 5, 50, 4),
  ];
  const registry = new ProviderRegistry();
  for (const model of models) {
    registry.register(
      new FakeProvider({
        name: model.provider,
        model: model.upstreamModel,
      }),
    );
  }
  return {
    registry,
    models: new Map(models.map((model) => [model.id, model])),
  };
}

function fallbackRuntime(): Runtime {
  const primary = routingModel("outage/frontier", 5, 1, 1);
  const backup = routingModel("healthy/backup", 4, 2, 2);
  const registry = new ProviderRegistry();
  registry.register(new OutageProvider(primary));
  registry.register(
    new FakeProvider({
      name: backup.provider,
      model: backup.upstreamModel,
    }),
  );
  return {
    registry,
    models: new Map([
      [primary.id, primary],
      [backup.id, backup],
    ]),
  };
}

class OutageProvider implements ProviderAdapter {
  public readonly name: string;

  public constructor(private readonly model: ModelDefinition) {
    this.name = model.provider;
  }

  public models(): Promise<ModelDefinition[]> {
    return Promise.resolve([this.model]);
  }

  public capabilities(): CapabilitySet {
    return this.model.capabilities;
  }

  public estimateTokens(_request: CanonicalRequest): Promise<TokenEstimate> {
    void _request;
    return Promise.resolve({ inputTokens: 100, expectedOutputTokens: 100 });
  }

  public execute(): AsyncIterable<CanonicalEvent> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<CanonicalEvent> {
        return {
          next: () =>
            Promise.reject(new ProviderError("Provider is unavailable.", "upstream", true)),
        };
      },
    };
  }

  public health(): Promise<HealthStatus> {
    return Promise.resolve({
      healthy: true,
      observedAt: "2026-07-28T00:00:00.000Z",
    });
  }
}

class AbortProbeProvider implements ProviderAdapter {
  public readonly name: string;
  public readonly abortObserved: Promise<void>;
  public aborted = false;
  private resolveAbort!: () => void;

  public constructor(private readonly model: ModelDefinition) {
    this.name = model.provider;
    this.abortObserved = new Promise((resolveAbort) => {
      this.resolveAbort = resolveAbort;
    });
  }

  public models(): Promise<ModelDefinition[]> {
    return Promise.resolve([this.model]);
  }

  public capabilities(): CapabilitySet {
    return this.model.capabilities;
  }

  public estimateTokens(_request: CanonicalRequest): Promise<TokenEstimate> {
    void _request;
    return Promise.resolve({ inputTokens: 1, expectedOutputTokens: 1 });
  }

  public async *execute(
    upstreamModel: string,
    _request: CanonicalRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CanonicalEvent> {
    void _request;
    yield {
      type: "response.started",
      responseId: "abort_probe",
      provider: this.name,
      model: upstreamModel,
      inputTokens: 1,
    };
    yield { type: "content.started", index: 0, contentType: "text" };
    yield { type: "text.delta", index: 0, text: "working" };

    if (!signal) {
      throw new Error("Gateway did not supply a cancellation signal.");
    }
    await new Promise<never>((_resolve, reject) => {
      const onAbort = () => {
        this.aborted = true;
        this.resolveAbort();
        reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted."));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  public health(): Promise<HealthStatus> {
    return Promise.resolve({
      healthy: true,
      observedAt: "2026-07-30T00:00:00.000Z",
    });
  }
}

function routingModel(
  id: string,
  qualityTier: number,
  inputPerMillion: number,
  expectedLatencyTier: number,
): ModelDefinition {
  return {
    id,
    provider: id.split("/")[0]!,
    upstreamModel: `${id}-upstream`,
    enabled: true,
    capabilities: {
      text: true,
      vision: false,
      streaming: true,
      tools: true,
      structuredOutput: true,
      reasoning: qualityTier >= 5,
    },
    contextWindow: 100_000,
    maxOutputTokens: 4096,
    qualityTier,
    expectedLatencyTier,
    pricing: {
      currency: "USD",
      effectiveFrom: "2026-07-23",
      verifiedAt: "2026-07-23",
      source: "gateway routing test fixture",
      inputPerMillion,
      cachedInputPerMillion: inputPerMillion / 10,
      outputPerMillion: inputPerMillion * 4,
    },
  };
}

function readSseEventTypes(stream: string): string[] {
  return stream
    .split(/\r?\n/)
    .filter((line) => line.startsWith("event: "))
    .map((line) => line.slice("event: ".length));
}
