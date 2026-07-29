import type { CanonicalRequest, ModelDefinition, TokenEstimate } from "@vartma/canonical";
import type { ProviderRegistry } from "@vartma/providers";

import { classifyTask } from "./classifier.js";
import { estimateRequestCost } from "./cost.js";
import type { SessionRoutingPolicy } from "./resilience.js";
import { RoutingError } from "./registry.js";
import type { ModelRegistry } from "./registry.js";
import type { SessionState } from "./session.js";
import type {
  CandidateFilterReason,
  CandidateScore,
  RoutingCandidate,
  RoutingDecision,
  RoutingExplanation,
  RoutingModePolicy,
  RoutingPolicies,
  TaskClassification,
} from "./types.js";

export interface RoutingEngineOptions {
  models: ModelRegistry;
  providers: ProviderRegistry;
  policies: RoutingPolicies;
  routerVersion: string;
  sessionPolicy: SessionRoutingPolicy;
  baselineModel?: string;
}

export interface RoutingContext {
  session?: SessionState;
  blockedModels?: ReadonlySet<string>;
  excludedModels?: ReadonlySet<string>;
}

export class RoutingEngine {
  public constructor(private readonly options: RoutingEngineOptions) {}

  public async route(
    request: CanonicalRequest,
    signal?: AbortSignal,
    context: RoutingContext = {},
  ): Promise<RoutingDecision> {
    signal?.throwIfAborted();
    const fixedModel = resolveFixedModel(request);
    if (fixedModel) {
      this.options.models.require(fixedModel);
    }

    const baselineEstimate = await this.baselineEstimate(request, fixedModel, signal);
    const task = classifyTask(request, baselineEstimate);
    const declaredBaseline = await this.declaredCostBaseline(request, signal);
    const policy = this.options.policies[request.routingMode];
    const candidates = await Promise.all(
      this.options.models
        .list()
        .map((model) =>
          this.evaluateCandidate(model, request, task, policy, fixedModel, context, signal),
        ),
    );
    const eligible = candidates.filter(
      (
        candidate,
      ): candidate is RoutingCandidate & {
        estimatedCostUsd: number;
        tokenEstimate: TokenEstimate;
      } => candidate.eligible && candidate.estimatedCostUsd !== undefined,
    );
    if (eligible.length === 0) {
      throw new RoutingError(
        noEligibleMessage(request, candidates, fixedModel),
        "no_eligible_model",
      );
    }

    scoreCandidates(eligible, policy, context.session, this.options.sessionPolicy);
    const scoredSelection = selectCandidate(eligible, request.routingMode);
    const sessionSelection = applySessionHysteresis(
      scoredSelection,
      eligible,
      request,
      task,
      context.session,
      this.options.sessionPolicy,
    );
    const selected = sessionSelection.selected;
    const explanation = explainSelection(selected, candidates, task, request, sessionSelection);
    return {
      decisionId: `route_${request.requestId}`,
      requestId: request.requestId,
      routerVersion: this.options.routerVersion,
      mode: request.routingMode,
      task,
      selectedModel: selected.model,
      candidates,
      explanation,
      ...(declaredBaseline ? { baseline: declaredBaseline } : {}),
      ...(context.session
        ? {
            session: {
              ...(context.session.currentProvider
                ? { previousProvider: context.session.currentProvider }
                : {}),
              ...(context.session.currentModel
                ? { previousModel: context.session.currentModel }
                : {}),
              escalationLevel: context.session.escalationLevel,
              stickySelection: sessionSelection.sticky,
              ...(sessionSelection.switchReason
                ? { switchReason: sessionSelection.switchReason }
                : {}),
            },
          }
        : {}),
    };
  }

