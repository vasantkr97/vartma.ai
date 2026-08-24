import type { RoutingMode } from "@vartma/canonical";
import type { ModelDefinition } from "@vartma/canonical";

import type { SessionRoutingPolicy } from "./resilience.js";
import type { ProgressAssessment } from "./progress.js";
import type { RoutingDecision, TaskClass } from "./types.js";

export const SESSION_OUTCOME_KINDS = [
  "success",
  "task_completed",
  "test_failure",
  "tool_error",
  "structured_output_failure",
  "stuck",
  "verifier_failure",
  "user_escalation",
] as const;

export type SessionOutcomeKind = (typeof SESSION_OUTCOME_KINDS)[number];

export interface SessionState {
  id: string;
  routingMode: RoutingMode;
  currentProvider?: string;
  currentModel?: string;
  escalationLevel: number;
  turnCount: number;
  lastTaskClass?: TaskClass;
  consecutiveFailures: number;
  successfulOutcomes: number;
  accumulatedCostUsd?: string;
  tokenUsage?: {
    inputTokens: string;
    cachedInputTokens: string;
    outputTokens: string;
    reasoningTokens: string;
  };
  lastEscalatedAt?: string;
  cooldownUntil?: string;
  lastProgressFingerprint?: string;
  automaticStuckUntil?: string;
  automaticEscalationLevel: number;
  lastActivityAt: string;
}

export interface SessionOutcomeInput {
  kind: SessionOutcomeKind;
  requestId?: string;
  source?: string;
  metadata?: Record<string, string>;
}

export interface StoredSessionOutcome extends SessionOutcomeInput {
  sessionId: string;
  escalationLevelBefore: number;
  escalationLevelAfter: number;
  createdAt: string;
}

export interface SessionStateStore {
  get(sessionId: string): Promise<SessionState | undefined>;
  list(limit: number): Promise<SessionState[]>;
  save(state: SessionState): Promise<void>;
  saveOutcome(state: SessionState, outcome: StoredSessionOutcome): Promise<void>;
}

export interface OutcomeResult {
  state: SessionState;
  escalated: boolean;
  deescalated: boolean;
}

export interface ProgressObservationResult {
  state: SessionState;
  escalated: boolean;
  expired: boolean;
  duplicate: boolean;
}

export class InMemorySessionStateStore implements SessionStateStore {
  private readonly states = new Map<string, SessionState>();
  private readonly outcomeRecords: StoredSessionOutcome[] = [];

  public get(sessionId: string): Promise<SessionState | undefined> {
    const state = this.states.get(sessionId);
    return Promise.resolve(state ? structuredClone(state) : undefined);
  }

  public save(state: SessionState): Promise<void> {
    this.states.set(state.id, structuredClone(state));
    return Promise.resolve();
  }

  public list(limit: number): Promise<SessionState[]> {
    return Promise.resolve(
      [...this.states.values()]
        .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
        .slice(0, limit)
        .map((state) => structuredClone(state)),
    );
  }

  public saveOutcome(state: SessionState, outcome: StoredSessionOutcome): Promise<void> {
    this.states.set(state.id, structuredClone(state));
    this.outcomeRecords.push(structuredClone(outcome));
    return Promise.resolve();
  }

  public outcomes(): StoredSessionOutcome[] {
    return structuredClone(this.outcomeRecords);
  }
}

