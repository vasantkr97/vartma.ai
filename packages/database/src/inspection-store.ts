import type { RouterDatabase } from "./index.js";

export interface TraceInspection {
  id: string;
  sessionId: string | null;
  clientRequestId: string | null;
  requestedModel: string | null;
  selectedProvider: string | null;
  selectedModel: string | null;
  routingMode: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  errorType: string | null;
  errorMessage: string | null;
  traceLevel: string;
  metadataKeys: string[];
  routeDecision: {
    routerVersion: string;
    taskClass: string;
    selectedProvider: string;
    selectedModel: string;
    explanation: unknown;
    candidates: unknown;
    createdAt: string;
  } | null;
  attempts: Array<{
    id: string;
    sequence: number;
    provider: string;
    model: string;
    providerRequestId: string | null;
    status: string;
    startedAt: string;
    completedAt: string | null;
    firstTokenAt: string | null;
    errorType: string | null;
    errorMessage: string | null;
  }>;
  switches: Array<{
    sequence: number;
    fromProvider: string;
    fromModel: string;
    toProvider: string;
    toModel: string;
    reason: string;
    trigger: string;
    createdAt: string;
  }>;
  usage: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    estimatedCostUsd: string;
    currency: string;
    priceBookVersion: string;
    createdAt: string;
  }>;
}

export interface SessionInspectionSummary {
  id: string;
  routingMode: string;
  currentProvider: string | null;
  currentModel: string | null;
  escalationLevel: number;
  turnCount: number;
  consecutiveFailures: number;
  successfulOutcomes: number;
  accumulatedCostUsd: string;
  inputTokens: string;
  cachedInputTokens: string;
  outputTokens: string;
  reasoningTokens: string;
  lastTaskClass: string | null;
  lastActivityAt: string;
}

export interface RequestInspectionSummary {
  id: string;
  sessionId: string | null;
  routingMode: string;
  status: string;
  selectedProvider: string | null;
  selectedModel: string | null;
  taskClass: string | null;
  explanation: string | null;
  selectedReasons: string[];
  attemptCount: number;
  fallbackCount: number;
  startedAt: string;
  completedAt: string | null;
  errorType: string | null;
  errorMessage: string | null;
}

export interface InspectionStore {
  trace(requestId: string): Promise<TraceInspection | undefined>;
  requests(limit: number, failuresOnly?: boolean): Promise<RequestInspectionSummary[]>;
  sessions(limit: number): Promise<SessionInspectionSummary[]>;
  session(sessionId: string, recentLimit: number): Promise<SessionInspection | undefined>;
}

export interface SessionInspection extends SessionInspectionSummary {
  clientType: string | null;
  createdAt: string;
  updatedAt: string;
  lastEscalatedAt: string | null;
  cooldownUntil: string | null;
  recentRequests: Array<{
    id: string;
    status: string;
    selectedProvider: string | null;
    selectedModel: string | null;
    routingMode: string;
    startedAt: string;
    completedAt: string | null;
    errorType: string | null;
  }>;
  recentOutcomes: Array<{
    id: string;
    requestId: string | null;
    kind: string;
    source: string | null;
    escalationLevelBefore: number;
    escalationLevelAfter: number;
    metadataKeys: string[];
    createdAt: string;
  }>;
}

export class PrismaInspectionStore implements InspectionStore {
  public constructor(private readonly database: RouterDatabase) {}

