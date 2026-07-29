import { z } from "zod";

import type { RoutingPolicies } from "./types.js";

export const routingModePolicySchema = z
  .object({
    minimumQualityTier: z.number().int().min(1).max(5),
    difficultyTierAdjustment: z.number().int().min(-4).max(4),
    qualityWeight: z.number().nonnegative(),
    costWeight: z.number().nonnegative(),
    latencyWeight: z.number().nonnegative(),
    failureWeight: z.number().nonnegative(),
  })
  .strict()
  .refine(
    (policy) =>
      policy.qualityWeight + policy.costWeight + policy.latencyWeight + policy.failureWeight > 0,
    "At least one routing weight must be greater than zero.",
  );

export const defaultRoutingPolicies: RoutingPolicies = {
  quality: {
    minimumQualityTier: 2,
    difficultyTierAdjustment: 0,
    qualityWeight: 0.82,
    costWeight: 0.04,
    latencyWeight: 0.08,
    failureWeight: 0.06,
  },
  balanced: {
    minimumQualityTier: 1,
    difficultyTierAdjustment: -1,
    qualityWeight: 0.55,
    costWeight: 0.25,
    latencyWeight: 0.12,
    failureWeight: 0.08,
  },
  eco: {
    minimumQualityTier: 1,
    difficultyTierAdjustment: -1,
    qualityWeight: 0.2,
    costWeight: 0.68,
    latencyWeight: 0.08,
    failureWeight: 0.04,
  },
  fixed: {
    minimumQualityTier: 1,
    difficultyTierAdjustment: -4,
    qualityWeight: 1,
    costWeight: 0,
    latencyWeight: 0,
    failureWeight: 0,
  },
};

export const routingPoliciesSchema = z
  .object({
    quality: routingModePolicySchema.default(defaultRoutingPolicies.quality),
    balanced: routingModePolicySchema.default(defaultRoutingPolicies.balanced),
    eco: routingModePolicySchema.default(defaultRoutingPolicies.eco),
    fixed: routingModePolicySchema.default(defaultRoutingPolicies.fixed),
  })
  .strict()
  .default(defaultRoutingPolicies);
