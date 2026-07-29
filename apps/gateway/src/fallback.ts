import type { CanonicalEvent, CanonicalRequest, ModelDefinition } from "@vartma/canonical";
import type { AttemptStore } from "@vartma/database";
import { ProviderError, type ProviderRegistry } from "@vartma/providers";
import type {
  CircuitBreakerRegistry,
  FallbackPolicy,
  RoutingCandidate,
  RoutingDecision,
} from "@vartma/routing";

import { recordProviderAttempt } from "./attempt-recording.js";

export interface PrepareFallbackOptions {
  decision: RoutingDecision;
  request: CanonicalRequest;
  providers: ProviderRegistry;
  policy: FallbackPolicy;
  circuits: CircuitBreakerRegistry;
  priceBookVersion: string;
  clientRequestId?: string;
  attemptStore?: AttemptStore;
  signal?: AbortSignal;
}

export interface PreparedExecution {
  model: ModelDefinition;
  events: AsyncIterable<CanonicalEvent>;
  fallbackCount: number;
}

interface FailedAttempt {
  retryable: boolean;
  reason: string;
  trigger: string;
  error?: Error;
}

export async function prepareFallbackExecution(
  options: PrepareFallbackOptions,
): Promise<PreparedExecution> {
  const candidates = fallbackCandidates(options.decision, options.request, options.policy);
  const startedAt = Date.now();
  let previousModel: ModelDefinition | undefined;
  let previousFailure: FailedAttempt | undefined;

  for (let index = 0; index < candidates.length; index += 1) {
    options.signal?.throwIfAborted();
    if (Date.now() - startedAt >= options.policy.maxTotalDurationMs) {
      break;
    }
    const model = candidates[index]!;
    if (!canRequestModel(options.circuits, model)) {
      const failure: FailedAttempt = {
        retryable: true,
        reason: `Circuit breaker for "${model.id}" is open.`,
        trigger: "circuit_open",
      };
      if (index === 0) {
        throw new ProviderError(failure.reason, "overloaded", true);
      }
      previousModel = model;
      previousFailure = failure;
      continue;
    }
    let attemptId: string | undefined;
    if (index > 0 && options.attemptStore && previousModel && previousFailure) {
      const started = await options.attemptStore.startFallback({
        requestId: options.request.requestId,
        fromProvider: previousModel.provider,
        fromModel: previousModel.id,
        selectedProvider: model.provider,
        selectedModel: model.id,
        upstreamModel: model.upstreamModel,
        reason: previousFailure.reason,
        trigger: previousFailure.trigger,
      });
      attemptId = started.attemptId;
    }

    const remainingMs = Math.max(1, options.policy.maxTotalDurationMs - (Date.now() - startedAt));
    const deadlineSignal = AbortSignal.timeout(remainingMs);
    const attemptSignal = options.signal
      ? AbortSignal.any([options.signal, deadlineSignal])
      : deadlineSignal;
    const source = options.providers
      .get(model.provider)
      .execute(model.upstreamModel, options.request, attemptSignal);
    const recorded = options.attemptStore
      ? recordProviderAttempt(source, {
          store: options.attemptStore,
          request: options.request,
          model,
          ...(options.clientRequestId ? { clientRequestId: options.clientRequestId } : {}),
          priceBookVersion: options.priceBookVersion,
          ...(index === 0 ? { routingDecision: options.decision } : {}),
          ...(attemptId ? { attemptId } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })
      : source;

    const prepared = await prepareAttempt(
      recorded,
      model,
      options.circuits,
      deadlineSignal,
      options.signal,
    );
    if ("events" in prepared) {
      return {
        model,
        events: prepared.events,
        fallbackCount: index,
      };
    }

    previousModel = model;
    previousFailure = prepared.failure;
    const canFallback =
      options.policy.enabled &&
      prepared.failure.retryable &&
      index + 1 < candidates.length &&
      Date.now() - startedAt < options.policy.maxTotalDurationMs &&
      !options.signal?.aborted;
    if (!canFallback) {
      if (prepared.failure.error) {
        throw prepared.failure.error;
      }
      return {
        model,
        events: replay(prepared.buffer),
        fallbackCount: index,
      };
    }
  }

  if (previousFailure?.error) {
    throw previousFailure.error;
  }
  throw new ProviderError(
    previousFailure?.reason ?? "Fallback retry budget was exhausted.",
    "upstream",
    false,
  );
}

async function prepareAttempt(
  source: AsyncIterable<CanonicalEvent>,
  model: ModelDefinition,
  circuits: CircuitBreakerRegistry,
  deadlineSignal: AbortSignal,
  clientSignal?: AbortSignal,
): Promise<
  { events: AsyncIterable<CanonicalEvent> } | { failure: FailedAttempt; buffer: CanonicalEvent[] }
> {
  const iterator = source[Symbol.asyncIterator]();
  const buffer: CanonicalEvent[] = [];
  try {
    while (true) {
      const item = await iterator.next();
      if (item.done) {
        const failure: FailedAttempt = {
          retryable: true,
          reason: "Provider stream ended before a terminal event.",
          trigger: "incomplete_stream",
        };
        recordModelFailure(circuits, model);
        return { failure, buffer };
      }
      const event = item.value;
      buffer.push(event);
      if (event.type === "response.failed") {
        await iterator.return?.();
        if (event.retryable) {
          recordModelFailure(circuits, model);
        }
        return {
          failure: {
            retryable: event.retryable,
            reason: event.message,
            trigger: event.errorType,
          },
          buffer,
        };
      }
      if (event.type === "response.completed") {
        recordModelSuccess(circuits, model);
        return { events: replay(buffer) };
      }
      if (isMeaningfulOutput(event)) {
        return {
          events: continueAttempt(buffer, iterator, model, circuits),
        };
      }
    }
  } catch (error) {
    const failure =
      deadlineSignal.aborted && !clientSignal?.aborted
        ? classifyFailure(
            new ProviderError(
              "The fallback retry budget expired during provider execution.",
              "timeout",
              true,
              { cause: error },
            ),
          )
        : classifyFailure(error);
    if (failure.retryable) {
      recordModelFailure(circuits, model);
    }
    return { failure, buffer };
  }
}

async function* continueAttempt(
  buffer: CanonicalEvent[],
  iterator: AsyncIterator<CanonicalEvent>,
  model: ModelDefinition,
  circuits: CircuitBreakerRegistry,
): AsyncIterable<CanonicalEvent> {
  yield* replay(buffer);
  try {
    while (true) {
      const item = await iterator.next();
      if (item.done) {
        throw new ProviderError("Provider stream ended before a terminal event.", "upstream", true);
      }
      const terminal =
        item.value.type === "response.completed" || item.value.type === "response.failed";
      if (item.value.type === "response.completed") {
        recordModelSuccess(circuits, model);
      } else if (item.value.type === "response.failed" && item.value.retryable) {
        recordModelFailure(circuits, model);
      }
      yield item.value;
      if (terminal) {
        return;
      }
    }
  } catch (error) {
    const failure = classifyFailure(error);
    if (failure.retryable) {
      recordModelFailure(circuits, model);
    }
    throw failure.error ?? new Error(failure.reason);
  }
}

async function* replay(events: CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  await Promise.resolve();
  for (const event of events) {
    yield event;
  }
}

export function providerCircuitKey(provider: string): string {
  return `provider:${provider}`;
}

function canRequestModel(circuits: CircuitBreakerRegistry, model: ModelDefinition): boolean {
  const providerKey = providerCircuitKey(model.provider);
  if (!circuits.canRequest(providerKey)) {
    return false;
  }
  if (!circuits.canRequest(model.id)) {
    circuits.releaseProbe(providerKey);
    return false;
  }
  return true;
}

function recordModelSuccess(circuits: CircuitBreakerRegistry, model: ModelDefinition): void {
  circuits.recordSuccess(model.id);
  circuits.recordSuccess(providerCircuitKey(model.provider));
}

function recordModelFailure(circuits: CircuitBreakerRegistry, model: ModelDefinition): void {
  circuits.recordFailure(model.id);
  circuits.recordFailure(providerCircuitKey(model.provider));
}

function isMeaningfulOutput(event: CanonicalEvent): boolean {
  return (
    event.type === "text.delta" ||
    event.type === "reasoning.delta" ||
    event.type === "reasoning.signature.delta" ||
    event.type === "tool_call.started" ||
    event.type === "tool_call.arguments.delta" ||
    event.type === "tool_call.completed"
  );
}

function classifyFailure(error: unknown): FailedAttempt {
  if (error instanceof ProviderError) {
    return {
      retryable: error.retryable,
      reason: error.message,
      trigger: error.code,
      error,
    };
  }
  const normalizedError = error instanceof Error ? error : new Error("Unknown provider failure.");
  return {
    retryable: false,
    reason: normalizedError.message,
    trigger: "internal_error",
    error: normalizedError,
  };
}

function fallbackCandidates(
  decision: RoutingDecision,
  request: CanonicalRequest,
  policy: FallbackPolicy,
): ModelDefinition[] {
  const selected = decision.selectedModel;
  if (!policy.enabled || decision.mode === "fixed" || request.constraints.forcedModel) {
    return [selected];
  }
  const eligible = decision.candidates.filter(
    (
      candidate,
    ): candidate is RoutingCandidate & {
      score: NonNullable<RoutingCandidate["score"]>;
    } => candidate.eligible && candidate.score !== undefined && candidate.model.id !== selected.id,
  );
  const stronger = eligible.filter(
    (candidate) => candidate.model.qualityTier >= selected.qualityTier,
  );
  const weaker = policy.allowWeakerFallback
    ? eligible.filter((candidate) => candidate.model.qualityTier < selected.qualityTier)
    : [];
  const rank = (
    left: RoutingCandidate & { score: NonNullable<RoutingCandidate["score"]> },
    right: RoutingCandidate & { score: NonNullable<RoutingCandidate["score"]> },
  ) => {
    const leftDifferentProvider = left.model.provider === selected.provider ? 0 : 1;
    const rightDifferentProvider = right.model.provider === selected.provider ? 0 : 1;
    if (leftDifferentProvider !== rightDifferentProvider) {
      return rightDifferentProvider - leftDifferentProvider;
    }
    const scoreDifference = right.score.total - left.score.total;
    return Math.abs(scoreDifference) > 1e-12
      ? scoreDifference
      : left.model.id.localeCompare(right.model.id);
  };
  return [
    selected,
    ...stronger.sort(rank).map((candidate) => candidate.model),
    ...weaker.sort(rank).map((candidate) => candidate.model),
  ].slice(0, policy.maxAttempts);
}
