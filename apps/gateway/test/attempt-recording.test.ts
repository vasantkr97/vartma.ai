import type { CanonicalEvent, CanonicalRequest, ModelDefinition } from "@vartma/canonical";
import type {
  AttemptStore,
  CompleteAttemptInput,
  FailAttemptInput,
  StartFallbackAttemptInput,
  StartAttemptInput,
} from "@vartma/database";
import type { RoutingDecision } from "@vartma/routing";
import { describe, expect, it } from "vitest";

import { estimateCost, recordProviderAttempt } from "../src/attempt-recording.js";

const model: ModelDefinition = {
  id: "openai/default",
  provider: "openai",
  upstreamModel: "gpt-test",
  enabled: true,
  capabilities: {
    text: true,
    vision: true,
    streaming: true,
    tools: true,
    structuredOutput: true,
    reasoning: true,
  },
  contextWindow: 100_000,
  maxOutputTokens: 4096,
  qualityTier: 3,
  expectedLatencyTier: 3,
  pricing: {
    currency: "USD",
    effectiveFrom: "2026-07-23",
    verifiedAt: "2026-07-23",
    source: "attempt-recording test fixture",
    inputPerMillion: 2,
    cachedInputPerMillion: 0.5,
    outputPerMillion: 8,
    reasoningPerMillion: 10,
  },
};

const request: CanonicalRequest = {
  requestId: "request-recording-1",
  sessionId: "session-1",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  requestedModel: "openai/default",
  maxOutputTokens: 128,
  routingMode: "balanced",
  constraints: { requiredCapabilities: [] },
  metadata: { source: "test" },
};

class MemoryAttemptStore implements AttemptStore {
  public started: StartAttemptInput | undefined;
  public providerRequestId: string | undefined;
  public firstTokenCount = 0;
  public completed: CompleteAttemptInput | undefined;
  public failed: FailAttemptInput | undefined;

  public start(input: StartAttemptInput): Promise<{ attemptId: string }> {
    this.started = input;
    return Promise.resolve({ attemptId: "attempt-1" });
  }

  public startFallback(input: StartFallbackAttemptInput): Promise<{ attemptId: string }> {
    void input;
    return Promise.resolve({ attemptId: "fallback-attempt-1" });
  }

  public responseStarted(_attemptId: string, providerRequestId: string): Promise<void> {
    this.providerRequestId = providerRequestId;
    return Promise.resolve();
  }

  public firstToken(): Promise<void> {
    this.firstTokenCount += 1;
    return Promise.resolve();
  }

  public complete(input: CompleteAttemptInput): Promise<void> {
    this.completed = input;
    return Promise.resolve();
  }

  public fail(input: FailAttemptInput): Promise<void> {
    this.failed = input;
    return Promise.resolve();
  }
}

