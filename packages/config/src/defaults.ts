import { routerConfigSchema, type RouterConfig } from "./schema.js";

export function createDefaultRouterConfig(now: Date = new Date()): RouterConfig {
  const date = now.toISOString().slice(0, 10);
  return routerConfigSchema.parse({
    environment: "development",
    server: {},
    auth: {
      enabled: false,
      apiKeys: [],
    },
    database: {
      url: "postgresql://vartma:vartma@localhost:5432/vartma?schema=public",
      requiredForReadiness: false,
    },
    routing: {
      defaultMode: "balanced",
      defaultModel: "fake/default",
      baselineModel: "fake/default",
      routerVersion: "deterministic-v1",
      priceBookVersion: `local-${date}`,
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
            contextWindow: 100_000,
            maxOutputTokens: 4_096,
            qualityTier: 1,
            expectedLatencyTier: 1,
            pricing: {
              currency: "USD",
              effectiveFrom: date,
              verifiedAt: date,
              source: "vartma deterministic local provider",
              inputPerMillion: 0,
              cachedInputPerMillion: 0,
              outputPerMillion: 0,
            },
          },
        ],
      },
    ],
    telemetry: {},
  });
}
