import type {
  CanonicalEvent,
  CanonicalRequest,
  ModelDefinition,
  RoutingMode,
} from "@vartma/canonical";
import type { RouterConfig } from "@vartma/config";
import type { AttemptStore } from "@vartma/database";
import {
  type CircuitBreakerRegistry,
  type CanonicalHistoryCoordinator,
  type RoutingDecision,
  type RoutingEngine,
  type SessionCoordinator,
  analyzeProgress,
  compressCanonicalContext,
  type ContextCompressionReport,
} from "@vartma/routing";

import { prepareFallbackExecution, providerCircuitKey } from "./fallback.js";
import type { GatewayMetrics } from "./metrics.js";
import type { Runtime } from "./runtime.js";

export interface ExecuteCanonicalOptions {
  request: CanonicalRequest;
  requestId: string;
  routingMode: RoutingMode;
  sessionId?: string;
  runtime: Runtime;
  routingEngine: RoutingEngine;
  sessionCoordinator: SessionCoordinator;
  canonicalHistory: CanonicalHistoryCoordinator;
  circuits: CircuitBreakerRegistry;
  config: RouterConfig;
  metrics: GatewayMetrics;
  attemptStore?: AttemptStore;
  signal: AbortSignal;
}

export interface RoutedExecution {
  events: AsyncIterable<CanonicalEvent>;
  model: ModelDefinition;
  decision: RoutingDecision;
  fallbackCount: number;
  escalationLevel: number;
  terminalState: { completed: boolean; failed: boolean };
  contextCompression: ContextCompressionReport;
}

export async function executeCanonical(options: ExecuteCanonicalOptions): Promise<RoutedExecution> {
  const canonicalRequest = options.sessionId
    ? await options.canonicalHistory.prepareRequest(options.request)
    : options.request;
  const progress = analyzeProgress(canonicalRequest);
  const context = compressCanonicalContext(canonicalRequest, options.config.routing.context);
  const routedRequest = context.request;
  const sessionState =
    options.sessionId && options.config.routing.session.enabled
      ? (
          await options.sessionCoordinator.observeProgress(
            options.sessionId,
            options.routingMode,
            progress,
            options.requestId,
          )
        ).state
      : undefined;
  if (sessionState) {
    canonicalRequest.metadata["turn_count"] = String(sessionState.turnCount);
    canonicalRequest.metadata["previous_test_failures"] = String(sessionState.consecutiveFailures);
  }

  const blockedCircuitKeys = options.circuits.blockedKeys();
  const blockedModels = new Set(
    [...options.runtime.models.values()]
      .filter(
        (model) =>
          blockedCircuitKeys.has(model.id) ||
          blockedCircuitKeys.has(providerCircuitKey(model.provider)),
      )
      .map((model) => model.id),
  );
  const decision = await options.routingEngine.route(routedRequest, options.signal, {
    ...(sessionState ? { session: sessionState } : {}),
    blockedModels,
  });
  const prepared = await prepareFallbackExecution({
    decision,
    request: routedRequest,
    providers: options.runtime.registry,
    policy: options.config.routing.fallback,
    circuits: options.circuits,
    priceBookVersion: options.config.routing.priceBookVersion,
    clientRequestId: options.requestId,
    ...(options.attemptStore ? { attemptStore: options.attemptStore } : {}),
    signal: options.signal,
  });
  options.metrics.fallbackUsed(prepared.fallbackCount);

  const terminalState = { completed: false, failed: false };
  return {
    model: prepared.model,
    decision,
    fallbackCount: prepared.fallbackCount,
    escalationLevel: sessionState?.escalationLevel ?? 0,
    terminalState,
    contextCompression: context.report,
    events: recordCanonicalAssistant(
      options.sessionId && options.config.routing.session.enabled
        ? recordCompletedSessionTurn(
            prepared.events,
            options.sessionCoordinator,
            options.sessionId,
            options.routingMode,
            decision,
            prepared.model,
            terminalState,
          )
        : observeTerminalState(prepared.events, terminalState),
      options.canonicalHistory,
      options.sessionId,
      canonicalRequest.messages,
    ),
  };
}

