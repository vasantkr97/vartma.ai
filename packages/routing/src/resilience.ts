import { z } from "zod";

export interface SessionRoutingPolicy {
  enabled: boolean;
  switchPenalty: number;
  switchScoreThreshold: number;
  escalationFailureThreshold: number;
  maxEscalationLevel: number;
  successfulOutcomesToDeescalate: number;
  deescalationCooldownMs: number;
  automaticStuckVerdictTtlMs: number;
}

export interface FallbackPolicy {
  enabled: boolean;
  maxAttempts: number;
  maxTotalDurationMs: number;
  allowWeakerFallback: boolean;
}

export interface CircuitBreakerPolicy {
  failureThreshold: number;
  openDurationMs: number;
  halfOpenSuccessThreshold: number;
}

export const defaultSessionRoutingPolicy: SessionRoutingPolicy = {
  enabled: true,
  switchPenalty: 0.08,
  switchScoreThreshold: 0.06,
  escalationFailureThreshold: 2,
  maxEscalationLevel: 4,
  successfulOutcomesToDeescalate: 3,
  deescalationCooldownMs: 5 * 60 * 1000,
  automaticStuckVerdictTtlMs: 10 * 60 * 1000,
};

export const defaultFallbackPolicy: FallbackPolicy = {
  enabled: true,
  maxAttempts: 3,
  maxTotalDurationMs: 60_000,
  allowWeakerFallback: true,
};

export const defaultCircuitBreakerPolicy: CircuitBreakerPolicy = {
  failureThreshold: 3,
  openDurationMs: 30_000,
  halfOpenSuccessThreshold: 2,
};

export const sessionRoutingPolicySchema = z
  .object({
    enabled: z.boolean().default(defaultSessionRoutingPolicy.enabled),
    switchPenalty: z.number().nonnegative().default(defaultSessionRoutingPolicy.switchPenalty),
    switchScoreThreshold: z
      .number()
      .nonnegative()
      .default(defaultSessionRoutingPolicy.switchScoreThreshold),
    escalationFailureThreshold: z
      .number()
      .int()
      .positive()
      .default(defaultSessionRoutingPolicy.escalationFailureThreshold),
    maxEscalationLevel: z
      .number()
      .int()
      .min(0)
      .max(4)
      .default(defaultSessionRoutingPolicy.maxEscalationLevel),
    successfulOutcomesToDeescalate: z
      .number()
      .int()
      .positive()
      .default(defaultSessionRoutingPolicy.successfulOutcomesToDeescalate),
    deescalationCooldownMs: z
      .number()
      .int()
      .nonnegative()
      .default(defaultSessionRoutingPolicy.deescalationCooldownMs),
    automaticStuckVerdictTtlMs: z
      .number()
      .int()
      .positive()
      .default(defaultSessionRoutingPolicy.automaticStuckVerdictTtlMs),
  })
  .strict()
  .default(defaultSessionRoutingPolicy);

export const fallbackPolicySchema = z
  .object({
    enabled: z.boolean().default(defaultFallbackPolicy.enabled),
    maxAttempts: z.number().int().min(1).max(10).default(defaultFallbackPolicy.maxAttempts),
    maxTotalDurationMs: z
      .number()
      .int()
      .positive()
      .default(defaultFallbackPolicy.maxTotalDurationMs),
    allowWeakerFallback: z.boolean().default(defaultFallbackPolicy.allowWeakerFallback),
  })
  .strict()
  .default(defaultFallbackPolicy);

export const circuitBreakerPolicySchema = z
  .object({
    failureThreshold: z
      .number()
      .int()
      .positive()
      .default(defaultCircuitBreakerPolicy.failureThreshold),
    openDurationMs: z.number().int().positive().default(defaultCircuitBreakerPolicy.openDurationMs),
    halfOpenSuccessThreshold: z
      .number()
      .int()
      .positive()
      .default(defaultCircuitBreakerPolicy.halfOpenSuccessThreshold),
  })
  .strict()
  .default(defaultCircuitBreakerPolicy);
