import { routerConfigSchema } from "@vartma/config";
import type {
  RequestUsageReport,
  UsageAnalyticsReport,
  UsageAnalyticsStore,
} from "@vartma/database";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { parseUsageAnalyticsQuery } from "../src/usage.js";

describe("usage analytics API", () => {
  it("authenticates, validates, and forwards bounded analytics queries", async () => {
    const store = usageStore();
    const app = createApp({
      config: config(),
      usageAnalyticsStore: store,
      logger: pino({ level: "silent" }),
    });

    expect((await request(app).get("/vartma/v1/usage")).status).toBe(401);
    const response = await request(app)
      .get(
        "/vartma/v1/usage?from=2026-07-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z&provider=openai&group_by=provider",
      )
      .set("x-api-key", "usage-test-key");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totals: {
        actualAttemptCostUsd: "0.006",
        failedAttemptCostUsd: "0.002",
        baselineCostUsd: "0.01",
        savingsUsd: "0.004",
      },
    });
    expect(store.query).toHaveBeenCalledWith({
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-08-01T00:00:00.000Z"),
      provider: "openai",
      groupBy: "provider",
    });

    const invalid = await request(app)
      .get("/vartma/v1/usage?from=2026-08-01&to=2026-07-01")
      .set("authorization", "Bearer usage-test-key");
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.message).toContain("earlier");
    expect(store.query).toHaveBeenCalledTimes(1);
  });

  it("returns a request ledger or a stable not-found response", async () => {
    const store = usageStore();
    const app = createApp({
      config: config(),
      usageAnalyticsStore: store,
      logger: pino({ level: "silent" }),
    });

    const found = await request(app)
      .get("/vartma/v1/usage/requests/request_1")
      .set("x-api-key", "usage-test-key");
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      requestId: "request_1",
      totals: {
        actualAttemptCostUsd: "0.006",
        failedAttemptCostUsd: "0.002",
      },
    });

    const missing = await request(app)
      .get("/vartma/v1/usage/requests/missing")
      .set("x-api-key", "usage-test-key");
    expect(missing.status).toBe(404);
    expect(missing.body.error.type).toBe("not_found_error");
  });

  it("uses a 30-day default range and rejects ranges over 366 days", () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    expect(parseUsageAnalyticsQuery({}, now)).toEqual({
      from: new Date("2026-06-28T12:00:00.000Z"),
      to: now,
      groupBy: "model",
    });
    expect(() =>
      parseUsageAnalyticsQuery(
        {
          from: "2025-01-01T00:00:00.000Z",
          to: "2026-07-28T00:00:00.000Z",
        },
        now,
      ),
    ).toThrow("cannot exceed 366 days");
  });
});

function usageStore() {
  return {
    query: vi.fn<UsageAnalyticsStore["query"]>(() => Promise.resolve(analyticsReport())),
    request: vi.fn<UsageAnalyticsStore["request"]>((requestId) =>
      Promise.resolve(requestId === "request_1" ? requestReport() : undefined),
    ),
  };
}

function analyticsReport(): UsageAnalyticsReport {
  return {
    range: {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-01T00:00:00.000Z",
    },
    filters: { provider: "openai" },
    currency: "USD",
    totals: {
      requestCount: 1,
      completedRequestCount: 1,
      failedRequestCount: 0,
      cancelledRequestCount: 0,
      attemptCount: 2,
      comparableRequestCount: 1,
      inputTokens: "100",
      cachedInputTokens: "20",
      outputTokens: "30",
      reasoningTokens: "5",
      actualAttemptCostUsd: "0.006",
      failedAttemptCostUsd: "0.002",
      baselineCostUsd: "0.01",
      savingsUsd: "0.004",
      savingsPercent: "40.0000",
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
    distribution: [],
  };
}

function requestReport(): RequestUsageReport {
  return {
    requestId: "request_1",
    sessionId: null,
    routingMode: "balanced",
    status: "COMPLETED",
    selectedProvider: "openai",
    selectedModel: "openai/default",
    startedAt: "2026-07-28T00:00:00.000Z",
    completedAt: "2026-07-28T00:00:01.000Z",
    baseline: null,
    attempts: [],
    totals: {
      actualAttemptCostUsd: "0.006",
      failedAttemptCostUsd: "0.002",
      baselineCostUsd: null,
      savingsUsd: null,
      savingsPercent: null,
    },
  };
}

function config() {
  return routerConfigSchema.parse({
    environment: "test",
    server: {
      host: "127.0.0.1",
      port: 8080,
      trustProxy: false,
      requestBodyLimitBytes: 1_048_576,
    },
    auth: { enabled: true, apiKeys: ["usage-test-key"] },
    database: {
      url: "postgresql://vartma:secret@localhost:5432/vartma",
      requiredForReadiness: false,
    },
    routing: {
      defaultMode: "balanced",
      defaultModel: "fake/default",
      baselineModel: "fake/default",
      routerVersion: "usage-test",
    },
    providers: [
      {
        id: "fake",
        type: "fake",
        enabled: true,
        models: [
          {
            id: "fake/default",
            provider: "fake",
            upstreamModel: "fake-default",
            enabled: true,
            capabilities: {
              text: true,
              vision: false,
              streaming: true,
              tools: true,
              structuredOutput: true,
              reasoning: false,
            },
            contextWindow: 32_000,
            maxOutputTokens: 4_096,
            qualityTier: 1,
            expectedLatencyTier: 1,
            pricing: {
              currency: "USD",
              effectiveFrom: "2026-07-28",
              verifiedAt: "2026-07-28",
              source: "usage test",
              inputPerMillion: 0,
              cachedInputPerMillion: 0,
              outputPerMillion: 0,
            },
          },
        ],
      },
    ],
    telemetry: {
      serviceName: "usage-test",
      logLevel: "error",
      langSmith: {
        enabled: false,
        apiKeyEnv: "LANGSMITH_API_KEY",
        project: "test",
        exportContent: false,
      },
    },
  });
}
