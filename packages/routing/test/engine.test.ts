import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "@vartma/providers";

import {
  defaultRoutingPolicies,
  defaultSessionRoutingPolicy,
  ModelRegistry,
  RoutingEngine,
  RoutingError,
  type RoutingCalibration,
} from "../src/index.js";
import { providerRegistry, TestProvider, testModel, testRequest } from "./helpers.js";

const cheap = testModel({
  id: "cheap/basic",
  qualityTier: 1,
  inputPrice: 0.1,
  outputPrice: 0.4,
  latencyTier: 1,
});
const balanced = testModel({
  id: "balanced/standard",
  qualityTier: 3,
  inputPrice: 5,
  outputPrice: 20,
  latencyTier: 2,
});
const frontier = testModel({
  id: "frontier/best",
  qualityTier: 5,
  inputPrice: 50,
  outputPrice: 200,
  latencyTier: 4,
});

function engine(
  models = [cheap, balanced, frontier],
  health = {},
  baselineModel?: string,
  calibration?: RoutingCalibration,
) {
  return new RoutingEngine({
    models: new ModelRegistry(models),
    providers: providerRegistry(models, health),
    policies: defaultRoutingPolicies,
    routerVersion: "test-router-v1",
    sessionPolicy: defaultSessionRoutingPolicy,
    ...(calibration ? { calibration } : {}),
    ...(baselineModel ? { baselineModel } : {}),
  });
}

describe("RoutingEngine modes", () => {
  it("quality selects the highest-success eligible model", async () => {
    const request = testRequest();
    request.routingMode = "quality";

    const decision = await engine().route(request);

    expect(decision.selectedModel.id).toBe("frontier/best");
    expect(decision.explanation.summary).toContain("frontier/best");
  });

  it("balanced selects the cost/quality middle for normal coding", async () => {
    const decision = await engine().route(testRequest());

    expect(decision.selectedModel.id).toBe("balanced/standard");
  });

  it("records a declared baseline independently of the selected route", async () => {
    const decision = await engine([cheap, balanced, frontier], {}, "frontier/best").route(
      testRequest(),
    );

    expect(decision.selectedModel.id).toBe("balanced/standard");
    expect(decision.baseline).toMatchObject({
      model: { id: "frontier/best" },
      tokenEstimate: {
        inputTokens: 1000,
        expectedOutputTokens: 500,
      },
      estimatedCostUsd: 0.15,
    });
  });

  it("eco selects the cheapest capable model for simple work", async () => {
    const request = testRequest("Explain this variable");
    request.routingMode = "eco";

    const decision = await engine().route(request);

    expect(decision.selectedModel.id).toBe("cheap/basic");
  });

  it("eco enforces a stronger quality floor for difficult work", async () => {
    const request = testRequest("Design the distributed system architecture");
    request.routingMode = "eco";

    const decision = await engine().route(request);

    expect(decision.selectedModel.id).toBe("frontier/best");
    expect(
      decision.candidates.find((candidate) => candidate.model.id === "cheap/basic")?.filterReasons,
    ).toContainEqual(expect.objectContaining({ code: "quality_floor" }));
  });

  it("fixed always uses the exact requested model", async () => {
    const request = testRequest();
    request.routingMode = "fixed";
    request.requestedModel = "cheap/basic";

    const decision = await engine().route(request);

    expect(decision.selectedModel.id).toBe("cheap/basic");
    expect(decision.explanation.selectedReasons[0]).toContain("fixed-model");
  });

  it("requires an explicit configured model in fixed mode", async () => {
    const missing = testRequest();
    missing.routingMode = "fixed";
    await expect(engine().route(missing)).rejects.toMatchObject<Partial<RoutingError>>({
      code: "fixed_model_required",
    });

    const unknown = testRequest();
    unknown.routingMode = "fixed";
    unknown.requestedModel = "missing/model";
    await expect(engine().route(unknown)).rejects.toMatchObject<Partial<RoutingError>>({
      code: "model_not_found",
    });
  });

  it("honors explicit forced model and provider constraints", async () => {
    const forcedModel = testRequest();
    forcedModel.constraints.forcedModel = "balanced/standard";
    expect((await engine().route(forcedModel)).selectedModel.id).toBe("balanced/standard");

    const forcedProvider = testRequest();
    forcedProvider.constraints.forcedProvider = "frontier";
    expect((await engine().route(forcedProvider)).selectedModel.id).toBe("frontier/best");
  });
});

