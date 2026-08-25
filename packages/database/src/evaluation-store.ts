import type { RouterDatabase } from "./index.js";

export interface PersistedEvaluationResultInput {
  runId: string;
  taskId: string;
  taskClass: string;
  environment: {
    dataset: string;
    datasetVersion: string;
    datasetDigest: string;
    harnessVersion: string;
    promptTemplateVersion: string;
    timeoutMs: number;
    maxAttempts: number;
    cacheEnabled: boolean;
    maxOutputTokens: number;
  };
  target: { kind: "fixed"; model: string } | { kind: "router"; mode: string };
  selectedModel: string;
  success: boolean;
  attempts: number;
  latencyMs: number;
  actualCostUsd: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  completedAt: string;
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

export interface EvaluationStore {
  persist(results: PersistedEvaluationResultInput[]): Promise<EvaluationRunSummary>;
  list(limit: number): Promise<EvaluationRunSummary[]>;
}

export class PrismaEvaluationStore implements EvaluationStore {
  public constructor(private readonly database: RouterDatabase) {}

  public async persist(results: PersistedEvaluationResultInput[]): Promise<EvaluationRunSummary> {
    const identity = validateRun(results);
    const completedDates = results.map((result) => new Date(result.completedAt));
    const completedAt = new Date(Math.max(...completedDates.map((date) => date.getTime())));
    const startedAt = new Date(
      Math.min(
        ...results.map(
          (result, index) => completedDates[index]!.getTime() - Math.max(0, result.latencyMs),
        ),
      ),
    );
    const run = {
      dataset: identity.environment.dataset,
      datasetVersion: identity.environment.datasetVersion,
      datasetDigest: identity.environment.datasetDigest,
      harnessVersion: identity.environment.harnessVersion,
      promptTemplateVersion: identity.environment.promptTemplateVersion,
      timeoutMs: identity.environment.timeoutMs,
      maxAttempts: identity.environment.maxAttempts,
      cacheEnabled: identity.environment.cacheEnabled,
      maxOutputTokens: identity.environment.maxOutputTokens,
      targetKind: identity.target.kind,
      targetValue: identity.target.kind === "fixed" ? identity.target.model : identity.target.mode,
      startedAt,
      completedAt,
    };
    await this.database.$transaction([
      this.database.evaluationRun.upsert({
        where: { id: identity.runId },
        create: { id: identity.runId, ...run },
        update: run,
      }),
      ...results.map((result) =>
        this.database.evaluationTaskResult.upsert({
          where: { runId_taskId: { runId: result.runId, taskId: result.taskId } },
          create: taskResultData(result),
          update: taskResultData(result),
        }),
      ),
    ]);
    return summarizeStoredRun({ id: identity.runId, ...run, results: storedResults(results) });
  }

  public async list(limit: number): Promise<EvaluationRunSummary[]> {
    const runs = await this.database.evaluationRun.findMany({
      orderBy: { completedAt: "desc" },
      take: limit,
      include: { results: { orderBy: { taskId: "asc" } } },
    });
    return runs.map(summarizeStoredRun);
  }
}

function validateRun(results: PersistedEvaluationResultInput[]): PersistedEvaluationResultInput {
  const first = results[0];
  if (!first) throw new Error("An evaluation run must contain at least one result.");
  const environment = JSON.stringify(first.environment);
  const target = targetKey(first.target);
  const taskIds = new Set<string>();
  for (const result of results) {
    if (result.runId !== first.runId) throw new Error("Evaluation results use different run IDs.");
    if (JSON.stringify(result.environment) !== environment) {
      throw new Error("Evaluation results use different benchmark environments.");
    }
    if (targetKey(result.target) !== target) {
      throw new Error("Evaluation results use different targets.");
    }
    if (taskIds.has(result.taskId)) {
      throw new Error(`Evaluation task "${result.taskId}" occurs more than once in the run.`);
    }
    taskIds.add(result.taskId);
    if (!/^\d+(?:\.\d+)?$/u.test(result.actualCostUsd)) {
      throw new Error(`Evaluation task "${result.taskId}" has an invalid cost.`);
    }
    if (!Number.isFinite(new Date(result.completedAt).getTime())) {
      throw new Error(`Evaluation task "${result.taskId}" has an invalid completion timestamp.`);
    }
  }
  return first;
}

function taskResultData(result: PersistedEvaluationResultInput) {
  return {
    runId: result.runId,
    taskId: result.taskId,
    taskClass: result.taskClass,
    selectedModel: result.selectedModel,
    success: result.success,
    attempts: result.attempts,
    latencyMs: result.latencyMs,
    actualCost: result.actualCostUsd,
    inputTokens: result.inputTokens,
    cachedInputTokens: result.cachedInputTokens,
    outputTokens: result.outputTokens,
    reasoningTokens: result.reasoningTokens,
    completedAt: new Date(result.completedAt),
  };
}

function storedResults(results: PersistedEvaluationResultInput[]) {
  return results.map((result) => ({
    selectedModel: result.selectedModel,
    success: result.success,
    attempts: result.attempts,
    latencyMs: result.latencyMs,
    actualCost: { toString: () => result.actualCostUsd },
  }));
}

function summarizeStoredRun(run: {
  id: string;
  dataset: string;
  datasetVersion: string;
  datasetDigest: string;
  harnessVersion: string;
  targetKind: string;
  targetValue: string;
  startedAt: Date;
  completedAt: Date;
  results: Array<{
    selectedModel: string;
    success: boolean;
    attempts: number;
    latencyMs: number;
    actualCost: { toString(): string };
  }>;
}): EvaluationRunSummary {
  const solved = run.results.filter((result) => result.success).length;
  const cost = run.results.reduce(
    (total, result) => total + decimalToScaled(result.actualCost.toString()),
    0n,
  );
  const distribution: Record<string, number> = {};
  for (const result of run.results) {
    distribution[result.selectedModel] = (distribution[result.selectedModel] ?? 0) + 1;
  }
  const latencies = run.results.map((result) => result.latencyMs);
  return {
    id: run.id,
    dataset: run.dataset,
    datasetVersion: run.datasetVersion,
    datasetDigest: run.datasetDigest,
    harnessVersion: run.harnessVersion,
    target: `${run.targetKind}:${run.targetValue}`,
    tasks: run.results.length,
    solved,
    passRate: run.results.length ? solved / run.results.length : 0,
    attempts: run.results.reduce((total, result) => total + result.attempts, 0),
    actualCostUsd: scaledToString(cost),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    routingDistribution: Object.fromEntries(
      Object.entries(distribution).sort(([left], [right]) => left.localeCompare(right)),
    ),
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt.toISOString(),
  };
}

function targetKey(target: PersistedEvaluationResultInput["target"]): string {
  return target.kind === "fixed" ? `fixed:${target.model}` : `router:${target.mode}`;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

const COST_SCALE = 12;

function decimalToScaled(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole!) * 10n ** BigInt(COST_SCALE) +
    BigInt(fraction.padEnd(COST_SCALE, "0").slice(0, COST_SCALE))
  );
}

function scaledToString(value: bigint): string {
  const scale = 10n ** BigInt(COST_SCALE);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(COST_SCALE, "0").replace(/0+$/u, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}