  private async declaredCostBaseline(
    request: CanonicalRequest,
    signal?: AbortSignal,
  ): Promise<RoutingDecision["baseline"]> {
    if (!this.options.baselineModel) {
      return undefined;
    }
    const model = this.options.models.require(this.options.baselineModel);
    let tokenEstimate: TokenEstimate;
    try {
      tokenEstimate = await this.options.providers
        .get(model.provider)
        .estimateTokens(request, signal);
    } catch {
      tokenEstimate = fallbackTokenEstimate(request);
    }
    return {
      model,
      tokenEstimate,
      estimatedCostUsd: estimateRequestCost(tokenEstimate, model),
    };
  }

  private async baselineEstimate(
    request: CanonicalRequest,
    fixedModel: string | undefined,
    signal?: AbortSignal,
  ): Promise<TokenEstimate> {
    const models = fixedModel
      ? [this.options.models.require(fixedModel)]
      : this.options.models.list();
    if (models.length === 0) {
      throw new RoutingError("No models are configured.", "no_eligible_model");
    }
    for (const model of models) {
      try {
        return await this.options.providers.get(model.provider).estimateTokens(request, signal);
      } catch {
        // Candidate evaluation records the provider-specific failure. Classification can
        // continue with another provider or a conservative provider-neutral estimate.
      }
    }
    return fallbackTokenEstimate(request);
  }

  private async evaluateCandidate(
    model: ModelDefinition,
    request: CanonicalRequest,
    task: TaskClassification,
    policy: RoutingModePolicy,
    fixedModel: string | undefined,
    context: RoutingContext,
    signal?: AbortSignal,
  ): Promise<RoutingCandidate> {
    const filterReasons = staticFilterReasons(model, request, task, policy, fixedModel, context);
    if (filterReasons.length > 0) {
      return { model, eligible: false, filterReasons };
    }

    const adapter = this.options.providers.get(model.provider);
    let tokenEstimate: TokenEstimate;
    try {
      tokenEstimate = await adapter.estimateTokens(request, signal);
    } catch (error) {
      return {
        model,
        eligible: false,
        filterReasons: [
          {
            code: "token_estimation_failed",
            message: `Token estimation failed: ${safeMessage(error)}`,
          },
        ],
      };
    }

    const dynamicReasons = requestSizeReasons(model, request, tokenEstimate);
    const estimatedCostUsd = estimateRequestCost(tokenEstimate, model);
    if (
      request.constraints.maxEstimatedCostUsd !== undefined &&
      estimatedCostUsd > request.constraints.maxEstimatedCostUsd
    ) {
      dynamicReasons.push({
        code: "cost_limit",
        message: `Estimated cost $${estimatedCostUsd.toFixed(6)} exceeds limit $${request.constraints.maxEstimatedCostUsd.toFixed(6)}.`,
      });
    }
    if (dynamicReasons.length > 0) {
      return {
        model,
        eligible: false,
        filterReasons: dynamicReasons,
        tokenEstimate,
        estimatedCostUsd,
      };
    }

    let health;
    try {
      health = await adapter.health(model.upstreamModel, signal);
    } catch (error) {
      return {
        model,
        eligible: false,
        filterReasons: [
          {
            code: "unhealthy",
            message: `Health check failed: ${safeMessage(error)}`,
          },
        ],
        tokenEstimate,
        estimatedCostUsd,
      };
    }
    if (!health.healthy) {
      return {
        model,
        eligible: false,
        filterReasons: [
          {
            code: "unhealthy",
            message: health.reason ?? "Provider/model is unhealthy.",
          },
        ],
        tokenEstimate,
        estimatedCostUsd,
        health,
      };
    }

    return {
      model,
      eligible: true,
      filterReasons: [],
      tokenEstimate,
      estimatedCostUsd,
      health,
    };
  }
}

function resolveFixedModel(request: CanonicalRequest): string | undefined {
  if (request.constraints.forcedModel) {
    return request.constraints.forcedModel;
  }
  if (request.routingMode !== "fixed") {
    return undefined;
  }
  if (!request.requestedModel) {
    throw new RoutingError(
      "Fixed routing mode requires an explicit model.",
      "fixed_model_required",
    );
  }
  return request.requestedModel;
}

