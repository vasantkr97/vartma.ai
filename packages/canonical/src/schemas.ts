import { z } from "zod";

import { ROUTING_MODES } from "./types.js";

export const routingModeSchema = z.enum(ROUTING_MODES);

export const capabilitySetSchema = z
  .object({
    text: z.boolean(),
    vision: z.boolean(),
    streaming: z.boolean(),
    tools: z.boolean(),
    structuredOutput: z.boolean(),
    reasoning: z.boolean(),
  })
  .strict();

export const modelPricingSchema = z
  .object({
    currency: z.literal("USD").default("USD"),
    effectiveFrom: z.iso.date(),
    verifiedAt: z.iso.date(),
    source: z.string().min(1),
    inputPerMillion: z.number().nonnegative(),
    cachedInputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
    reasoningPerMillion: z.number().nonnegative().optional(),
  })
  .strict();

export const modelDefinitionSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    upstreamModel: z.string().min(1),
    enabled: z.boolean().default(true),
    capabilities: capabilitySetSchema,
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    qualityTier: z.number().int().min(1).max(5),
    expectedLatencyTier: z.number().int().min(1).max(5),
    expectedLatencyMs: z.number().int().positive().optional(),
    regions: z.array(z.string().min(1)).min(1).optional(),
    pricing: modelPricingSchema,
  })
  .strict();
