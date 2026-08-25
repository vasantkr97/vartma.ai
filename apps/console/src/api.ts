export interface ReadyReport {
  status: "ready" | "not_ready";
  providers: Array<{ provider: string; model: string; healthy: boolean; reason?: string }>;
  database: { healthy: boolean; reason?: string };
}

export interface ConfigSummary {
  environment: string;
  defaultMode: string;
  defaultModel: string;
  baselineModel: string | null;
  routerVersion: string;
  priceBookVersion: string;
  calibration: {
    enabled: boolean;
    version: string;
    priorSampleSize: number;
    models: Record<string, { defaultSampleSize: number; taskSamples: Record<string, number> }>;
  };
  providers: Array<{
    id: string;
    type: string;
    enabled: boolean;
    profile: string | null;
    credentialEnvironmentVariable: string | null;
    credentialPresent: boolean;
    models: Array<{
      id: string;
      upstreamModel: string;
      enabled: boolean;
      capabilities: Record<string, boolean>;
      contextWindow: number;
      maxOutputTokens: number;
      qualityTier: number;
      expectedLatencyTier: number;
      pricing: {
        inputPerMillion: number;
        cachedInputPerMillion: number;
        outputPerMillion: number;
        source: string;
        verifiedAt: string;
      };
    }>;
  }>;
}

export interface UsageReport {
  totals: {
    requestCount: number;
    completedRequestCount: number;
    failedRequestCount: number;
    attemptCount: number;
    actualAttemptCostUsd: string;
    failedAttemptCostUsd: string;
    baselineCostUsd: string;
    savingsUsd: string;
    savingsPercent: string | null;
  };
  distribution: Array<{
    key: string;
    requestCount: number;
    completedRequestCount: number;
    actualAttemptCostUsd: string;
  }>;
}

export interface SessionSummary {
  id: string;
  routingMode: string;
  currentProvider?: string;
  currentModel?: string;
  escalationLevel: number;
  automaticEscalationLevel: number;
  turnCount: number;
  lastTaskClass?: string;
  consecutiveFailures: number;
  accumulatedCostUsd?: string;
  lastActivityAt: string;
}

export interface RequestSummary {
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

export interface EvaluationRunSummary {
  id: string;
  dataset: string;
  datasetVersion: string;
  datasetDigest: string;
  harnessVersion: string;
  target: string;
  tasks: number;
  solved: number;
  passRate: number;
  attempts: number;
  actualCostUsd: string;
  p50LatencyMs: number;
  p95LatencyMs: number;
  routingDistribution: Record<string, number>;
  startedAt: string;
  completedAt: string;
}

export interface ConsoleSnapshot {
  ready: ReadyReport;
  config: ConfigSummary;
  usage?: UsageReport;
  sessions: SessionSummary[];
  requests: RequestSummary[];
  evaluationRuns: EvaluationRunSummary[];
  usageUnavailableReason?: string;
  requestsUnavailableReason?: string;
  evaluationsUnavailableReason?: string;
}

export async function loadSnapshot(apiKey: string): Promise<ConsoleSnapshot> {
  const headers = apiKey ? { "x-api-key": apiKey } : {};
  const [ready, config, sessions, usage, requests, evaluations] = await Promise.all([
    getJson<ReadyReport>("/readyz", {}),
    getJson<ConfigSummary>("/vartma/v1/config-summary", headers),
    getJson<{ sessions: SessionSummary[] }>("/vartma/v1/sessions?limit=50", headers),
    getJson<UsageReport>("/vartma/v1/usage?group_by=model", headers).catch((error: unknown) => ({
      unavailable: safeMessage(error),
    })),
    getJson<{ requests: RequestSummary[] }>("/vartma/v1/requests?limit=100", headers).catch(
      (error: unknown) => ({ unavailable: safeMessage(error) }),
    ),
    getJson<{ runs: EvaluationRunSummary[] }>("/vartma/v1/evaluations?limit=20", headers).catch(
      (error: unknown) => ({ unavailable: safeMessage(error) }),
    ),
  ]);
  return {
    ready,
    config,
    sessions: sessions.sessions,
    requests: isUnavailable(requests) ? [] : requests.requests,
    evaluationRuns: isUnavailable(evaluations) ? [] : evaluations.runs,
    ...(isUnavailable(usage) ? { usageUnavailableReason: usage.unavailable } : { usage }),
    ...(isUnavailable(requests) ? { requestsUnavailableReason: requests.unavailable } : {}),
    ...(isUnavailable(evaluations)
      ? { evaluationsUnavailableReason: evaluations.unavailable }
      : {}),
  };
}

async function getJson<T>(path: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(path, { headers });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message =
      isRecord(body) && isRecord(body["error"]) && typeof body["error"]["message"] === "string"
        ? body["error"]["message"]
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

function isUnavailable(value: unknown): value is { unavailable: string } {
  return isRecord(value) && typeof value["unavailable"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Usage analytics are unavailable.";
}
