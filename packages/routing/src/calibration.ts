import type { ModelDefinition } from "@vartma/canonical";
import { z } from "zod";

import { TASK_CLASSES, type TaskClass, type TaskClassification } from "./types.js";

export const calibrationSampleSchema = z
  .object({
    successRate: z.number().min(0).max(1),
    sampleSize: z.number().int().positive(),
    averageAttempts: z.number().min(1).max(10).default(1),
    p50LatencyMs: z.number().int().positive().optional(),
    observedAt: z.iso.datetime(),
    source: z.string().min(1),
  })
  .strict();

export const modelCalibrationSchema = z
  .object({
    default: calibrationSampleSchema.optional(),
    tasks: z.partialRecord(z.enum(TASK_CLASSES), calibrationSampleSchema).default({}),
  })
  .strict();

export const routingCalibrationSchema = z
  .object({
    enabled: z.boolean().default(true),
    version: z.string().min(1).default("uncalibrated"),
    priorSampleSize: z.number().int().nonnegative().max(10_000).default(20),
    models: z.record(z.string().min(1), modelCalibrationSchema).default({}),
  })
  .strict()
  .default({ enabled: true, version: "uncalibrated", priorSampleSize: 20, models: {} });

export type CalibrationSample = z.infer<typeof calibrationSampleSchema>;
export type ModelCalibration = z.infer<typeof modelCalibrationSchema>;
export type RoutingCalibration = z.infer<typeof routingCalibrationSchema>;

export interface ModelPerformancePrediction {
  expectedSuccess: number;
  expectedAttempts: number;
  sampleSize: number;
  source: "task_evaluation" | "model_evaluation" | "quality_prior";
  calibrationVersion: string;
  observedLatencyMs?: number;
}

export function predictModelPerformance(
  calibration: RoutingCalibration | undefined,
  model: ModelDefinition,
  task: TaskClassification,
): ModelPerformancePrediction {
  const priorSuccess = qualityPrior(model.qualityTier, task.difficulty);
  const configured = calibration?.enabled ? calibration.models[model.id] : undefined;
  const taskSample = configured?.tasks[task.taskClass];
  const sample = taskSample ?? configured?.default;
  const source = taskSample ? "task_evaluation" : sample ? "model_evaluation" : "quality_prior";
  const calibrationVersion = calibration?.version ?? "uncalibrated";

  if (!sample) {
    return {
      expectedSuccess: priorSuccess,
      expectedAttempts: 1,
      sampleSize: 0,
      source,
      calibrationVersion,
    };
  }

  const priorSampleSize = calibration?.priorSampleSize ?? 20;
  const denominator = sample.sampleSize + priorSampleSize;
  const expectedSuccess =
    denominator === 0
      ? sample.successRate
      : (sample.successRate * sample.sampleSize + priorSuccess * priorSampleSize) / denominator;
  return {
    expectedSuccess: clamp(expectedSuccess, 0.01, 0.999),
    expectedAttempts: sample.averageAttempts,
    sampleSize: sample.sampleSize,
    source,
    calibrationVersion,
    ...(sample.p50LatencyMs ? { observedLatencyMs: sample.p50LatencyMs } : {}),
  };
}

function qualityPrior(qualityTier: number, difficulty: TaskClassification["difficulty"]): number {
  return clamp(0.52 + qualityTier * 0.1 - (difficulty - 1) * 0.07, 0.08, 0.97);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function calibrationTaskClasses(): readonly TaskClass[] {
  return TASK_CLASSES;
}
