import type {
  CanonicalEvent,
  CanonicalRequest,
  CapabilitySet,
  HealthStatus,
  ModelDefinition,
  TokenEstimate,
} from "@vartma/canonical";
import type {
  AttemptStore,
  CompleteAttemptInput,
  FailAttemptInput,
  StartAttemptInput,
  StartFallbackAttemptInput,
} from "@vartma/database";
import { ProviderError, ProviderRegistry, type ProviderAdapter } from "@vartma/providers";
import {
  CircuitBreakerRegistry,
  defaultCircuitBreakerPolicy,
  defaultFallbackPolicy,
  type RoutingDecision,
} from "@vartma/routing";
import { describe, expect, it } from "vitest";

import { prepareFallbackExecution, providerCircuitKey } from "../src/fallback.js";

const primary = model("primary/model", "primary", 3);
const secondary = model("secondary/model", "secondary", 3);
const tertiary = model("tertiary/model", "tertiary", 2);

describe("prepareFallbackExecution", () => {
  it("falls back after a retryable failure before meaningful output", async () => {
    const first = new ScriptedProvider("primary", primary, () =>
      events(started(primary), failed("overloaded", "Primary is overloaded.", true)),
    );
    const second = new ScriptedProvider("secondary", secondary, () =>
      events(
        started(secondary),
        { type: "content.started", index: 0, contentType: "text" },
        { type: "text.delta", index: 0, text: "fallback response" },
        { type: "content.completed", index: 0 },
        completed(),
      ),
    );

    const circuits = new CircuitBreakerRegistry({
      ...defaultCircuitBreakerPolicy,
      failureThreshold: 1,
    });
    const prepared = await prepareFallbackExecution({
      decision: decision([primary, secondary]),
      request: canonicalRequest(),
      providers: registry(first, second),
      policy: defaultFallbackPolicy,
      circuits,
      priceBookVersion: "test-prices",
    });
    const output = await collect(prepared.events);

    expect(prepared.model.id).toBe(secondary.id);
    expect(prepared.fallbackCount).toBe(1);
    expect(output).toContainEqual(
      expect.objectContaining({ type: "text.delta", text: "fallback response" }),
    );
    expect(first.executions).toBe(1);
    expect(second.executions).toBe(1);
    expect(circuits.snapshot(primary.id).state).toBe("open");
    expect(circuits.snapshot(providerCircuitKey(primary.provider)).state).toBe("open");
  });

  it("does not retry after text output has started", async () => {
    const first = new ScriptedProvider("primary", primary, () =>
      throwingEvents(
        [
          started(primary),
          { type: "content.started", index: 0, contentType: "text" },
          { type: "text.delta", index: 0, text: "visible" },
        ],
        new ProviderError("connection lost", "network", true),
      ),
    );
    const second = new ScriptedProvider("secondary", secondary, () =>
      events(started(secondary), completed()),
    );

    const prepared = await prepareFallbackExecution({
      decision: decision([primary, secondary]),
      request: canonicalRequest(),
      providers: registry(first, second),
      policy: defaultFallbackPolicy,
      circuits: new CircuitBreakerRegistry(defaultCircuitBreakerPolicy),
      priceBookVersion: "test-prices",
    });

    await expect(collect(prepared.events)).rejects.toThrow("connection lost");
    expect(prepared.model.id).toBe(primary.id);
    expect(second.executions).toBe(0);
  });

  it("never replays a tool call after it has become visible", async () => {
    const first = new ScriptedProvider("primary", primary, () =>
      throwingEvents(
        [
          started(primary),
          {
            type: "tool_call.started",
            index: 0,
            toolCallId: "tool-1",
            name: "write_file",
          },
          {
            type: "tool_call.arguments.delta",
            index: 0,
            toolCallId: "tool-1",
            partialJson: '{"path":"a.ts"}',
          },
          { type: "tool_call.completed", index: 0, toolCallId: "tool-1" },
        ],
        new ProviderError("late timeout", "timeout", true),
      ),
    );
    const second = new ScriptedProvider("secondary", secondary, () =>
      events(started(secondary), completed()),
    );
    const prepared = await prepareFallbackExecution({
      decision: decision([primary, secondary]),
      request: canonicalRequest(),
      providers: registry(first, second),
      policy: defaultFallbackPolicy,
      circuits: new CircuitBreakerRegistry(defaultCircuitBreakerPolicy),
      priceBookVersion: "test-prices",
    });

    await expect(collect(prepared.events)).rejects.toThrow("late timeout");
    expect(second.executions).toBe(0);
  });

  it("enforces the cross-model attempt budget", async () => {
    const first = failingProvider("primary", primary);
    const second = failingProvider("secondary", secondary);
    const third = failingProvider("tertiary", tertiary);

    await expect(
      prepareFallbackExecution({
        decision: decision([primary, secondary, tertiary]),
        request: canonicalRequest(),
        providers: registry(first, second, third),
        policy: { ...defaultFallbackPolicy, maxAttempts: 2 },
        circuits: new CircuitBreakerRegistry(defaultCircuitBreakerPolicy),
        priceBookVersion: "test-prices",
      }),
    ).rejects.toThrow("unavailable");

    expect(first.executions).toBe(1);
    expect(second.executions).toBe(1);
    expect(third.executions).toBe(0);
  });

  it("does not leave a forced model", async () => {
    const first = failingProvider("primary", primary);
    const second = new ScriptedProvider("secondary", secondary, () =>
      events(started(secondary), completed()),
    );
    const request = canonicalRequest();
    request.constraints.forcedModel = primary.id;

    await expect(
      prepareFallbackExecution({
        decision: decision([primary, secondary]),
        request,
        providers: registry(first, second),
        policy: defaultFallbackPolicy,
        circuits: new CircuitBreakerRegistry(defaultCircuitBreakerPolicy),
        priceBookVersion: "test-prices",
      }),
    ).rejects.toThrow("unavailable");
    expect(second.executions).toBe(0);
  });

  it("persists each attempt and the model-switch reason", async () => {
    const first = new ScriptedProvider("primary", primary, () =>
      events(started(primary), failed("overloaded", "Primary overloaded.", true)),
    );
    const second = new ScriptedProvider("secondary", secondary, () =>
      events(started(secondary), completed()),
    );
    const store = new MemoryAttemptStore();

    const prepared = await prepareFallbackExecution({
      decision: decision([primary, secondary]),
      request: canonicalRequest(),
      providers: registry(first, second),
      policy: defaultFallbackPolicy,
      circuits: new CircuitBreakerRegistry(defaultCircuitBreakerPolicy),
      priceBookVersion: "test-prices",
      attemptStore: store,
    });
    await collect(prepared.events);

    expect(store.initialAttempts).toHaveLength(1);
    expect(store.fallbackAttempts).toHaveLength(1);
    expect(store.fallbackAttempts[0]).toMatchObject({
      fromModel: primary.id,
      selectedModel: secondary.id,
      reason: "Primary overloaded.",
      trigger: "overloaded",
    });
    expect(store.failedAttempts).toHaveLength(1);
    expect(store.completedAttempts).toHaveLength(1);
  });

  it("enforces the total fallback wall-clock budget", async () => {
    const hanging = new HangingProvider(primary);
    const startedAt = Date.now();

    await expect(
      prepareFallbackExecution({
        decision: decision([primary]),
        request: canonicalRequest(),
        providers: registry(hanging),
        policy: { ...defaultFallbackPolicy, maxTotalDurationMs: 50 },
        circuits: new CircuitBreakerRegistry(defaultCircuitBreakerPolicy),
        priceBookVersion: "test-prices",
      }),
    ).rejects.toThrow("retry budget expired");

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});

class ScriptedProvider implements ProviderAdapter {
  public executions = 0;

  public constructor(
    public readonly name: string,
    private readonly definition: ModelDefinition,
    private readonly script: () => AsyncIterable<CanonicalEvent>,
  ) {}

  public models(): Promise<ModelDefinition[]> {
    return Promise.resolve([this.definition]);
  }

  public capabilities(): CapabilitySet {
    return this.definition.capabilities;
  }

  public estimateTokens(): Promise<TokenEstimate> {
    return Promise.resolve({ inputTokens: 100, expectedOutputTokens: 50 });
  }

  public execute(): AsyncIterable<CanonicalEvent> {
    this.executions += 1;
    return this.script();
  }

  public health(): Promise<HealthStatus> {
    return Promise.resolve({
      healthy: true,
      observedAt: "2026-07-28T00:00:00.000Z",
    });
  }
}

class MemoryAttemptStore implements AttemptStore {
  public readonly initialAttempts: StartAttemptInput[] = [];
  public readonly fallbackAttempts: StartFallbackAttemptInput[] = [];
  public readonly failedAttempts: FailAttemptInput[] = [];
  public readonly completedAttempts: CompleteAttemptInput[] = [];

  public start(input: StartAttemptInput): Promise<{ attemptId: string }> {
    this.initialAttempts.push(input);
    return Promise.resolve({ attemptId: "attempt-1" });
  }

  public startFallback(input: StartFallbackAttemptInput): Promise<{ attemptId: string }> {
    this.fallbackAttempts.push(input);
    return Promise.resolve({ attemptId: `attempt-${this.fallbackAttempts.length + 1}` });
  }

  public responseStarted(): Promise<void> {
    return Promise.resolve();
  }

  public firstToken(): Promise<void> {
    return Promise.resolve();
  }

  public complete(input: CompleteAttemptInput): Promise<void> {
    this.completedAttempts.push(input);
    return Promise.resolve();
  }

  public fail(input: FailAttemptInput): Promise<void> {
    this.failedAttempts.push(input);
    return Promise.resolve();
  }
}

class HangingProvider implements ProviderAdapter {
  public readonly name = primary.provider;

  public constructor(private readonly definition: ModelDefinition) {}

  public models(): Promise<ModelDefinition[]> {
    return Promise.resolve([this.definition]);
  }

  public capabilities(): CapabilitySet {
    return this.definition.capabilities;
  }

  public estimateTokens(): Promise<TokenEstimate> {
    return Promise.resolve({ inputTokens: 100, expectedOutputTokens: 50 });
  }

  public execute(
    _model: string,
    _request: CanonicalRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CanonicalEvent> {
    return hangingEvents(signal);
  }

  public health(): Promise<HealthStatus> {
    return Promise.resolve({ healthy: true, observedAt: "2026-07-28T00:00:00.000Z" });
  }
}

function failingProvider(name: string, definition: ModelDefinition): ScriptedProvider {
  return new ScriptedProvider(name, definition, () =>
    throwingEvents([], new ProviderError("unavailable", "upstream", true)),
  );
}

function registry(...providers: ProviderAdapter[]): ProviderRegistry {
  const value = new ProviderRegistry();
  for (const provider of providers) {
    value.register(provider);
  }
  return value;
}

function decision(models: ModelDefinition[]): RoutingDecision {
  const selected = models[0]!;
  return {
    decisionId: "route-request-1",
    requestId: "request-1",
    routerVersion: "test-router",
    mode: "balanced",
    task: {
      taskClass: "code_generation",
      difficulty: 2,
      confidence: 0.9,
      signals: {
        promptCharacters: 10,
        messageCount: 1,
        estimatedInputTokens: 10,
        toolCount: 0,
        hasImages: false,
        fileCount: 0,
        turnCount: 0,
        previousToolErrors: 0,
        previousTestFailures: 0,
        matchedRules: [],
      },
    },
    selectedModel: selected,
    candidates: models.map((candidate, index) => ({
      model: candidate,
      eligible: true,
      filterReasons: [],
      estimatedCostUsd: index + 1,
      score: {
        expectedSuccess: 0.8,
        normalizedCost: 0.2,
        normalizedLatency: 0.2,
        failureRisk: 0,
        sessionSwitchPenalty: 0,
        total: 1 - index / 10,
      },
    })),
    explanation: { summary: "selected", selectedReasons: [], rejected: [] },
  };
}

function canonicalRequest(): CanonicalRequest {
  return {
    requestId: "request-1",
    messages: [{ role: "user", content: [{ type: "text", text: "Implement a feature" }] }],
    tools: [],
    maxOutputTokens: 100,
    routingMode: "balanced",
    constraints: { requiredCapabilities: [] },
    metadata: {},
  };
}

function model(id: string, provider: string, qualityTier: number): ModelDefinition {
  return {
    id,
    provider,
    upstreamModel: `${id}-upstream`,
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
    qualityTier,
    expectedLatencyTier: 2,
    pricing: {
      currency: "USD",
      effectiveFrom: "2026-07-28",
      verifiedAt: "2026-07-28",
      source: "fallback test",
      inputPerMillion: 1,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 4,
    },
  };
}

function started(definition: ModelDefinition): CanonicalEvent {
  return {
    type: "response.started",
    responseId: `response-${definition.id}`,
    provider: definition.provider,
    model: definition.upstreamModel,
    inputTokens: 10,
  };
}

function failed(errorType: string, message: string, retryable: boolean): CanonicalEvent {
  return { type: "response.failed", errorType, message, retryable };
}

function completed(): CanonicalEvent {
  return {
    type: "response.completed",
    finishReason: "end_turn",
    usage: {
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
    },
  };
}

async function* events(...values: CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  await Promise.resolve();
  for (const value of values) {
    yield value;
  }
}

async function* throwingEvents(
  values: CanonicalEvent[],
  error: Error,
): AsyncIterable<CanonicalEvent> {
  await Promise.resolve();
  for (const value of values) {
    yield value;
  }
  throw error;
}

async function* hangingEvents(signal?: AbortSignal): AsyncIterable<CanonicalEvent> {
  await new Promise<void>((_resolve, reject) => {
    if (!signal) {
      reject(new Error("Missing abort signal."));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted."));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted.")),
      { once: true },
    );
  });
  yield completed();
}

async function collect(eventsToCollect: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const result: CanonicalEvent[] = [];
  for await (const event of eventsToCollect) {
    result.push(event);
  }
  return result;
}