  public async trace(requestId: string): Promise<TraceInspection | undefined> {
    const request = await this.database.request.findUnique({
      where: { id: requestId },
      include: {
        routeDecision: true,
        attempts: { orderBy: { sequence: "asc" } },
        routeSwitches: { orderBy: { sequence: "asc" } },
        usageEvents: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!request) {
      return undefined;
    }
    return {
      id: request.id,
      sessionId: request.sessionId,
      clientRequestId: request.clientRequestId,
      requestedModel: request.requestedModel,
      selectedProvider: request.selectedProvider,
      selectedModel: request.selectedModel,
      routingMode: request.routingMode,
      status: request.status,
      startedAt: request.startedAt.toISOString(),
      completedAt: request.completedAt?.toISOString() ?? null,
      errorType: request.errorType,
      errorMessage: redactText(request.errorMessage),
      traceLevel: request.traceLevel,
      metadataKeys: jsonObjectKeys(request.metadata),
      routeDecision: request.routeDecision
        ? {
            routerVersion: request.routeDecision.routerVersion,
            taskClass: request.routeDecision.taskClass,
            selectedProvider: request.routeDecision.selectedProvider,
            selectedModel: request.routeDecision.selectedModel,
            explanation: redactDiagnosticJson(request.routeDecision.explanation),
            candidates: redactDiagnosticJson(request.routeDecision.candidates),
            createdAt: request.routeDecision.createdAt.toISOString(),
          }
        : null,
      attempts: request.attempts.map((attempt) => ({
        id: attempt.id,
        sequence: attempt.sequence,
        provider: attempt.provider,
        model: attempt.model,
        providerRequestId: attempt.providerRequestId,
        status: attempt.status,
        startedAt: attempt.startedAt.toISOString(),
        completedAt: attempt.completedAt?.toISOString() ?? null,
        firstTokenAt: attempt.firstTokenAt?.toISOString() ?? null,
        errorType: attempt.errorType,
        errorMessage: redactText(attempt.errorMessage),
      })),
      switches: request.routeSwitches.map((routeSwitch) => ({
        sequence: routeSwitch.sequence,
        fromProvider: routeSwitch.fromProvider,
        fromModel: routeSwitch.fromModel,
        toProvider: routeSwitch.toProvider,
        toModel: routeSwitch.toModel,
        reason: routeSwitch.reason,
        trigger: routeSwitch.trigger,
        createdAt: routeSwitch.createdAt.toISOString(),
      })),
      usage: request.usageEvents.map((usage) => ({
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        estimatedCostUsd: usage.estimatedCost.toString(),
        currency: usage.currency,
        priceBookVersion: usage.priceBookVersion,
        createdAt: usage.createdAt.toISOString(),
      })),
    };
  }

  public async requests(limit: number, failuresOnly = false): Promise<RequestInspectionSummary[]> {
    const requests = await this.database.request.findMany({
      ...(failuresOnly ? { where: { status: { in: ["FAILED", "CANCELLED"] } } } : {}),
      orderBy: { startedAt: "desc" },
      take: limit,
      include: {
        routeDecision: true,
        _count: { select: { attempts: true, routeSwitches: true } },
      },
    });
    return requests.map((request) => {
      const explanation = isPlainObject(request.routeDecision?.explanation)
        ? request.routeDecision.explanation
        : undefined;
      const selectedReasons = Array.isArray(explanation?.["selectedReasons"])
        ? explanation["selectedReasons"].flatMap((value) =>
            typeof value === "string" ? [redactText(value) ?? ""] : [],
          )
        : [];
      return {
        id: request.id,
        sessionId: request.sessionId,
        routingMode: request.routingMode,
        status: request.status,
        selectedProvider: request.selectedProvider,
        selectedModel: request.selectedModel,
        taskClass: request.routeDecision?.taskClass ?? null,
        explanation:
          typeof explanation?.["summary"] === "string" ? redactText(explanation["summary"]) : null,
        selectedReasons,
        attemptCount: request._count.attempts,
        fallbackCount: request._count.routeSwitches,
        startedAt: request.startedAt.toISOString(),
        completedAt: request.completedAt?.toISOString() ?? null,
        errorType: request.errorType,
        errorMessage: redactText(request.errorMessage),
      };
    });
  }

  public async sessions(limit: number): Promise<SessionInspectionSummary[]> {
    const sessions = await this.database.session.findMany({
      orderBy: { lastActivityAt: "desc" },
      take: limit,
    });
    return sessions.map(sessionSummary);
  }

  public async session(
    sessionId: string,
    recentLimit: number,
  ): Promise<SessionInspection | undefined> {
    const session = await this.database.session.findUnique({
      where: { id: sessionId },
      include: {
        requests: { orderBy: { startedAt: "desc" }, take: recentLimit },
        outcomes: { orderBy: { createdAt: "desc" }, take: recentLimit },
      },
    });
    if (!session) {
      return undefined;
    }
    return {
      ...sessionSummary(session),
      clientType: session.clientType,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      lastEscalatedAt: session.lastEscalatedAt?.toISOString() ?? null,
      cooldownUntil: session.cooldownUntil?.toISOString() ?? null,
      recentRequests: session.requests.map((request) => ({
        id: request.id,
        status: request.status,
        selectedProvider: request.selectedProvider,
        selectedModel: request.selectedModel,
        routingMode: request.routingMode,
        startedAt: request.startedAt.toISOString(),
        completedAt: request.completedAt?.toISOString() ?? null,
        errorType: request.errorType,
      })),
      recentOutcomes: session.outcomes.map((outcome) => ({
        id: outcome.id,
        requestId: outcome.requestId,
        kind: outcome.kind,
        source: outcome.source,
        escalationLevelBefore: outcome.escalationLevelBefore,
        escalationLevelAfter: outcome.escalationLevelAfter,
        metadataKeys: jsonObjectKeys(outcome.metadata),
        createdAt: outcome.createdAt.toISOString(),
      })),
    };
  }
}

function sessionSummary(session: {
  id: string;
  routingMode: string;
  currentProvider: string | null;
  currentModel: string | null;
  escalationLevel: number;
  turnCount: number;
  consecutiveFailures: number;
  successfulOutcomes: number;
  accumulatedCost: { toString(): string };
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
  reasoningTokens: bigint;
  lastTaskClass: string | null;
  lastActivityAt: Date;
}): SessionInspectionSummary {
  return {
    id: session.id,
    routingMode: session.routingMode,
    currentProvider: session.currentProvider,
    currentModel: session.currentModel,
    escalationLevel: session.escalationLevel,
    turnCount: session.turnCount,
    consecutiveFailures: session.consecutiveFailures,
    successfulOutcomes: session.successfulOutcomes,
    accumulatedCostUsd: session.accumulatedCost.toString(),
    inputTokens: session.inputTokens.toString(),
    cachedInputTokens: session.cachedInputTokens.toString(),
    outputTokens: session.outputTokens.toString(),
    reasoningTokens: session.reasoningTokens.toString(),
    lastTaskClass: session.lastTaskClass,
    lastActivityAt: session.lastActivityAt.toISOString(),
  };
}

function redactDiagnosticJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactDiagnosticJson);
  }
  if (!isPlainObject(value)) {
    return typeof value === "string" ? redactText(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED]" : redactDiagnosticJson(nested),
    ]),
  );
}

function jsonObjectKeys(value: unknown): string[] {
  return isPlainObject(value) ? Object.keys(value).sort() : [];
}

function redactText(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .slice(0, 500);
}

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|cookie|password|secret|token|api[_-]?key)/i.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