describe("RoutingEngine advanced session policy", () => {
  it("keeps an eligible session model when score improvement is below hysteresis", async () => {
    const request = testRequest("Implement a function that adds two numbers");
    const decision = await engine().route(request, undefined, {
      session: {
        id: "session-1",
        routingMode: "balanced",
        currentProvider: cheap.provider,
        currentModel: cheap.id,
        escalationLevel: 0,
        turnCount: 1,
        lastTaskClass: "code_generation",
        consecutiveFailures: 0,
        successfulOutcomes: 0,
        automaticEscalationLevel: 0,
        lastActivityAt: new Date(0).toISOString(),
      },
    });

    expect(decision.selectedModel.id).toBe(cheap.id);
    expect(decision.session?.stickySelection).toBe(true);
    expect(decision.explanation.selectedReasons).toContain(
      "kept the eligible session model to avoid an unnecessary switch",
    );
  });

  it("switches when escalation makes the previous model ineligible", async () => {
    const request = testRequest("Implement a function that adds two numbers");
    const decision = await engine().route(request, undefined, {
      session: {
        id: "session-2",
        routingMode: "balanced",
        currentProvider: cheap.provider,
        currentModel: cheap.id,
        escalationLevel: 1,
        turnCount: 2,
        lastTaskClass: "code_generation",
        consecutiveFailures: 0,
        successfulOutcomes: 0,
        automaticEscalationLevel: 0,
        lastActivityAt: new Date(0).toISOString(),
      },
    });

    expect(decision.selectedModel.id).not.toBe(cheap.id);
    expect(
      decision.candidates
        .find((candidate) => candidate.model.id === cheap.id)
        ?.filterReasons.map((reason) => reason.code),
    ).toContain("quality_floor");
    expect(decision.session?.switchReason).toContain("no longer eligible");
  });

  it("filters models with open circuits", async () => {
    const request = testRequest();
    const decision = await engine().route(request, undefined, {
      blockedModels: new Set([balanced.id]),
    });

    expect(
      decision.candidates
        .find((candidate) => candidate.model.id === balanced.id)
        ?.filterReasons.map((reason) => reason.code),
    ).toContain("circuit_open");
    expect(decision.selectedModel.id).not.toBe(balanced.id);
  });
});

describe("RoutingEngine session policy", () => {
  it("keeps an eligible session model when improvement is below hysteresis threshold", async () => {
    const routingEngine = new RoutingEngine({
      models: new ModelRegistry([cheap, balanced, frontier]),
      providers: providerRegistry([cheap, balanced, frontier]),
      policies: defaultRoutingPolicies,
      routerVersion: "test-router-v1",
      sessionPolicy: {
        ...defaultSessionRoutingPolicy,
        switchScoreThreshold: 10,
      },
    });
    const request = testRequest("Implement a function that adds two numbers");

    const decision = await routingEngine.route(request, undefined, {
      session: {
        id: "session-1",
        routingMode: "balanced",
        currentProvider: frontier.provider,
        currentModel: frontier.id,
        escalationLevel: 0,
        turnCount: 4,
        lastTaskClass: "code_generation",
        consecutiveFailures: 0,
        successfulOutcomes: 0,
        automaticEscalationLevel: 0,
        lastActivityAt: "2026-07-28T00:00:00.000Z",
      },
    });

    expect(decision.selectedModel.id).toBe(frontier.id);
    expect(decision.session).toMatchObject({
      previousModel: frontier.id,
      stickySelection: true,
    });
    expect(decision.explanation.selectedReasons).toContain(
      "kept the eligible session model to avoid an unnecessary switch",
    );
  });

  it("raises the quality floor when the session escalation level increases", async () => {
    const request = testRequest("Implement a function that adds two numbers");
    request.routingMode = "eco";

    const decision = await engine().route(request, undefined, {
      session: {
        id: "session-1",
        routingMode: "eco",
        escalationLevel: 2,
        turnCount: 3,
        consecutiveFailures: 0,
        successfulOutcomes: 0,
        automaticEscalationLevel: 0,
        lastActivityAt: "2026-07-28T00:00:00.000Z",
      },
    });

    expect(decision.selectedModel.id).toBe("balanced/standard");
    expect(
      decision.candidates.find((candidate) => candidate.model.id === "cheap/basic")?.filterReasons,
    ).toContainEqual(expect.objectContaining({ code: "quality_floor" }));
    expect(decision.session?.escalationLevel).toBe(2);
  });

  it("filters models whose circuit is open", async () => {
    const decision = await engine().route(testRequest(), undefined, {
      blockedModels: new Set(["balanced/standard"]),
    });

    expect(
      decision.candidates.find((candidate) => candidate.model.id === "balanced/standard")
        ?.filterReasons,
    ).toContainEqual(expect.objectContaining({ code: "circuit_open" }));
  });
});

