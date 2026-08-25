import { ROUTING_MODES } from "@vartma/canonical";
import {
  routingCalibrationSchema,
  TASK_CLASSES,
  type CalibrationSample,
  type RoutingCalibration,
  type TaskClass,
} from "@vartma/routing";
import { z } from "zod";

const decimalSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/u, "Costs must be non-negative plain decimal strings.");

const benchmarkEnvironmentSchema = z
  .object({
    dataset: z.string().min(1),
    datasetVersion: z.string().min(1),
    datasetDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .default("sha256:0000000000000000000000000000000000000000000000000000000000000000"),
    harnessVersion: z.string().min(1),
    promptTemplateVersion: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    cacheEnabled: z.boolean(),
    // Results written before this field was introduced used the harness's hard-coded 16,384 cap.
    maxOutputTokens: z.number().int().positive().default(16_384),
  })
  .strict();

export const evaluationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), model: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("router"),
      mode: z.enum(ROUTING_MODES).exclude(["fixed"]),
    })
    .strict(),
]);

export const evaluationResultSchema = z
  .object({
    runId: z.string().min(1),
    taskId: z.string().min(1),
    taskClass: z.enum(TASK_CLASSES),
    environment: benchmarkEnvironmentSchema,
    target: evaluationTargetSchema,
    selectedModel: z.string().min(1),
    success: z.boolean(),
    attempts: z.number().int().positive(),
    latencyMs: z.number().int().nonnegative(),
    actualCostUsd: decimalSchema,
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    completedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.target.kind === "fixed" && result.target.model !== result.selectedModel) {
      context.addIssue({
        code: "custom",
        path: ["selectedModel"],
        message: "A fixed evaluation result must select its declared target model.",
      });
    }
  });

export type EvaluationResult = z.infer<typeof evaluationResultSchema>;
export type EvaluationTarget = z.infer<typeof evaluationTargetSchema>;

export interface EvaluationTargetReport {
  target: string;
  tasks: number;
  solved: number;
  passRate: number;
  attempts: number;
  actualCostUsd: string;
  costPerSolvedTaskUsd: string | null;
  p50LatencyMs: number;
  p95LatencyMs: number;
  routingDistribution: Record<string, number>;
}

export interface EvaluationReport {
  comparable: boolean;
  comparabilityIssues: string[];
  environmentSignatures: string[];
  targets: EvaluationTargetReport[];
  baselineTarget?: string;
  comparisons: EvaluationComparison[];
}

export interface EvaluationComparison {
  baseline: string;
  target: string;
  passRateDelta: number;
  qualityRetention: number | null;
  actualCostDeltaUsd: string;
  costSavingsRate: number | null;
  costPerSolvedSavingsRate: number | null;
}

