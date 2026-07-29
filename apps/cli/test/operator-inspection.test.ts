import type {
  SessionInspection,
  SessionInspectionSummary,
  TraceInspection,
} from "@vartma/database";
import { describe, expect, it } from "vitest";

import {
  formatSessionInspection,
  formatSessionList,
  formatTraceInspection,
} from "../src/operator-inspection.js";

describe("operator inspection formatting", () => {
  it("formats trace routing, fallback, and usage without inventing prompt fields", () => {
    const output = formatTraceInspection(traceFixture());

    expect(output).toContain("Trace request_1");
    expect(output).toContain("Decision: debug via openai/default");
    expect(output).toContain("openai/default -> anthropic/default");
    expect(output).toContain("cached=20");
    expect(output).not.toContain("prompt");
    expect(output).not.toContain("apiKey");
  });

  it("formats session lists and detailed outcomes", () => {
    const summary = sessionSummary();
    const list = formatSessionList([summary]);
    const detail = formatSessionInspection({
      ...summary,
      clientType: "claude-code",
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
      lastEscalatedAt: null,
      cooldownUntil: null,
      recentRequests: [
        {
          id: "request_1",
          status: "COMPLETED",
          selectedProvider: "openai",
          selectedModel: "openai/default",
          routingMode: "balanced",
          startedAt: "2026-07-28T00:00:00.000Z",
          completedAt: "2026-07-28T00:00:01.000Z",
          errorType: null,
        },
      ],
      recentOutcomes: [
        {
          id: "outcome_1",
          requestId: "request_1",
          kind: "success",
          source: "agent",
          escalationLevelBefore: 1,
          escalationLevelAfter: 0,
          metadataKeys: ["testSuite"],
          createdAt: "2026-07-28T00:00:02.000Z",
        },
      ],
    } satisfies SessionInspection);

    expect(list).toContain("session_1 mode=balanced");
    expect(detail).toContain("Client: claude-code");
    expect(detail).toContain("request_1 COMPLETED");
    expect(detail).toContain("success escalation=1->0");
    expect(formatSessionList([])).toBe("No sessions found.\n");
  });
});

function traceFixture(): TraceInspection {
  return {
    id: "request_1",
    sessionId: "session_1",
    clientRequestId: null,
    requestedModel: "vartma-balanced",
    selectedProvider: "anthropic",
    selectedModel: "anthropic/default",
    routingMode: "balanced",
    status: "COMPLETED",
    startedAt: "2026-07-28T00:00:00.000Z",
    completedAt: "2026-07-28T00:00:02.000Z",
    errorType: null,
    errorMessage: null,
    traceLevel: "metadata_only",
    metadataKeys: ["repository"],
    routeDecision: {
      routerVersion: "router-v1",
      taskClass: "debug",
      selectedProvider: "openai",
      selectedModel: "openai/default",
      explanation: { score: 0.8 },
      candidates: [],
      createdAt: "2026-07-28T00:00:00.010Z",
    },
    attempts: [
      {
        id: "attempt_1",
        sequence: 1,
        provider: "openai",
        model: "gpt-test",
        providerRequestId: null,
        status: "FAILED",
        startedAt: "2026-07-28T00:00:00.020Z",
        completedAt: "2026-07-28T00:00:01.000Z",
        firstTokenAt: null,
        errorType: "rate_limit",
        errorMessage: "rate limited",
      },
      {
        id: "attempt_2",
        sequence: 2,
        provider: "anthropic",
        model: "claude-test",
        providerRequestId: null,
        status: "COMPLETED",
        startedAt: "2026-07-28T00:00:01.000Z",
        completedAt: "2026-07-28T00:00:02.000Z",
        firstTokenAt: "2026-07-28T00:00:01.100Z",
        errorType: null,
        errorMessage: null,
      },
    ],
    switches: [
      {
        sequence: 2,
        fromProvider: "openai",
        fromModel: "openai/default",
        toProvider: "anthropic",
        toModel: "anthropic/default",
        reason: "rate limit",
        trigger: "fallback",
        createdAt: "2026-07-28T00:00:01.000Z",
      },
    ],
    usage: [
      {
        provider: "anthropic",
        model: "claude-test",
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 30,
        reasoningTokens: 0,
        estimatedCostUsd: "0.001",
        currency: "USD",
        priceBookVersion: "2026-07-28",
        createdAt: "2026-07-28T00:00:02.000Z",
      },
    ],
  };
}

function sessionSummary(): SessionInspectionSummary {
  return {
    id: "session_1",
    routingMode: "balanced",
    currentProvider: "openai",
    currentModel: "openai/default",
    escalationLevel: 0,
    turnCount: 7,
    consecutiveFailures: 0,
    successfulOutcomes: 4,
    accumulatedCostUsd: "0.01",
    inputTokens: "100",
    cachedInputTokens: "20",
    outputTokens: "30",
    reasoningTokens: "5",
    lastTaskClass: "debug",
    lastActivityAt: "2026-07-28T00:00:00.000Z",
  };
}