export class SessionCoordinator {
  public constructor(
    private readonly store: SessionStateStore,
    private readonly policy: SessionRoutingPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async get(sessionId: string, routingMode: RoutingMode): Promise<SessionState> {
    return (await this.store.get(sessionId)) ?? this.create(sessionId, routingMode);
  }

  public async recordTurn(
    sessionId: string,
    routingMode: RoutingMode,
    decision: RoutingDecision,
    actualModel: ModelDefinition = decision.selectedModel,
  ): Promise<SessionState> {
    const state = await this.get(sessionId, routingMode);
    const updated: SessionState = {
      ...state,
      routingMode,
      currentProvider: actualModel.provider,
      currentModel: actualModel.id,
      turnCount: state.turnCount + 1,
      lastTaskClass: decision.task.taskClass,
      lastActivityAt: this.now().toISOString(),
    };
    await this.store.save(updated);
    return updated;
  }

  public async recordOutcome(
    sessionId: string,
    routingMode: RoutingMode,
    input: SessionOutcomeInput,
  ): Promise<OutcomeResult> {
    const state = await this.get(sessionId, routingMode);
    const levelBefore = state.escalationLevel;
    const now = this.now();
    const failure = isFailureOutcome(input.kind);
    let escalationLevel = state.escalationLevel;
    let consecutiveFailures = failure ? state.consecutiveFailures + 1 : 0;
    let successfulOutcomes = failure ? 0 : state.successfulOutcomes + 1;
    let lastEscalatedAt = state.lastEscalatedAt;
    let cooldownUntil = state.cooldownUntil;

    const shouldEscalate =
      input.kind === "user_escalation" ||
      (failure && consecutiveFailures >= this.policy.escalationFailureThreshold);
    if (shouldEscalate && escalationLevel < this.policy.maxEscalationLevel) {
      escalationLevel += 1;
      consecutiveFailures = 0;
      successfulOutcomes = 0;
      lastEscalatedAt = now.toISOString();
      cooldownUntil = new Date(now.getTime() + this.policy.deescalationCooldownMs).toISOString();
    } else if (
      !failure &&
      escalationLevel > 0 &&
      successfulOutcomes >= this.policy.successfulOutcomesToDeescalate &&
      (!cooldownUntil || Date.parse(cooldownUntil) <= now.getTime())
    ) {
      escalationLevel -= 1;
      successfulOutcomes = 0;
      cooldownUntil =
        escalationLevel > 0
          ? new Date(now.getTime() + this.policy.deescalationCooldownMs).toISOString()
          : undefined;
    }

    const updated: SessionState = {
      ...state,
      routingMode,
      escalationLevel,
      consecutiveFailures,
      successfulOutcomes,
      ...(lastEscalatedAt ? { lastEscalatedAt } : {}),
      ...(cooldownUntil ? { cooldownUntil } : {}),
      lastActivityAt: now.toISOString(),
    };
    const outcome: StoredSessionOutcome = {
      ...input,
      sessionId,
      escalationLevelBefore: levelBefore,
      escalationLevelAfter: escalationLevel,
      createdAt: now.toISOString(),
    };
    await this.store.saveOutcome(updated, outcome);
    return {
      state: updated,
      escalated: escalationLevel > levelBefore,
      deescalated: escalationLevel < levelBefore,
    };
  }

  public async observeProgress(
    sessionId: string,
    routingMode: RoutingMode,
    assessment: ProgressAssessment,
    requestId?: string,
  ): Promise<ProgressObservationResult> {
    const state = await this.get(sessionId, routingMode);
    const now = this.now();
    const automaticVerdictExpired =
      Boolean(state.automaticStuckUntil) && Date.parse(state.automaticStuckUntil!) <= now.getTime();
    let updated: SessionState = state;

    if (automaticVerdictExpired) {
      updated = {
        ...updated,
        escalationLevel: Math.max(0, updated.escalationLevel - updated.automaticEscalationLevel),
        automaticEscalationLevel: 0,
        lastActivityAt: now.toISOString(),
      };
      delete updated.automaticStuckUntil;
      delete updated.lastProgressFingerprint;
      await this.store.save(updated);
    }

    if (assessment.status !== "stuck" || !assessment.fingerprint) {
      return {
        state: updated,
        escalated: false,
        expired: automaticVerdictExpired,
        duplicate: false,
      };
    }

    if (updated.lastProgressFingerprint === assessment.fingerprint) {
      return {
        state: updated,
        escalated: false,
        expired: automaticVerdictExpired,
        duplicate: true,
      };
    }

    const levelBefore = updated.escalationLevel;
    const escalationLevel = Math.min(this.policy.maxEscalationLevel, levelBefore + 1);
    const automaticEscalationLevel =
      updated.automaticEscalationLevel + (escalationLevel > levelBefore ? 1 : 0);
    const automaticStuckUntil = new Date(
      now.getTime() + this.policy.automaticStuckVerdictTtlMs,
    ).toISOString();
    updated = {
      ...updated,
      routingMode,
      escalationLevel,
      automaticEscalationLevel,
      consecutiveFailures: 0,
      successfulOutcomes: 0,
      lastProgressFingerprint: assessment.fingerprint,
      automaticStuckUntil,
      lastEscalatedAt: now.toISOString(),
      cooldownUntil: new Date(now.getTime() + this.policy.deescalationCooldownMs).toISOString(),
      lastActivityAt: now.toISOString(),
    };
    const outcome: StoredSessionOutcome = {
      sessionId,
      kind: "stuck",
      ...(requestId ? { requestId } : {}),
      source: "vartma-transcript-progress-detector",
      metadata: {
        fingerprint: assessment.fingerprint,
        confidence: assessment.confidence.toFixed(2),
        reasons: assessment.reasons.join("; "),
      },
      escalationLevelBefore: levelBefore,
      escalationLevelAfter: escalationLevel,
      createdAt: now.toISOString(),
    };
    await this.store.saveOutcome(updated, outcome);
    return {
      state: updated,
      escalated: escalationLevel > levelBefore,
      expired: automaticVerdictExpired,
      duplicate: false,
    };
  }

  private create(sessionId: string, routingMode: RoutingMode): SessionState {
    return {
      id: sessionId,
      routingMode,
      escalationLevel: 0,
      turnCount: 0,
      consecutiveFailures: 0,
      successfulOutcomes: 0,
      automaticEscalationLevel: 0,
      accumulatedCostUsd: "0",
      tokenUsage: {
        inputTokens: "0",
        cachedInputTokens: "0",
        outputTokens: "0",
        reasoningTokens: "0",
      },
      lastActivityAt: this.now().toISOString(),
    };
  }
}

function isFailureOutcome(kind: SessionOutcomeKind): boolean {
  return (
    kind === "test_failure" ||
    kind === "tool_error" ||
    kind === "structured_output_failure" ||
    kind === "stuck" ||
    kind === "verifier_failure" ||
    kind === "user_escalation"
  );
}