export function setRoutingResponseHeaders(
  setHeader: (name: string, value: string | number) => void,
  execution: RoutedExecution,
  routingMode: RoutingMode,
): void {
  setHeader("x-vartma-provider", execution.model.provider);
  setHeader("x-vartma-model", execution.model.id);
  setHeader("x-vartma-mode", routingMode);
  setHeader("x-vartma-task-class", execution.decision.task.taskClass);
  setHeader("x-vartma-decision-id", execution.decision.decisionId);
  setHeader("x-vartma-fallback-count", execution.fallbackCount);
  setHeader("x-vartma-escalation-level", execution.escalationLevel);
  setHeader("x-vartma-context-compressed", execution.contextCompression.applied ? "true" : "false");
  if (execution.contextCompression.applied) {
    setHeader("x-vartma-context-omitted-messages", execution.contextCompression.omittedMessages);
  }
}

async function* recordCompletedSessionTurn(
  events: AsyncIterable<CanonicalEvent>,
  coordinator: SessionCoordinator,
  sessionId: string,
  routingMode: RoutingMode,
  decision: RoutingDecision,
  model: ModelDefinition,
  terminalState: { completed: boolean; failed: boolean },
): AsyncIterable<CanonicalEvent> {
  for await (const event of events) {
    if (event.type === "response.completed") {
      terminalState.completed = true;
      await coordinator.recordTurn(sessionId, routingMode, decision, model);
    } else if (event.type === "response.failed") {
      terminalState.failed = true;
    }
    yield event;
  }
}

async function* observeTerminalState(
  events: AsyncIterable<CanonicalEvent>,
  terminalState: { completed: boolean; failed: boolean },
): AsyncIterable<CanonicalEvent> {
  for await (const event of events) {
    if (event.type === "response.completed") {
      terminalState.completed = true;
    } else if (event.type === "response.failed") {
      terminalState.failed = true;
    }
    yield event;
  }
}

async function* recordCanonicalAssistant(
  events: AsyncIterable<CanonicalEvent>,
  coordinator: CanonicalHistoryCoordinator,
  sessionId: string | undefined,
  requestMessages: CanonicalRequest["messages"],
): AsyncIterable<CanonicalEvent> {
  if (!sessionId) {
    yield* events;
    return;
  }
  const content = new Map<number, CanonicalRequest["messages"][number]["content"][number]>();
  const toolArguments = new Map<number, string>();
  for await (const event of events) {
    switch (event.type) {
      case "content.started":
        content.set(
          event.index,
          event.contentType === "text"
            ? { type: "text", text: "" }
            : { type: "reasoning", text: "" },
        );
        break;
      case "text.delta": {
        const current = content.get(event.index);
        content.set(event.index, {
          type: "text",
          text: `${current?.type === "text" ? current.text : ""}${event.text}`,
        });
        break;
      }
      case "reasoning.delta": {
        const current = content.get(event.index);
        content.set(event.index, {
          type: "reasoning",
          text: `${current?.type === "reasoning" ? current.text : ""}${event.text}`,
          ...(current?.type === "reasoning" && current.providerOpaqueData
            ? { providerOpaqueData: current.providerOpaqueData }
            : {}),
        });
        break;
      }
      case "reasoning.signature.delta": {
        const current = content.get(event.index);
        content.set(event.index, {
          type: "reasoning",
          text: current?.type === "reasoning" ? current.text : "",
          providerOpaqueData: `${current?.type === "reasoning" && current.providerOpaqueData ? current.providerOpaqueData : ""}${event.signature}`,
        });
        break;
      }
      case "tool_call.started":
        content.set(event.index, {
          type: "tool_call",
          id: event.toolCallId,
          name: event.name,
          arguments: {},
        });
        toolArguments.set(event.index, "");
        break;
      case "tool_call.arguments.delta":
        toolArguments.set(
          event.index,
          `${toolArguments.get(event.index) ?? ""}${event.partialJson}`,
        );
        break;
      case "tool_call.completed": {
        const current = content.get(event.index);
        if (current?.type === "tool_call") {
          const rawArguments = toolArguments.get(event.index) ?? "";
          content.set(event.index, {
            ...current,
            arguments: parseToolArguments(rawArguments),
          });
        }
        break;
      }
      case "response.completed": {
        const assistantContent = [...content.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, item]) => item)
          .filter(
            (item) => (item.type !== "text" && item.type !== "reasoning") || item.text.length > 0,
          );
        if (assistantContent.length > 0) {
          await coordinator.recordAssistant(sessionId, requestMessages, {
            role: "assistant",
            content: assistantContent,
          });
        }
        break;
      }
    }
    yield event;
  }
}

function parseToolArguments(value: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { _vartma_unparsed_json: value };
  }
}