function staticFilterReasons(
  model: ModelDefinition,
  request: CanonicalRequest,
  task: TaskClassification,
  policy: RoutingModePolicy,
  fixedModel: string | undefined,
  context: RoutingContext,
): CandidateFilterReason[] {
  const reasons: CandidateFilterReason[] = [];
  const constraints = request.constraints;
  if (!model.enabled) {
    reasons.push({ code: "disabled", message: "Model is disabled." });
  }
  if (context.blockedModels?.has(model.id)) {
    reasons.push({
      code: "circuit_open",
      message: "The model circuit breaker is open.",
    });
  }
  if (context.excludedModels?.has(model.id)) {
    reasons.push({
      code: "previous_attempt_failed",
      message: "A previous attempt for this request failed on this model.",
    });
  }
  if (constraints.forcedProvider && model.provider !== constraints.forcedProvider) {
    reasons.push({
      code: "forced_provider",
      message: `Provider "${constraints.forcedProvider}" was forced.`,
    });
  }
  if (fixedModel && model.id !== fixedModel) {
    reasons.push({ code: "forced_model", message: `Model "${fixedModel}" was forced.` });
  }
  if (constraints.allowedProviders && !constraints.allowedProviders.includes(model.provider)) {
    reasons.push({ code: "provider_not_allowed", message: "Provider is not allowlisted." });
  }
  if (constraints.deniedProviders?.includes(model.provider)) {
    reasons.push({ code: "provider_denied", message: "Provider is denylisted." });
  }
  if (constraints.allowedModels && !constraints.allowedModels.includes(model.id)) {
    reasons.push({ code: "model_not_allowed", message: "Model is not allowlisted." });
  }
  if (constraints.deniedModels?.includes(model.id)) {
    reasons.push({ code: "model_denied", message: "Model is denylisted." });
  }
  for (const capability of constraints.requiredCapabilities) {
    if (!model.capabilities[capability]) {
      reasons.push({
        code: "missing_capability",
        message: `Missing required capability "${capability}".`,
      });
    }
  }
  if (constraints.requiredRegion) {
    if (!model.regions?.includes(constraints.requiredRegion)) {
      reasons.push({
        code: "region",
        message: model.regions
          ? `Model is not available in region "${constraints.requiredRegion}".`
          : "Model has no configured region declaration.",
      });
    }
  }
  if (constraints.maxLatencyMs !== undefined) {
    if (model.expectedLatencyMs === undefined) {
      reasons.push({
        code: "latency",
        message: "Model has no millisecond latency estimate.",
      });
    } else if (model.expectedLatencyMs > constraints.maxLatencyMs) {
      reasons.push({
        code: "latency",
        message: `Expected latency ${model.expectedLatencyMs}ms exceeds limit ${constraints.maxLatencyMs}ms.`,
      });
    }
  }
  if (!fixedModel) {
    const qualityFloor = Math.max(
      policy.minimumQualityTier,
      Math.min(
        5,
        task.difficulty + policy.difficultyTierAdjustment + (context.session?.escalationLevel ?? 0),
      ),
    );
    if (model.qualityTier < qualityFloor) {
      reasons.push({
        code: "quality_floor",
        message: `Quality tier ${model.qualityTier} is below required tier ${qualityFloor}.`,
      });
    }
  }
  return reasons;
}

function requestSizeReasons(
  model: ModelDefinition,
  request: CanonicalRequest,
  estimate: TokenEstimate,
): CandidateFilterReason[] {
  const reasons: CandidateFilterReason[] = [];
  if (request.maxOutputTokens > model.maxOutputTokens) {
    reasons.push({
      code: "max_output_tokens",
      message: `Requested ${request.maxOutputTokens} output tokens exceeds model maximum ${model.maxOutputTokens}.`,
    });
  }
  if (estimate.inputTokens + request.maxOutputTokens > model.contextWindow) {
    reasons.push({
      code: "context_window",
      message: `Estimated input plus requested output exceeds context window ${model.contextWindow}.`,
    });
  }
  return reasons;
}

