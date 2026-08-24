import type {
  SessionState,
  SessionStateStore,
  StoredSessionOutcome,
  TaskClass,
} from "@vartma/routing";

import type { RouterDatabase } from "./index.js";

export class PrismaSessionStateStore implements SessionStateStore {
  public constructor(private readonly database: RouterDatabase) {}

  public async get(sessionId: string): Promise<SessionState | undefined> {
    const session = await this.database.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      return undefined;
    }
    return sessionState(session);
  }

  public async list(limit: number): Promise<SessionState[]> {
    const sessions = await this.database.session.findMany({
      orderBy: { lastActivityAt: "desc" },
      take: limit,
    });
    return sessions.map(sessionState);
  }

  public async save(state: SessionState): Promise<void> {
    await this.database.session.upsert({
      where: { id: state.id },
      create: sessionData(state),
      update: sessionData(state),
    });
  }

  public async saveOutcome(state: SessionState, outcome: StoredSessionOutcome): Promise<void> {
    await this.database.$transaction([
      this.database.session.upsert({
        where: { id: state.id },
        create: sessionData(state),
        update: sessionData(state),
      }),
      this.database.sessionOutcome.create({
        data: {
          sessionId: outcome.sessionId,
          ...(outcome.requestId ? { requestId: outcome.requestId } : {}),
          kind: outcome.kind,
          ...(outcome.source ? { source: outcome.source } : {}),
          ...(outcome.metadata ? { metadata: outcome.metadata } : {}),
          escalationLevelBefore: outcome.escalationLevelBefore,
          escalationLevelAfter: outcome.escalationLevelAfter,
          createdAt: new Date(outcome.createdAt),
        },
      }),
    ]);
  }
}

function sessionState(session: {
  id: string;
  routingMode: string;
  currentProvider: string | null;
  currentModel: string | null;
  escalationLevel: number;
  automaticEscalationLevel: number;
  turnCount: number;
  lastTaskClass: string | null;
  consecutiveFailures: number;
  successfulOutcomes: number;
  accumulatedCost: { toString(): string };
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
  reasoningTokens: bigint;
  lastEscalatedAt: Date | null;
  cooldownUntil: Date | null;
  lastProgressFingerprint: string | null;
  automaticStuckUntil: Date | null;
  lastActivityAt: Date;
}): SessionState {
  return {
    id: session.id,
    routingMode: asRoutingMode(session.routingMode),
    ...(session.currentProvider ? { currentProvider: session.currentProvider } : {}),
    ...(session.currentModel ? { currentModel: session.currentModel } : {}),
    escalationLevel: session.escalationLevel,
    turnCount: session.turnCount,
    ...(session.lastTaskClass ? { lastTaskClass: session.lastTaskClass as TaskClass } : {}),
    consecutiveFailures: session.consecutiveFailures,
    successfulOutcomes: session.successfulOutcomes,
    accumulatedCostUsd: session.accumulatedCost.toString(),
    tokenUsage: {
      inputTokens: session.inputTokens.toString(),
      cachedInputTokens: session.cachedInputTokens.toString(),
      outputTokens: session.outputTokens.toString(),
      reasoningTokens: session.reasoningTokens.toString(),
    },
    ...(session.lastEscalatedAt ? { lastEscalatedAt: session.lastEscalatedAt.toISOString() } : {}),
    ...(session.cooldownUntil ? { cooldownUntil: session.cooldownUntil.toISOString() } : {}),
    ...(session.lastProgressFingerprint
      ? { lastProgressFingerprint: session.lastProgressFingerprint }
      : {}),
    ...(session.automaticStuckUntil
      ? { automaticStuckUntil: session.automaticStuckUntil.toISOString() }
      : {}),
    automaticEscalationLevel: session.automaticEscalationLevel,
    lastActivityAt: session.lastActivityAt.toISOString(),
  };
}

function sessionData(state: SessionState) {
  return {
    id: state.id,
    routingMode: state.routingMode,
    currentProvider: state.currentProvider ?? null,
    currentModel: state.currentModel ?? null,
    escalationLevel: state.escalationLevel,
    turnCount: state.turnCount,
    lastTaskClass: state.lastTaskClass ?? null,
    consecutiveFailures: state.consecutiveFailures,
    successfulOutcomes: state.successfulOutcomes,
    lastEscalatedAt: state.lastEscalatedAt ? new Date(state.lastEscalatedAt) : null,
    cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil) : null,
    lastProgressFingerprint: state.lastProgressFingerprint ?? null,
    automaticStuckUntil: state.automaticStuckUntil ? new Date(state.automaticStuckUntil) : null,
    automaticEscalationLevel: state.automaticEscalationLevel,
    lastActivityAt: new Date(state.lastActivityAt),
  };
}

function asRoutingMode(value: string): SessionState["routingMode"] {
  if (value === "quality" || value === "balanced" || value === "eco" || value === "fixed") {
    return value;
  }
  return "balanced";
}
