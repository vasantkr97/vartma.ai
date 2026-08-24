import { describe, expect, it, vi } from "vitest";

import { PrismaInspectionStore, type RouterDatabase } from "../src/index.js";

describe("PrismaInspectionStore", () => {
  it("returns an operational trace while redacting secrets and omitting metadata values", async () => {
    const database = {
      request: {
        findUnique: vi.fn(() =>
          Promise.resolve({
            id: "request_1",
            sessionId: "session_1",
            clientRequestId: "client_1",
            requestedModel: "vartma-balanced",
            selectedProvider: "openai",
            selectedModel: "openai/default",
            routingMode: "balanced",
            status: "FAILED",
            startedAt: date("2026-07-28T00:00:00.000Z"),
            completedAt: date("2026-07-28T00:00:02.000Z"),
            errorType: "provider_error",
            errorMessage: "Bearer provider-secret api_key=another-secret sk-abcdefghijk",
            traceLevel: "metadata_only",
            metadata: { repository: "router", apiKey: "must-not-leak" },
            routeDecision: {
              routerVersion: "router-v1",
              taskClass: "debug",
              selectedProvider: "openai",
              selectedModel: "openai/default",
              explanation: {
                score: 0.8,
                token: "route-secret",
                nested: { authorization: "Bearer nested-secret" },
              },
              candidates: [{ model: "openai/default", api_key: "candidate-secret" }],
              createdAt: date("2026-07-28T00:00:00.010Z"),
            },
            attempts: [
              {
                id: "attempt_1",
                sequence: 1,
                provider: "openai",
                model: "gpt-test",
                providerRequestId: "provider_request_1",
                status: "FAILED",
                startedAt: date("2026-07-28T00:00:00.020Z"),
                completedAt: date("2026-07-28T00:00:02.000Z"),
                firstTokenAt: null,
                errorType: "authentication_error",
                errorMessage: "token=attempt-secret",
              },
            ],
            routeSwitches: [
              {
                sequence: 2,
                fromProvider: "openai",
                fromModel: "openai/default",
                toProvider: "anthropic",
                toModel: "anthropic/default",
                reason: "provider failure",
                trigger: "fallback",
                createdAt: date("2026-07-28T00:00:01.000Z"),
              },
            ],
            usageEvents: [
              {
                provider: "openai",
                model: "gpt-test",
                inputTokens: 10,
                cachedInputTokens: 2,
                outputTokens: 4,
                reasoningTokens: 1,
                estimatedCost: decimal("0.00012"),
                currency: "USD",
                priceBookVersion: "2026-07-28",
                createdAt: date("2026-07-28T00:00:02.000Z"),
              },
            ],
          }),
        ),
      },
      session: { findMany: vi.fn(), findUnique: vi.fn() },
    } as unknown as RouterDatabase;

    const trace = await new PrismaInspectionStore(database).trace("request_1");

    expect(trace).toMatchObject({
      id: "request_1",
      metadataKeys: ["apiKey", "repository"],
      errorMessage: "Bearer [REDACTED] api_key=[REDACTED] [REDACTED]",
      routeDecision: {
        explanation: {
          score: 0.8,
          token: "[REDACTED]",
          nested: { authorization: "[REDACTED]" },
        },
        candidates: [{ model: "openai/default", api_key: "[REDACTED]" }],
      },
      attempts: [{ errorMessage: "token=[REDACTED]" }],
      usage: [{ estimatedCostUsd: "0.00012" }],
    });
    const serialized = JSON.stringify(trace);
    for (const secret of [
      "provider-secret",
      "another-secret",
      "abcdefghijk",
      "must-not-leak",
      "route-secret",
      "nested-secret",
      "candidate-secret",
      "attempt-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("lists and inspects sessions with JSON-safe token and decimal values", async () => {
    const baseSession = {
      id: "session_1",
      clientType: "claude-code",
      routingMode: "balanced",
      currentProvider: "anthropic",
      currentModel: "anthropic/default",
      escalationLevel: 1,
      turnCount: 7,
      consecutiveFailures: 0,
      successfulOutcomes: 4,
      accumulatedCost: decimal("0.1234"),
      inputTokens: 100n,
      cachedInputTokens: 50n,
      outputTokens: 30n,
      reasoningTokens: 5n,
      lastTaskClass: "debug",
      createdAt: date("2026-07-27T00:00:00.000Z"),
      updatedAt: date("2026-07-28T00:00:00.000Z"),
      lastEscalatedAt: date("2026-07-27T12:00:00.000Z"),
      cooldownUntil: null,
      lastActivityAt: date("2026-07-28T00:00:00.000Z"),
    };
    const database = {
      request: { findUnique: vi.fn() },
      session: {
        findMany: vi.fn(() => Promise.resolve([baseSession])),
        findUnique: vi.fn(() =>
          Promise.resolve({
            ...baseSession,
            requests: [
              {
                id: "request_1",
                status: "COMPLETED",
                selectedProvider: "anthropic",
                selectedModel: "anthropic/default",
                routingMode: "balanced",
                startedAt: date("2026-07-28T00:00:00.000Z"),
                completedAt: date("2026-07-28T00:00:01.000Z"),
                errorType: null,
              },
            ],
            outcomes: [
              {
                id: "outcome_1",
                requestId: "request_1",
                kind: "success",
                source: "agent",
                escalationLevelBefore: 1,
                escalationLevelAfter: 0,
                metadata: { testSuite: "passed", secret: "hidden" },
                createdAt: date("2026-07-28T00:00:02.000Z"),
              },
            ],
          }),
        ),
      },
    } as unknown as RouterDatabase;
    const store = new PrismaInspectionStore(database);

    const listed = await store.sessions(20);
    const detail = await store.session("session_1", 10);

    expect(listed).toEqual([
      expect.objectContaining({
        id: "session_1",
        accumulatedCostUsd: "0.1234",
        inputTokens: "100",
        cachedInputTokens: "50",
      }),
    ]);
    expect(detail).toMatchObject({
      id: "session_1",
      recentRequests: [{ id: "request_1", status: "COMPLETED" }],
      recentOutcomes: [
        {
          id: "outcome_1",
          metadataKeys: ["secret", "testSuite"],
        },
      ],
    });
    expect(JSON.stringify(detail)).not.toContain("hidden");
  });

  it("lists request decisions and failures without prompt or secret content", async () => {
    const findMany = vi.fn(() =>
      Promise.resolve([
        {
          id: "request_2",
          sessionId: "session_2",
          routingMode: "eco",
          status: "FAILED",
          selectedProvider: "deepseek",
          selectedModel: "deepseek/reasoner",
          startedAt: date("2026-08-24T00:00:00.000Z"),
          completedAt: date("2026-08-24T00:00:02.000Z"),
          errorType: "timeout",
          errorMessage: "token=provider-secret request timed out",
          routeDecision: {
            taskClass: "debugging",
            explanation: {
              summary: "Lowest expected cost for this task.",
              selectedReasons: ["Calibrated success probability", "api_key=hidden"],
            },
          },
          _count: { attempts: 2, routeSwitches: 1 },
        },
      ]),
    );
    const database = {
      request: { findMany },
      session: { findMany: vi.fn(), findUnique: vi.fn() },
    } as unknown as RouterDatabase;

    const result = await new PrismaInspectionStore(database).requests(25, true);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ["FAILED", "CANCELLED"] } },
        take: 25,
      }),
    );
    expect(result).toEqual([
      expect.objectContaining({
        id: "request_2",
        taskClass: "debugging",
        attemptCount: 2,
        fallbackCount: 1,
        errorMessage: "token=[REDACTED] request timed out",
        selectedReasons: ["Calibrated success probability", "api_key=[REDACTED]"],
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(JSON.stringify(result)).not.toContain("hidden");
  });
});

function date(value: string): Date {
  return new Date(value);
}

function decimal(value: string): { toString(): string } {
  return { toString: () => value };
}