describe("RoutingEngine filters", () => {
  it("never sends a tool request to a model without tools", async () => {
    const noTools = testModel({
      id: "cheap/no-tools",
      qualityTier: 3,
      inputPrice: 0,
      capabilities: { tools: false },
    });
    const withTools = testModel({
      id: "safe/with-tools",
      qualityTier: 3,
      inputPrice: 10,
      capabilities: { tools: true },
    });
    const request = testRequest("Use a tool to get the weather");
    request.tools = [{ name: "weather", inputSchema: { type: "object" } }];
    request.constraints.requiredCapabilities = ["tools"];

    const decision = await engine([noTools, withTools]).route(request);

    expect(decision.selectedModel.id).toBe("safe/with-tools");
    expect(decision.candidates[0]?.filterReasons).toContainEqual(
      expect.objectContaining({ code: "missing_capability" }),
    );
  });

  it("applies provider/model allowlists and denylists", async () => {
    const request = testRequest();
    request.constraints.allowedProviders = ["balanced", "frontier"];
    request.constraints.deniedModels = ["frontier/best"];

    const decision = await engine().route(request);

    expect(decision.selectedModel.id).toBe("balanced/standard");
    expect(
      decision.candidates.find((candidate) => candidate.model.id === "cheap/basic")?.filterReasons,
    ).toContainEqual(expect.objectContaining({ code: "provider_not_allowed" }));
    expect(
      decision.candidates.find((candidate) => candidate.model.id === "frontier/best")
        ?.filterReasons,
    ).toContainEqual(expect.objectContaining({ code: "model_denied" }));
  });

  it("covers provider/model deny and model allow filters", async () => {
    const request = testRequest();
    request.constraints.deniedProviders = ["cheap"];
    request.constraints.allowedModels = ["balanced/standard", "frontier/best"];
    request.constraints.deniedModels = ["frontier/best"];

    const decision = await engine().route(request);

    expect(decision.selectedModel.id).toBe("balanced/standard");
    const cheapReasons = decision.candidates.find(
      (candidate) => candidate.model.id === "cheap/basic",
    )?.filterReasons;
    expect(cheapReasons).toContainEqual(expect.objectContaining({ code: "provider_denied" }));
    expect(cheapReasons).toContainEqual(expect.objectContaining({ code: "model_not_allowed" }));
  });

  it("reports forced-provider and forced-model filters on rejected candidates", async () => {
    const forcedProvider = testRequest();
    forcedProvider.constraints.forcedProvider = "balanced";
    const providerDecision = await engine().route(forcedProvider);
    expect(
      providerDecision.candidates.find((candidate) => candidate.model.id === "frontier/best")
        ?.filterReasons,
    ).toContainEqual(expect.objectContaining({ code: "forced_provider" }));

    const forcedModel = testRequest();
    forcedModel.constraints.forcedModel = "balanced/standard";
    const modelDecision = await engine().route(forcedModel);
    expect(
      modelDecision.candidates.find((candidate) => candidate.model.id === "cheap/basic")
        ?.filterReasons,
    ).toContainEqual(expect.objectContaining({ code: "forced_model" }));
  });

  it("filters disabled models", async () => {
    const disabled = testModel({
      id: "disabled/model",
      qualityTier: 5,
      inputPrice: 0,
      enabled: false,
    });
    const decision = await engine([disabled, balanced]).route(testRequest());

    expect(decision.selectedModel.id).toBe("balanced/standard");
    expect(
      decision.candidates.find((candidate) => candidate.model.id === "disabled/model")
        ?.filterReasons,
    ).toContainEqual(expect.objectContaining({ code: "disabled" }));
  });

  it("filters unhealthy providers", async () => {
    const decision = await engine([balanced, frontier], {
      balanced: {
        healthy: false,
        observedAt: new Date(0).toISOString(),
        reason: "circuit open",
      },
    }).route(testRequest());

    expect(decision.selectedModel.id).toBe("frontier/best");
    expect(decision.candidates[0]?.filterReasons).toContainEqual(
      expect.objectContaining({ code: "unhealthy" }),
    );
  });

  it("filters context, output, cost, latency, and region constraints", async () => {
    const constrained = testModel({
      id: "constrained/model",
      qualityTier: 3,
      inputPrice: 100,
      contextWindow: 1200,
      maxOutputTokens: 256,
      expectedLatencyMs: 2000,
      regions: ["us"],
    });
    const request = testRequest();
    request.maxOutputTokens = 512;
    request.constraints.maxEstimatedCostUsd = 0.000001;
    request.constraints.maxLatencyMs = 500;
    request.constraints.requiredRegion = "in";

    await expect(engine([constrained]).route(request)).rejects.toMatchObject<Partial<RoutingError>>(
      {
        code: "no_eligible_model",
      },
    );

    try {
      await engine([constrained]).route(request);
    } catch (error) {
      expect(error).toBeInstanceOf(RoutingError);
      expect((error as Error).message).toContain("region");
      expect((error as Error).message).toContain("latency");
    }
  });

  it("filters context-window and maximum-output violations", async () => {
    const tooSmall = testModel({
      id: "small/context",
      qualityTier: 3,
      inputPrice: 0,
      contextWindow: 1200,
      maxOutputTokens: 256,
    });
    const suitable = testModel({
      id: "large/context",
      qualityTier: 3,
      inputPrice: 1,
      contextWindow: 10_000,
      maxOutputTokens: 2048,
    });
    const request = testRequest();
    request.maxOutputTokens = 512;

    const decision = await engine([tooSmall, suitable]).route(request);
    const reasons = decision.candidates.find(
      (candidate) => candidate.model.id === "small/context",
    )?.filterReasons;

    expect(reasons).toContainEqual(expect.objectContaining({ code: "context_window" }));
    expect(reasons).toContainEqual(expect.objectContaining({ code: "max_output_tokens" }));
  });

  it("rejects missing latency declarations when a millisecond limit is required", async () => {
    const request = testRequest();
    request.constraints.maxLatencyMs = 500;

    await expect(engine([balanced]).route(request)).rejects.toThrow(
      "no millisecond latency estimate",
    );
  });

  it("filters token-estimation failures without failing healthy alternatives", async () => {
    class FailingEstimateProvider extends TestProvider {
      public override estimateTokens(): Promise<never> {
        return Promise.reject(new Error("tokenizer unavailable"));
      }
    }

    const failing = testModel({
      id: "failing/model",
      qualityTier: 5,
      inputPrice: 0,
    });
    const fallback = testModel({
      id: "fallback/model",
      qualityTier: 3,
      inputPrice: 2,
    });
    const providers = new ProviderRegistry();
    providers.register(new FailingEstimateProvider("failing", [failing]));
    providers.register(new TestProvider("fallback", [fallback]));
    const routingEngine = new RoutingEngine({
      models: new ModelRegistry([failing, fallback]),
      providers,
      policies: defaultRoutingPolicies,
      routerVersion: "test-router-v1",
      sessionPolicy: defaultSessionRoutingPolicy,
    });

    const decision = await routingEngine.route(testRequest());

    expect(decision.selectedModel.id).toBe("fallback/model");
    expect(
      decision.candidates.find((candidate) => candidate.model.id === "failing/model")
        ?.filterReasons,
    ).toContainEqual(expect.objectContaining({ code: "token_estimation_failed" }));
  });

  it("filters requests above the estimated cost limit", async () => {
    const request = testRequest();
    request.constraints.maxEstimatedCostUsd = 0.000001;

    await expect(engine([balanced]).route(request)).rejects.toThrow("Estimated cost");
  });

  it("filters only the candidates above a shared cost limit", async () => {
    const lowCost = testModel({
      id: "low/cost",
      qualityTier: 3,
      inputPrice: 0.1,
    });
    const highCost = testModel({
      id: "high/cost",
      qualityTier: 3,
      inputPrice: 100,
    });
    const request = testRequest();
    request.constraints.maxEstimatedCostUsd = 0.001;

    const decision = await engine([lowCost, highCost]).route(request);

    expect(decision.selectedModel.id).toBe("low/cost");
    expect(
      decision.candidates.find((candidate) => candidate.model.id === "high/cost")?.filterReasons,
    ).toContainEqual(expect.objectContaining({ code: "cost_limit" }));
  });
});

