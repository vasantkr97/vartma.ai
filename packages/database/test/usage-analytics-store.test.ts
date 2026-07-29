import { describe, expect, it, vi } from "vitest";

import { PrismaUsageAnalyticsStore, type RouterDatabase } from "../src/index.js";

describe("PrismaUsageAnalyticsStore", () => {
  it("includes failed fallback attempts while limiting savings to requests with a baseline", async () => {
    const requests = [completedRequest(), failedRequest()];
    const database = {
      request: {
        findMany: vi.fn(() => Promise.resolve(requests)),
        findUnique: vi.fn(),
      },
    } as unknown as RouterDatabase;

    const report = await new PrismaUsageAnalyticsStore(database).query({
      from: date("2026-07-01T00:00:00.000Z"),
      to: date("2026-08-01T00:00:00.000Z"),
      groupBy: "model",
    });

    expect(report).toMatchObject({
      currency: "USD",
      totals: {
        requestCount: 2,
        completedRequestCount: 1,
        failedRequestCount: 1,
        cancelledRequestCount: 0,
        attemptCount: 3,
        comparableRequestCount: 1,
        inputTokens: "180",
        cachedInputTokens: "20",
        outputTokens: "45",
        reasoningTokens: "5",
        actualAttemptCostUsd: "0.006",
        failedAttemptCostUsd: "0.003",
        baselineCostUsd: "0.01",
        savingsUsd: "0.005",
        savingsPercent: "50.0000",
      },
      baselines: [
        {
          provider: "frontier",
          model: "frontier/baseline",
          priceBookVersion: "prices-v1",
          requestCount: 1,
          estimatedCostUsd: "0.01",
        },
      ],
    });
    expect(report.distribution).toEqual([
      {
        key: "cheap/model",
        requestCount: 2,
        completedRequestCount: 1,
        attemptCount: 2,
        inputTokens: "130",
        cachedInputTokens: "20",
        outputTokens: "15",
        reasoningTokens: "0",
        actualAttemptCostUsd: "0.003",
        failedAttemptCostUsd: "0.003",
      },
      {
        key: "strong/model",
        requestCount: 1,
        completedRequestCount: 1,
        attemptCount: 1,
        inputTokens: "50",
        cachedInputTokens: "0",
        outputTokens: "30",
        reasoningTokens: "5",
        actualAttemptCostUsd: "0.003",
        failedAttemptCostUsd: "0",
      },
    ]);
    expect(
      (database.request.findMany as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
    ).toMatchObject({
      where: {
        startedAt: {
          gte: date("2026-07-01T00:00:00.000Z"),
          lt: date("2026-08-01T00:00:00.000Z"),
        },
      },
      take: 500,
    });
  });

  it("returns per-request immutable price evidence and retry-inclusive savings", async () => {
    const request = {
      ...completedRequest(),
      usageEvents: completedRequest().usageEvents.map((usage, index) => ({
        ...usage,
        providerAttemptId: `attempt_${String(index + 1)}`,
        providerAttempt: { sequence: index + 1 },
        upstreamModel: index === 0 ? "cheap-upstream" : "strong-upstream",
        toolCost: decimal("0"),
        currency: "USD",
        priceBookVersion: "prices-v1",
        inputPricePerMillion: decimal(index === 0 ? "1" : "2"),
        cachedInputPricePerMillion: decimal("0.1"),
        outputPricePerMillion: decimal(index === 0 ? "4" : "8"),
        reasoningPricePerMillion: decimal(index === 0 ? "4" : "10"),
        pricingSource: "https://pricing.example/test",
        pricingEffectiveFrom: date("2026-07-01T00:00:00.000Z"),
        pricingVerifiedAt: date("2026-07-28T00:00:00.000Z"),
        createdAt: date(`2026-07-28T00:00:0${String(index + 1)}.000Z`),
      })),
    };
    const database = {
      request: {
        findMany: vi.fn(),
        findUnique: vi.fn(() => Promise.resolve(request)),
      },
    } as unknown as RouterDatabase;

    const report = await new PrismaUsageAnalyticsStore(database).request("request_1");

    expect(report).toMatchObject({
      requestId: "request_1",
      status: "COMPLETED",
      baseline: {
        model: "frontier/baseline",
        estimatedCostUsd: "0.010000000000",
        priceBookVersion: "prices-v1",
      },
      attempts: [
        {
          attemptId: "attempt_1",
          sequence: 1,
          status: "FAILED",
          calculatedCostUsd: "0.002000000000",
          pricesPerMillion: {
            input: "1",
            output: "4",
          },
          pricingSource: "https://pricing.example/test",
        },
        {
          attemptId: "attempt_2",
          sequence: 2,
          status: "COMPLETED",
          calculatedCostUsd: "0.003000000000",
        },
      ],
      totals: {
        actualAttemptCostUsd: "0.005",
        failedAttemptCostUsd: "0.002",
        baselineCostUsd: "0.01",
        savingsUsd: "0.005",
        savingsPercent: "50.0000",
      },
    });
    expect(JSON.stringify(report)).not.toContain("prompt");
  });
});

function completedRequest() {
  return {
    id: "request_1",
    sessionId: "session_1",
    routingMode: "balanced",
    status: "COMPLETED",
    selectedProvider: "strong",
    selectedModel: "strong/model",
    startedAt: date("2026-07-28T00:00:00.000Z"),
    completedAt: date("2026-07-28T00:00:03.000Z"),
    costBaseline: {
      provider: "frontier",
      model: "frontier/baseline",
      upstreamModel: "frontier-upstream",
      inputTokens: 100,
      expectedOutputTokens: 50,
      estimatedCost: decimal("0.010000000000"),
      currency: "USD",
      priceBookVersion: "prices-v1",
    },
    usageEvents: [
      usage("cheap", "cheap/model", "FAILED", 80, 20, 10, 0, "0.002000000000"),
      usage("strong", "strong/model", "COMPLETED", 50, 0, 30, 5, "0.003000000000"),
    ],
  };
}

function failedRequest() {
  return {
    id: "request_2",
    sessionId: null,
    routingMode: "eco",
    status: "FAILED",
    selectedProvider: "cheap",
    selectedModel: "cheap/model",
    startedAt: date("2026-07-28T01:00:00.000Z"),
    completedAt: date("2026-07-28T01:00:01.000Z"),
    costBaseline: null,
    usageEvents: [usage("cheap", "cheap/model", "FAILED", 50, 0, 5, 0, "0.001000000000")],
  };
}

function usage(
  provider: string,
  model: string,
  attemptStatus: "COMPLETED" | "FAILED",
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  cost: string,
) {
  return {
    provider,
    model,
    attemptStatus,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    estimatedCost: decimal(cost),
    toolCost: decimal("0"),
  };
}

function decimal(value: string): { toString(): string; toFixed(): string } {
  return {
    toString: () => value,
    toFixed: () => value,
  };
}

function date(value: string): Date {
  return new Date(value);
}
