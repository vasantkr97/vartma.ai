import { describe, expect, it } from "vitest";

import {
  buildCalibrationFromFixedResults,
  evaluationResultSchema,
  parseEvaluationJsonLines,
  summarizeEvaluation,
  type EvaluationResult,
} from "../src/index.js";

const environment = {
  dataset: "terminal-bench",
  datasetVersion: "2.0",
  datasetDigest: `sha256:${"b".repeat(64)}`,
  harnessVersion: "vartma-eval-v1",
  promptTemplateVersion: "coding-agent-v1",
  timeoutMs: 900_000,
  maxAttempts: 3,
  cacheEnabled: true,
  maxOutputTokens: 4096,
} as const;

function result(patch: Partial<EvaluationResult> = {}): EvaluationResult {
  return evaluationResultSchema.parse({
    runId: "run-1",
    taskId: "task-1",
    taskClass: "debugging",
    environment,
    target: { kind: "fixed", model: "model/a" },
    selectedModel: "model/a",
    success: true,
    attempts: 1,
    latencyMs: 1000,
    actualCostUsd: "0.25",
    inputTokens: 100,
    cachedInputTokens: 50,
    outputTokens: 20,
    reasoningTokens: 0,
    completedAt: "2026-08-24T00:00:00.000Z",
    ...patch,
  });
}

describe("evaluation results", () => {
  it("summarizes comparable fixed and router runs using actual attempt cost", () => {
    const results = [
      result(),
      result({
        target: { kind: "router", mode: "balanced" },
        selectedModel: "model/b",
        actualCostUsd: "0.10",
      }),
    ];

    const report = summarizeEvaluation(results, "fixed:model/a");

    expect(report.comparable).toBe(true);
    expect(report.targets).toEqual([
      expect.objectContaining({ target: "fixed:model/a", solved: 1, actualCostUsd: "0.25" }),
      expect.objectContaining({ target: "router:balanced", solved: 1, actualCostUsd: "0.1" }),
    ]);
    expect(report.comparisons).toEqual([
      {
        baseline: "fixed:model/a",
        target: "router:balanced",
        passRateDelta: 0,
        qualityRetention: 1,
        actualCostDeltaUsd: "-0.15",
        costSavingsRate: 0.6,
        costPerSolvedSavingsRate: 0.6,
      },
    ]);
  });

  it("refuses to describe mismatched benchmark settings as comparable", () => {
    const report = summarizeEvaluation([
      result(),
      result({
        target: { kind: "router", mode: "eco" },
        selectedModel: "model/b",
        environment: { ...environment, cacheEnabled: false },
      }),
    ]);

    expect(report.comparable).toBe(false);
    expect(report.comparabilityIssues.join(" ")).toContain("different");
  });

  it("refuses missing baselines and mismatched repetition counts", () => {
    const repeatedFixed = result({ runId: "run-2" });
    const report = summarizeEvaluation(
      [
        result(),
        repeatedFixed,
        result({
          target: { kind: "router", mode: "eco" },
          selectedModel: "model/b",
        }),
      ],
      "fixed:missing",
    );

    expect(report.comparable).toBe(false);
    expect(report.comparabilityIssues.join(" ")).toContain("same task IDs");
    expect(report.comparabilityIssues.join(" ")).toContain(
      "baseline target fixed:missing is missing",
    );
  });

  it("rejects duplicate run-target-task records", () => {
    const duplicate = result();
    const report = summarizeEvaluation([
      duplicate,
      duplicate,
      result({
        target: { kind: "router", mode: "balanced" },
        selectedModel: "model/b",
      }),
      result({
        runId: "run-2",
        target: { kind: "router", mode: "balanced" },
        selectedModel: "model/b",
      }),
    ]);

    expect(report.comparable).toBe(false);
    expect(report.comparabilityIssues.join(" ")).toContain("duplicate result");
  });

  it("builds task-specific calibration only from fixed-model evaluations", () => {
    const calibration = buildCalibrationFromFixedResults(
      [
        result(),
        result({ taskId: "task-2", success: false, attempts: 2, latencyMs: 2000 }),
        result({
          taskId: "task-2",
          target: { kind: "router", mode: "balanced" },
          selectedModel: "model/b",
        }),
      ],
      "terminal-bench-calibration-v1",
      10,
    );

    expect(calibration.models["model/a"]?.tasks.debugging).toMatchObject({
      successRate: 0.5,
      sampleSize: 2,
      averageAttempts: 1.5,
      p50LatencyMs: 1000,
    });
    expect(calibration.models["model/b"]).toBeUndefined();
  });

  it("reports the JSONL line containing an invalid record", () => {
    expect(() => parseEvaluationJsonLines(`${JSON.stringify(result())}\n{"bad":true}`)).toThrow(
      "line 2",
    );
  });

  it("preserves the historical output cap when reading legacy JSONL records", () => {
    const legacy = result();
    const environmentWithoutOutputCap = { ...legacy.environment } as Partial<
      EvaluationResult["environment"]
    >;
    delete environmentWithoutOutputCap.maxOutputTokens;

    expect(
      parseEvaluationJsonLines(
        JSON.stringify({ ...legacy, environment: environmentWithoutOutputCap }),
      )[0]?.environment.maxOutputTokens,
    ).toBe(16_384);
  });

  it("marks historical records without a dataset digest as unverified", () => {
    const legacy = result();
    const environmentWithoutDigest = { ...legacy.environment } as Partial<
      EvaluationResult["environment"]
    >;
    delete environmentWithoutDigest.datasetDigest;

    expect(
      parseEvaluationJsonLines(
        JSON.stringify({ ...legacy, environment: environmentWithoutDigest }),
      )[0]?.environment.datasetDigest,
    ).toBe(`sha256:${"0".repeat(64)}`);
  });
});