describe("RoutingEngine scoring and explanations", () => {
  it("uses task-specific evaluation evidence instead of quality tier as the success estimate", async () => {
    const evaluatedEconomy = testModel({
      id: "evaluated/economy",
      qualityTier: 2,
      inputPrice: 1,
      outputPrice: 4,
    });
    const disappointingFrontier = testModel({
      id: "evaluated/frontier",
      qualityTier: 5,
      inputPrice: 12,
      outputPrice: 48,
    });
    const calibration: RoutingCalibration = {
      enabled: true,
      version: "coding-eval-2026-08-24",
      priorSampleSize: 0,
      models: {
        [evaluatedEconomy.id]: {
          tasks: {
            code_generation: {
              successRate: 0.92,
              sampleSize: 100,
              averageAttempts: 1.05,
              observedAt: "2026-08-24T00:00:00.000Z",
              source: "reproducible coding evaluation",
            },
          },
        },
        [disappointingFrontier.id]: {
          tasks: {
            code_generation: {
              successRate: 0.55,
              sampleSize: 100,
              averageAttempts: 1.8,
              observedAt: "2026-08-24T00:00:00.000Z",
              source: "reproducible coding evaluation",
            },
          },
        },
      },
    };

    const decision = await engine(
      [evaluatedEconomy, disappointingFrontier],
      {},
      undefined,
      calibration,
    ).route(testRequest());

    expect(decision.selectedModel.id).toBe(evaluatedEconomy.id);
    expect(
      decision.candidates.find((item) => item.model.id === evaluatedEconomy.id)?.score,
    ).toMatchObject({
      expectedSuccess: 0.92,
      expectedAttempts: 1.05,
      calibrationSource: "task_evaluation",
      calibrationSampleSize: 100,
    });
    expect(decision.explanation.selectedReasons.join(" ")).toContain("100 samples");
  });

  it("prices retries, failures, and the cold-input cost of a model switch", async () => {
    const current = testModel({
      id: "cache/current",
      qualityTier: 3,
      inputPrice: 10,
      outputPrice: 20,
    });
    const alternative = testModel({
      id: "cache/alternative",
      qualityTier: 3,
      inputPrice: 10,
      outputPrice: 20,
    });
    const sample = {
      successRate: 1,
      sampleSize: 20,
      averageAttempts: 2,
      observedAt: "2026-08-24T00:00:00.000Z",
      source: "cache-aware evaluation",
    };
    const decision = await engine([current, alternative], {}, undefined, {
      enabled: true,
      version: "cache-eval-v1",
      priorSampleSize: 0,
      models: {
        [current.id]: { default: sample, tasks: {} },
        [alternative.id]: { default: sample, tasks: {} },
      },
    }).route(testRequest(), undefined, {
      session: {
        id: "cache-session",
        routingMode: "balanced",
        currentProvider: current.provider,
        currentModel: current.id,
        escalationLevel: 0,
        automaticEscalationLevel: 0,
        turnCount: 2,
        consecutiveFailures: 0,
        successfulOutcomes: 0,
        lastActivityAt: "2026-08-24T00:00:00.000Z",
      },
    });

    const currentScore = decision.candidates.find((item) => item.model.id === current.id)?.score;
    const alternativeScore = decision.candidates.find(
      (item) => item.model.id === alternative.id,
    )?.score;
    expect(currentScore?.switchColdInputCostUsd).toBe(0);
    expect(alternativeScore?.switchColdInputCostUsd).toBeCloseTo(0.009, 8);
    expect(alternativeScore!.expectedTotalCostUsd).toBeGreaterThan(
      currentScore!.expectedTotalCostUsd,
    );
  });

  it("uses configured pricing, so price changes require no routing-code change", async () => {
    const first = testModel({
      id: "one/equal",
      qualityTier: 2,
      inputPrice: 1,
      latencyTier: 2,
    });
    const second = testModel({
      id: "two/equal",
      qualityTier: 2,
      inputPrice: 10,
      latencyTier: 2,
    });
    const request = testRequest("Explain this code");
    request.routingMode = "eco";

    expect((await engine([first, second]).route(request)).selectedModel.id).toBe("one/equal");

    const repricedFirst = { ...first, pricing: { ...first.pricing, inputPerMillion: 20 } };
    const repricedSecond = { ...second, pricing: { ...second.pricing, inputPerMillion: 0.1 } };
    expect((await engine([repricedFirst, repricedSecond]).route(request)).selectedModel.id).toBe(
      "two/equal",
    );
  });

  it("returns deterministic candidate scores and a complete explanation", async () => {
    const decision = await engine().route(testRequest());

    expect(decision.decisionId).toBe("route_routing-request-1");
    expect(decision.routerVersion).toBe("test-router-v1");
    expect(decision.task.taskClass).toBe("code_generation");
    expect(decision.candidates).toHaveLength(3);
    expect(
      decision.candidates
        .filter((candidate) => candidate.eligible)
        .every((candidate) => candidate.score !== undefined),
    ).toBe(true);
    expect(decision.explanation.selectedReasons.length).toBeGreaterThan(3);
    expect(decision.explanation.rejected).toHaveLength(2);
  });
});