function scoreCandidates(
  candidates: Array<RoutingCandidate & { estimatedCostUsd: number }>,
  policy: RoutingModePolicy,
  session?: SessionState,
  sessionPolicy?: SessionRoutingPolicy,
): void {
  const maximumCost = Math.max(...candidates.map((candidate) => candidate.estimatedCostUsd), 0);
  for (const candidate of candidates) {
    const expectedSuccess = Math.min(1, 0.35 + candidate.model.qualityTier * 0.13);
    const normalizedCost = maximumCost === 0 ? 0 : candidate.estimatedCostUsd / maximumCost;
    const normalizedLatency = candidate.model.expectedLatencyTier / 5;
    const failureRisk = candidate.health?.healthy ? 0 : 1;
    const sessionSwitchPenalty =
      sessionPolicy?.enabled && session?.currentModel && session.currentModel !== candidate.model.id
        ? sessionPolicy.switchPenalty
        : 0;
    const total =
      policy.qualityWeight * expectedSuccess -
      policy.costWeight * normalizedCost -
      policy.latencyWeight * normalizedLatency -
      policy.failureWeight * failureRisk -
      sessionSwitchPenalty;
    candidate.score = {
      expectedSuccess,
      normalizedCost,
      normalizedLatency,
      failureRisk,
      sessionSwitchPenalty,
      total,
    };
  }
}

interface SessionSelection {
  selected: RoutingCandidate & {
    score: CandidateScore;
    estimatedCostUsd: number;
  };
  sticky: boolean;
  switchReason?: string;
}

function applySessionHysteresis(
  scoredSelection: RoutingCandidate & { score: CandidateScore; estimatedCostUsd: number },
  eligible: Array<RoutingCandidate & { estimatedCostUsd: number }>,
  request: CanonicalRequest,
  task: TaskClassification,
  session: SessionState | undefined,
  policy: SessionRoutingPolicy,
): SessionSelection {
  if (!policy.enabled || !session?.currentModel) {
    return { selected: scoredSelection, sticky: false, switchReason: "no previous session model" };
  }
  if (request.constraints.forcedModel || request.routingMode === "fixed") {
    return {
      selected: scoredSelection,
      sticky: scoredSelection.model.id === session.currentModel,
      switchReason: "explicit model instruction",
    };
  }
  if (request.constraints.forcedProvider) {
    return {
      selected: scoredSelection,
      sticky: scoredSelection.model.id === session.currentModel,
      switchReason: "explicit provider instruction",
    };
  }
  if (scoredSelection.model.id === session.currentModel) {
    return { selected: scoredSelection, sticky: true };
  }
  const current = eligible.find(
    (
      candidate,
    ): candidate is RoutingCandidate & {
      score: CandidateScore;
      estimatedCostUsd: number;
    } => candidate.model.id === session.currentModel && candidate.score !== undefined,
  );
  if (!current) {
    return {
      selected: scoredSelection,
      sticky: false,
      switchReason: "previous session model is no longer eligible",
    };
  }
  if (session.lastTaskClass && taskFamily(session.lastTaskClass) !== taskFamily(task.taskClass)) {
    return {
      selected: scoredSelection,
      sticky: false,
      switchReason: "task category changed materially",
    };
  }
  if (scoredSelection.score.total - current.score.total < policy.switchScoreThreshold) {
    return { selected: current, sticky: true };
  }
  return {
    selected: scoredSelection,
    sticky: false,
    switchReason: "new candidate exceeded the configured switch threshold",
  };
}

function taskFamily(taskClass: TaskClassification["taskClass"]): string {
  switch (taskClass) {
    case "explanation":
    case "documentation":
    case "simple_tool_operation":
      return "light";
    case "code_generation":
    case "small_edit":
    case "test_generation":
      return "implementation";
    case "debugging":
    case "test_repair":
      return "repair";
    case "multi_file_feature":
    case "refactoring":
    case "repository_exploration":
      return "codebase";
    case "architecture_design":
    case "security_review":
    case "migration":
    case "long_autonomous_task":
      return "high_complexity";
  }
}

