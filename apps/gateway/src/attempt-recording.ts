import type {
  CanonicalEvent,
  CanonicalRequest,
  ModelDefinition,
  TokenUsage,
} from "@vartma/canonical";
import type { AttemptStore } from "@vartma/database";
import { ProviderError } from "@vartma/providers";
import type { RoutingDecision } from "@vartma/routing";

export interface RecordAttemptOptions {
  store: AttemptStore;
  request: CanonicalRequest;
  model: ModelDefinition;
  clientRequestId?: string;
  priceBookVersion: string;
  routingDecision?: RoutingDecision;
  attemptId?: string;
  signal?: AbortSignal;
}

export async function* recordProviderAttempt(
  source: AsyncIterable<CanonicalEvent>,
  options: RecordAttemptOptions,
): AsyncIterable<CanonicalEvent> {
  const started = options.attemptId
    ? { attemptId: options.attemptId }
    : await options.store.start({
        requestId: options.request.requestId,
        ...(options.request.sessionId ? { sessionId: options.request.sessionId } : {}),
        ...(options.clientRequestId ? { clientRequestId: options.clientRequestId } : {}),
        ...(options.request.requestedModel
          ? { requestedModel: options.request.requestedModel }
          : {}),
        selectedProvider: options.model.provider,
        selectedModel: options.model.id,
        upstreamModel: options.model.upstreamModel,
        routingMode: options.request.routingMode,
        metadata: options.request.metadata,
        ...(options.routingDecision?.session?.previousModel &&
        options.routingDecision.session.previousProvider &&
        options.routingDecision.session.previousModel !== options.model.id
          ? {
              initialSwitch: {
                fromProvider: options.routingDecision.session.previousProvider,
                fromModel: options.routingDecision.session.previousModel,
                toProvider: options.model.provider,
                toModel: options.model.id,
                reason:
                  options.routingDecision.session.switchReason ??
                  "Session routing selected a different eligible model.",
                trigger: "session_policy",
              },
            }
          : {}),
        ...(options.routingDecision
          ? {
              routeDecision: {
                routerVersion: options.routingDecision.routerVersion,
                taskClass: options.routingDecision.task.taskClass,
                selectedProvider: options.routingDecision.selectedModel.provider,
                selectedModel: options.routingDecision.selectedModel.id,
                explanation: {
                  summary: options.routingDecision.explanation.summary,
                  selectedReasons: options.routingDecision.explanation.selectedReasons,
                  rejected: options.routingDecision.explanation.rejected.map((candidate) => ({
                    model: candidate.model,
                    reasons: candidate.reasons,
                  })),
                  ...(options.routingDecision.session
                    ? { session: options.routingDecision.session }
                    : {}),
                },
                candidates: options.routingDecision.candidates.map((candidate) => ({
                  model: candidate.model.id,
                  provider: candidate.model.provider,
                  eligible: candidate.eligible,
                  filterReasons: candidate.filterReasons.map((reason) => ({
                    code: reason.code,
                    message: reason.message,
                  })),
                  ...(candidate.estimatedCostUsd === undefined
                    ? {}
                    : { estimatedCostUsd: candidate.estimatedCostUsd }),
                  ...(candidate.tokenEstimate
                    ? {
                        tokenEstimate: {
                          inputTokens: candidate.tokenEstimate.inputTokens,
                          expectedOutputTokens: candidate.tokenEstimate.expectedOutputTokens,
                        },
                      }
                    : {}),
                  ...(candidate.score
                    ? {
                        score: {
                          expectedSuccess: candidate.score.expectedSuccess,
                          normalizedCost: candidate.score.normalizedCost,
                          normalizedLatency: candidate.score.normalizedLatency,
                          failureRisk: candidate.score.failureRisk,
                          sessionSwitchPenalty: candidate.score.sessionSwitchPenalty,
                          total: candidate.score.total,
                        },
                      }
                    : {}),
                  ...(candidate.health
                    ? {
                        health: {
                          healthy: candidate.health.healthy,
                          observedAt: candidate.health.observedAt,
                          ...(candidate.health.latencyMs === undefined
                            ? {}
                            : { latencyMs: candidate.health.latencyMs }),
                          ...(candidate.health.reason ? { reason: candidate.health.reason } : {}),
                        },
                      }
                    : {}),
                })),
              },
            }
          : {}),
        ...(options.routingDecision?.baseline
          ? {
              costBaseline: {
                priceBookVersion: options.priceBookVersion,
                provider: options.routingDecision.baseline.model.provider,
                model: options.routingDecision.baseline.model.id,
                upstreamModel: options.routingDecision.baseline.model.upstreamModel,
                pricing: options.routingDecision.baseline.model.pricing,
                tokenEstimate: options.routingDecision.baseline.tokenEstimate,
                estimatedCostUsd: options.routingDecision.baseline.estimatedCostUsd,
              },
            }
          : {}),
      });

  let terminal = false;
  let firstTokenRecorded = false;
  let latestUsage: TokenUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  try {
    for await (const event of source) {
      if (event.type === "response.started") {
        latestUsage = {
          ...latestUsage,
          inputTokens: Math.max(latestUsage.inputTokens, event.inputTokens),
        };
        await options.store.responseStarted(started.attemptId, event.responseId);
      } else if (event.type === "usage.updated") {
        latestUsage = { ...event.usage };
      } else if (
        !firstTokenRecorded &&
        (event.type === "text.delta" ||
          event.type === "reasoning.delta" ||
          event.type === "tool_call.arguments.delta")
      ) {
        firstTokenRecorded = true;
        await options.store.firstToken(started.attemptId);
      } else if (event.type === "response.completed") {
        latestUsage = { ...event.usage };
        await options.store.complete({
          requestId: options.request.requestId,
          attemptId: started.attemptId,
          provider: options.model.provider,
          model: options.model.id,
          upstreamModel: options.model.upstreamModel,
          usage: event.usage,
          estimatedCostUsd: estimateCost(event.usage, options.model),
          priceBookVersion: options.priceBookVersion,
          pricing: options.model.pricing,
        });
        terminal = true;
      } else if (event.type === "response.failed") {
        await options.store.fail({
          requestId: options.request.requestId,
          attemptId: started.attemptId,
          status: "FAILED",
          errorType: event.errorType,
          errorMessage: event.message,
          provider: options.model.provider,
          model: options.model.id,
          upstreamModel: options.model.upstreamModel,
          usage: latestUsage,
          estimatedCostUsd: estimateCost(latestUsage, options.model),
          priceBookVersion: options.priceBookVersion,
          pricing: options.model.pricing,
        });
        terminal = true;
      }
      yield event;
    }
  } catch (error) {
    if (!terminal) {
      await options.store.fail({
        requestId: options.request.requestId,
        attemptId: started.attemptId,
        status: options.signal?.aborted ? "CANCELLED" : "FAILED",
        errorType: errorType(error),
        errorMessage: safeErrorMessage(error),
        provider: options.model.provider,
        model: options.model.id,
        upstreamModel: options.model.upstreamModel,
        usage: latestUsage,
        estimatedCostUsd: estimateCost(latestUsage, options.model),
        priceBookVersion: options.priceBookVersion,
        pricing: options.model.pricing,
      });
      terminal = true;
    }
    throw error;
  } finally {
    if (!terminal) {
      await options.store.fail({
        requestId: options.request.requestId,
        attemptId: started.attemptId,
        status: options.signal?.aborted ? "CANCELLED" : "FAILED",
        errorType: options.signal?.aborted ? "cancelled" : "incomplete_stream",
        errorMessage: options.signal?.aborted
          ? "Client cancelled the provider attempt."
          : "Provider stream ended without a terminal event.",
        provider: options.model.provider,
        model: options.model.id,
        upstreamModel: options.model.upstreamModel,
        usage: latestUsage,
        estimatedCostUsd: estimateCost(latestUsage, options.model),
        priceBookVersion: options.priceBookVersion,
        pricing: options.model.pricing,
      });
    }
  }
}

export function estimateCost(usage: TokenUsage, model: ModelDefinition): number {
  const reasoningTokens = Math.min(usage.outputTokens, usage.reasoningTokens);
  const regularOutputTokens = usage.outputTokens - reasoningTokens;
  const pricing = model.pricing;
  return (
    (usage.inputTokens * pricing.inputPerMillion +
      usage.cachedInputTokens * pricing.cachedInputPerMillion +
      regularOutputTokens * pricing.outputPerMillion +
      reasoningTokens * (pricing.reasoningPerMillion ?? pricing.outputPerMillion)) /
    1_000_000
  );
}

function errorType(error: unknown): string {
  return error instanceof ProviderError ? error.code : "internal_error";
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : "Unknown provider failure.";
}