export function parseEvaluationJsonLines(input: string): EvaluationResult[] {
  return input
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return evaluationResultSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid evaluation result on JSONL line ${String(index + 1)}.`, {
          cause: error,
        });
      }
    });
}

export function summarizeEvaluation(
  results: EvaluationResult[],
  baselineTarget?: string,
): EvaluationReport {
  const signatures = [...new Set(results.map(environmentSignature))].sort();
  const issues: string[] = [];
  if (results.length === 0) {
    issues.push("the result set is empty");
  }
  if (signatures.length > 1) {
    issues.push(
      "targets were run with different dataset, timeout, cache, retry, or prompt settings",
    );
  }
  const taskSets = new Map<string, string>();
  for (const [target, grouped] of groupBy(results, targetKey)) {
    taskSets.set(
      target,
      grouped
        .map((result) => result.taskId)
        .sort()
        .join("\u0000"),
    );
  }
  if (new Set(taskSets.values()).size > 1) {
    issues.push("targets do not contain the same task IDs");
  }

  const runTaskKeys = new Set<string>();
  for (const result of results) {
    const key = `${result.runId}\u0000${targetKey(result)}\u0000${result.taskId}`;
    if (runTaskKeys.has(key)) {
      issues.push(
        `duplicate result for run ${result.runId}, target ${targetKey(result)}, task ${result.taskId}`,
      );
      break;
    }
    runTaskKeys.add(key);
  }
  const taskClasses = new Map<string, TaskClass>();
  for (const result of results) {
    const existing = taskClasses.get(result.taskId);
    if (existing && existing !== result.taskClass) {
      issues.push(`task ${result.taskId} used inconsistent task classes`);
      break;
    }
    taskClasses.set(result.taskId, result.taskClass);
  }

  const targets = [...groupBy(results, targetKey).entries()]
    .map(([target, grouped]) => summarizeTarget(target, grouped))
    .sort((left, right) => left.target.localeCompare(right.target));
  const baseline = baselineTarget
    ? targets.find((target) => target.target === baselineTarget)
    : undefined;
  if (baselineTarget && !baseline) issues.push(`baseline target ${baselineTarget} is missing`);

  return {
    comparable: issues.length === 0,
    comparabilityIssues: issues,
    environmentSignatures: signatures,
    targets,
    ...(baselineTarget ? { baselineTarget } : {}),
    comparisons: baseline
      ? targets
          .filter((target) => target.target !== baseline.target)
          .map((target) => compareTarget(baseline, target))
      : [],
  };
}

export function buildCalibrationFromFixedResults(
  results: EvaluationResult[],
  version: string,
  priorSampleSize = 20,
): RoutingCalibration {
  const fixed = results.filter(
    (result): result is EvaluationResult & { target: { kind: "fixed"; model: string } } =>
      result.target.kind === "fixed",
  );
  if (fixed.length === 0) {
    throw new Error("Calibration requires at least one fixed-model evaluation result.");
  }
  const models: RoutingCalibration["models"] = {};
  for (const [model, modelResults] of groupBy(fixed, (result) => result.target.model)) {
    const tasks: Partial<Record<TaskClass, CalibrationSample>> = {};
    for (const [taskClass, taskResults] of groupBy(modelResults, (result) => result.taskClass)) {
      tasks[taskClass] = calibrationSample(taskResults);
    }
    models[model] = {
      default: calibrationSample(modelResults),
      tasks,
    };
  }
  return routingCalibrationSchema.parse({ enabled: true, version, priorSampleSize, models });
}

function calibrationSample(results: EvaluationResult[]) {
  const environment = results[0]!.environment;
  return {
    successRate: results.filter((result) => result.success).length / results.length,
    sampleSize: results.length,
    averageAttempts: mean(results.map((result) => result.attempts)),
    p50LatencyMs: percentile(
      results.map((result) => result.latencyMs),
      0.5,
    ),
    observedAt: results
      .map((result) => result.completedAt)
      .sort()
      .at(-1)!,
    source: `${environment.dataset}@${environment.datasetVersion} via ${environment.harnessVersion}`,
  };
}

function summarizeTarget(target: string, results: EvaluationResult[]): EvaluationTargetReport {
  const solved = results.filter((result) => result.success).length;
  const cost = results.reduce((total, result) => total + decimalToScaled(result.actualCostUsd), 0n);
  const distribution = Object.fromEntries(
    [...groupBy(results, (result) => result.selectedModel).entries()]
      .map(([model, records]) => [model, records.length] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const latencies = results.map((result) => result.latencyMs);
  return {
    target,
    tasks: results.length,
    solved,
    passRate: results.length === 0 ? 0 : solved / results.length,
    attempts: results.reduce((total, result) => total + result.attempts, 0),
    actualCostUsd: scaledToDecimal(cost),
    costPerSolvedTaskUsd: solved === 0 ? null : scaledToDecimal(cost / BigInt(solved)),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    routingDistribution: distribution,
  };
}

function compareTarget(
  baseline: EvaluationTargetReport,
  target: EvaluationTargetReport,
): EvaluationComparison {
  const baselineCost = decimalToScaled(baseline.actualCostUsd);
  const targetCost = decimalToScaled(target.actualCostUsd);
  const baselineCostPerSolved = baseline.costPerSolvedTaskUsd
    ? decimalToScaled(baseline.costPerSolvedTaskUsd)
    : undefined;
  const targetCostPerSolved = target.costPerSolvedTaskUsd
    ? decimalToScaled(target.costPerSolvedTaskUsd)
    : undefined;
  return {
    baseline: baseline.target,
    target: target.target,
    passRateDelta: target.passRate - baseline.passRate,
    qualityRetention: baseline.passRate > 0 ? target.passRate / baseline.passRate : null,
    actualCostDeltaUsd: scaledToDecimal(targetCost - baselineCost),
    costSavingsRate: baselineCost > 0n ? 1 - Number(targetCost) / Number(baselineCost) : null,
    costPerSolvedSavingsRate:
      baselineCostPerSolved !== undefined &&
      baselineCostPerSolved > 0n &&
      targetCostPerSolved !== undefined
        ? 1 - Number(targetCostPerSolved) / Number(baselineCostPerSolved)
        : null,
  };
}

function targetKey(result: EvaluationResult): string {
  return result.target.kind === "fixed"
    ? `fixed:${result.target.model}`
    : `router:${result.target.mode}`;
}

function environmentSignature(result: EvaluationResult): string {
  return JSON.stringify(result.environment);
}

function groupBy<T, Key extends string>(values: T[], key: (value: T) => Key): Map<Key, T[]> {
  const groups = new Map<Key, T[]>();
  for (const value of values) {
    const group = key(value);
    groups.set(group, [...(groups.get(group) ?? []), value]);
  }
  return groups;
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
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

function scaledToDecimal(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = 10n ** BigInt(COST_SCALE);
  const whole = magnitude / scale;
  const fraction = (magnitude % scale).toString().padStart(COST_SCALE, "0").replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}