function selectCandidate(
  candidates: Array<RoutingCandidate & { score?: CandidateScore; estimatedCostUsd: number }>,
  mode: CanonicalRequest["routingMode"],
): RoutingCandidate & { score: CandidateScore; estimatedCostUsd: number } {
  return candidates
    .filter(
      (
        candidate,
      ): candidate is RoutingCandidate & {
        score: CandidateScore;
        estimatedCostUsd: number;
      } => candidate.score !== undefined,
    )
    .sort((left, right) => {
      const scoreDifference = right.score.total - left.score.total;
      if (Math.abs(scoreDifference) > 1e-12) {
        return scoreDifference;
      }
      if (mode === "quality" && left.model.qualityTier !== right.model.qualityTier) {
        return right.model.qualityTier - left.model.qualityTier;
      }
      if (left.estimatedCostUsd !== right.estimatedCostUsd) {
        return left.estimatedCostUsd - right.estimatedCostUsd;
      }
      if (left.model.expectedLatencyTier !== right.model.expectedLatencyTier) {
        return left.model.expectedLatencyTier - right.model.expectedLatencyTier;
      }
      return left.model.id.localeCompare(right.model.id);
    })[0]!;
}

function explainSelection(
  selected: RoutingCandidate & { score: CandidateScore; estimatedCostUsd: number },
  candidates: RoutingCandidate[],
  task: TaskClassification,
  request: CanonicalRequest,
  sessionSelection: SessionSelection,
): RoutingExplanation {
  const selectedReasons = [
    `classified as ${task.taskClass} at difficulty ${task.difficulty}`,
    `passed all capability, policy, health, and budget filters`,
    `quality tier ${selected.model.qualityTier}`,
    `estimated cost $${selected.estimatedCostUsd.toFixed(6)}`,
    `mode score ${selected.score.total.toFixed(6)}`,
  ];
  if (sessionSelection.sticky) {
    selectedReasons.push("kept the eligible session model to avoid an unnecessary switch");
  } else if (sessionSelection.switchReason) {
    selectedReasons.push(`session switch reason: ${sessionSelection.switchReason}`);
  }
  if (request.constraints.forcedModel || request.routingMode === "fixed") {
    selectedReasons.unshift("selected by explicit fixed-model instruction");
  } else if (request.constraints.forcedProvider) {
    selectedReasons.unshift(
      `selected from forced provider "${request.constraints.forcedProvider}"`,
    );
  }
  return {
    summary: `Selected ${selected.model.id} in ${request.routingMode} mode for ${task.taskClass}.`,
    selectedReasons,
    rejected: candidates
      .filter((candidate) => candidate.model.id !== selected.model.id)
      .map((candidate) => ({
        model: candidate.model.id,
        reasons:
          candidate.filterReasons.length > 0
            ? candidate.filterReasons.map((reason) => reason.message)
            : [`lower final score ${candidate.score?.total.toFixed(6) ?? "unavailable"}`],
      })),
  };
}

function noEligibleMessage(
  request: CanonicalRequest,
  candidates: RoutingCandidate[],
  fixedModel: string | undefined,
): string {
  const reason = candidates
    .map(
      (candidate) =>
        `${candidate.model.id}: ${candidate.filterReasons.map((item) => item.message).join("; ")}`,
    )
    .join(" | ");
  return `No eligible model for ${fixedModel ? `forced model "${fixedModel}"` : `${request.routingMode} mode`}.${reason ? ` ${reason}` : ""}`;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function fallbackTokenEstimate(request: CanonicalRequest): TokenEstimate {
  const characters = JSON.stringify({
    messages: request.messages,
    tools: request.tools,
    responseFormat: request.responseFormat,
  }).length;
  return {
    inputTokens: Math.max(1, Math.ceil(characters / 4)),
    expectedOutputTokens: Math.min(request.maxOutputTokens, 512),
  };
}
