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
  type RoutingDecision,
  type RoutingEngine,
  type SessionCoordinator,
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
}

export async function executeCanonical(options: ExecuteCanonicalOptions): Promise<RoutedExecution> {
  const sessionState =
    options.sessionId && options.config.routing.session.enabled
      ? await options.sessionCoordinator.get(options.sessionId, options.routingMode)
      : undefined;
  if (sessionState) {
    options.request.metadata["turn_count"] = String(sessionState.turnCount);
    options.request.metadata["previous_test_failures"] = String(sessionState.consecutiveFailures);
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
  const decision = await options.routingEngine.route(options.request, options.signal, {
    ...(sessionState ? { session: sessionState } : {}),
    blockedModels,
  });
  const prepared = await prepareFallbackExecution({
    decision,
    request: options.request,
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
    events:
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