describe("provider-attempt recording", () => {
  it("stores one completed usage ledger entry with cost", async () => {
    const store = new MemoryAttemptStore();
    const usage = {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
      reasoningTokens: 10,
    };
    const events: CanonicalEvent[] = [
      {
        type: "response.started",
        responseId: "resp-upstream-1",
        provider: "openai",
        model: "gpt-test",
        inputTokens: 100,
      },
      { type: "content.started", index: 0, contentType: "text" },
      { type: "text.delta", index: 0, text: "hello" },
      { type: "text.delta", index: 0, text: " again" },
      { type: "content.completed", index: 0 },
      { type: "response.completed", finishReason: "end_turn", usage },
    ];

    const received = await collect(
      recordProviderAttempt(fromArray(events), {
        store,
        request,
        model,
        clientRequestId: "client-request-1",
        priceBookVersion: "price-v1",
        routingDecision: decision(),
      }),
    );

    expect(received).toEqual(events);
    expect(store.started).toMatchObject({
      requestId: "request-recording-1",
      sessionId: "session-1",
      selectedProvider: "openai",
      selectedModel: "openai/default",
      routeDecision: {
        routerVersion: "router-v1",
        taskClass: "code_generation",
        selectedModel: "openai/default",
      },
      costBaseline: {
        priceBookVersion: "price-v1",
        provider: "openai",
        model: "openai/default",
        estimatedCostUsd: 0.001,
      },
      initialSwitch: {
        fromProvider: "anthropic",
        fromModel: "anthropic/previous",
        toProvider: "openai",
        toModel: "openai/default",
        reason: "previous session model is no longer eligible",
        trigger: "session_policy",
      },
    });
    expect(store.providerRequestId).toBe("resp-upstream-1");
    expect(store.firstTokenCount).toBe(1);
    expect(store.completed).toMatchObject({
      requestId: "request-recording-1",
      attemptId: "attempt-1",
      usage,
      priceBookVersion: "price-v1",
    });
    expect(store.completed?.estimatedCostUsd).toBe(0.00063);
    expect(store.failed).toBeUndefined();
  });

  it("stores a failed terminal event", async () => {
    const store = new MemoryAttemptStore();
    const events: CanonicalEvent[] = [
      {
        type: "response.started",
        responseId: "resp-upstream-2",
        provider: "openai",
        model: "gpt-test",
        inputTokens: 3,
      },
      {
        type: "usage.updated",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningTokens: 1,
        },
      },
      {
        type: "response.failed",
        errorType: "server_error",
        message: "generation failed",
        retryable: false,
      },
    ];

    await collect(
      recordProviderAttempt(fromArray(events), {
        store,
        request: { ...request, requestId: "request-recording-2" },
        model,
        priceBookVersion: "price-v1",
      }),
    );

    expect(store.failed).toMatchObject({
      requestId: "request-recording-2",
      attemptId: "attempt-1",
      status: "FAILED",
      errorType: "server_error",
      errorMessage: "generation failed",
      provider: "openai",
      model: "openai/default",
      upstreamModel: "gpt-test",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
        reasoningTokens: 1,
      },
      estimatedCostUsd: 0.000055,
      priceBookVersion: "price-v1",
    });
    expect(store.completed).toBeUndefined();
  });

  it("does not double-charge reasoning tokens as normal output", () => {
    expect(
      estimateCost(
        {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 100,
          reasoningTokens: 20,
        },
        model,
      ),
    ).toBe(0.00084);
  });
});

function decision(): RoutingDecision {
  return {
    decisionId: "route_request-recording-1",
    requestId: "request-recording-1",
    routerVersion: "router-v1",
    mode: "balanced",
    task: {
      taskClass: "code_generation",
      difficulty: 2,
      confidence: 0.8,
      signals: {
        promptCharacters: 5,
        messageCount: 1,
        estimatedInputTokens: 2,
        toolCount: 0,
        hasImages: false,
        fileCount: 0,
        turnCount: 0,
        previousToolErrors: 0,
        previousTestFailures: 0,
        matchedRules: ["code generation intent"],
      },
    },
    selectedModel: model,
    candidates: [
      {
        model,
        eligible: true,
        filterReasons: [],
        tokenEstimate: { inputTokens: 100, expectedOutputTokens: 50 },
        estimatedCostUsd: 0.001,
        health: {
          healthy: true,
          observedAt: new Date(0).toISOString(),
          latencyMs: 10,
        },
        score: {
          expectedSuccess: 0.8,
          normalizedCost: 1,
          normalizedLatency: 0.5,
          failureRisk: 0,
          sessionSwitchPenalty: 0,
          total: 0.5,
        },
      },
    ],
    explanation: {
      summary: "Selected openai/default.",
      selectedReasons: ["best balanced score"],
      rejected: [],
    },
    baseline: {
      model,
      tokenEstimate: { inputTokens: 100, expectedOutputTokens: 100 },
      estimatedCostUsd: 0.001,
    },
    session: {
      previousProvider: "anthropic",
      previousModel: "anthropic/previous",
      escalationLevel: 1,
      stickySelection: false,
      switchReason: "previous session model is no longer eligible",
    },
  };
}

async function* fromArray(events: CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  await Promise.resolve();
  for (const event of events) {
    yield event;
  }
}

async function collect(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const result: CanonicalEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}
