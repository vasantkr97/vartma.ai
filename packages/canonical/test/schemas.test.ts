import { describe, expect, it } from "vitest";

import { modelDefinitionSchema, routingModeSchema } from "../src/index.js";

const validModelDefinition = {
  id: "model-a",
  provider: "provider-a",
  upstreamModel: "upstream-model-a",
  enabled: true,
  capabilities: {
    text: true,
    vision: false,
    streaming: true,
    tools: true,
    structuredOutput: true,
    reasoning: false,
  },
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  qualityTier: 2,
  expectedLatencyTier: 2,
  pricing: {
    currency: "USD",
    effectiveFrom: "2026-07-23",
    verifiedAt: "2026-07-23",
    source: "provider pricing page",
    inputPerMillion: 1,
    cachedInputPerMillion: 0.1,
    outputPerMillion: 5,
  },
} as const;

describe("canonical schemas", () => {
  it("accepts supported routing modes", () => {
    expect(routingModeSchema.parse("balanced")).toBe("balanced");
    expect(() => routingModeSchema.parse("unknown")).toThrow();
  });

  it("rejects an incomplete model definition", () => {
    expect(() => modelDefinitionSchema.parse({ id: "model-a" })).toThrow();
  });

  it("accepts a model definition with auditable pricing provenance", () => {
    expect(modelDefinitionSchema.parse(validModelDefinition).pricing).toMatchObject({
      effectiveFrom: "2026-07-23",
      verifiedAt: "2026-07-23",
      source: "provider pricing page",
    });
  });

  it.each([
    ["missing effective date", { effectiveFrom: undefined }],
    ["invalid verification date", { verifiedAt: "23 July 2026" }],
    ["empty source", { source: "" }],
  ])("rejects pricing with %s", (_description, pricingPatch) => {
    expect(() =>
      modelDefinitionSchema.parse({
        ...validModelDefinition,
        pricing: {
          ...validModelDefinition.pricing,
          ...pricingPatch,
        },
      }),
    ).toThrow();
  });
});
