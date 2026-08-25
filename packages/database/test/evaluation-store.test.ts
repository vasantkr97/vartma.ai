import { describe, expect, it, vi } from "vitest";

import {
  PrismaEvaluationStore,
  type PersistedEvaluationResultInput,
  type RouterDatabase,
} from "../src/index.js";

describe("PrismaEvaluationStore", () => {
  it("transactionally persists a run and returns a precise summary", async () => {
    const runUpsert = vi.fn((input) => Promise.resolve(input.create));
    const resultUpsert = vi.fn((input) => Promise.resolve(input.create));
    const transaction = vi.fn((operations: Array<Promise<unknown>>) => Promise.all(operations));
    const database = {
      evaluationRun: { upsert: runUpsert, findMany: vi.fn() },
      evaluationTaskResult: { upsert: resultUpsert },
      $transaction: transaction,
    } as unknown as RouterDatabase;
    const store = new PrismaEvaluationStore(database);

    const summary = await store.persist([
      result({ taskId: "repair-a", success: true, actualCostUsd: "0.100000000001" }),
      result({
        taskId: "repair-b",
        selectedModel: "openai/frontier",
        success: false,
        attempts: 2,
        latencyMs: 200,
        actualCostUsd: "0.200000000002",
        completedAt: "2026-08-24T00:00:02.000Z",
      }),
    ]);

    expect(transaction).toHaveBeenCalledOnce();
    expect(runUpsert).toHaveBeenCalledOnce();
    expect(resultUpsert).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({
      id: "eval-run-1",
      datasetDigest: `sha256:${"c".repeat(64)}`,
      target: "router:balanced",
      tasks: 2,
      solved: 1,
      passRate: 0.5,
      attempts: 3,
      actualCostUsd: "0.300000000003",
      p50LatencyMs: 100,
      p95LatencyMs: 200,
      routingDistribution: { "deepseek/chat": 1, "openai/frontier": 1 },
    });
    expect(runUpsert.mock.calls[0]?.[0].create.datasetDigest).toBe(`sha256:${"c".repeat(64)}`);
  });

  it("lists persisted summaries and rejects incomparable records in one run", async () => {
    const database = {
      evaluationRun: {
        upsert: vi.fn(),
        findMany: vi.fn(() =>
          Promise.resolve([
            {
              id: "eval-run-1",
              dataset: "coding-public",
              datasetVersion: "1.0.0",
              datasetDigest: `sha256:${"c".repeat(64)}`,
              harnessVersion: "graph-v1",
              targetKind: "fixed",
              targetValue: "openai/frontier",
              startedAt: new Date("2026-08-24T00:00:00.000Z"),
              completedAt: new Date("2026-08-24T00:00:01.000Z"),
              results: [
                {
                  selectedModel: "openai/frontier",
                  success: true,
                  attempts: 1,
                  latencyMs: 100,
                  actualCost: { toString: () => "0.5" },
                },
              ],
            },
          ]),
        ),
      },
      evaluationTaskResult: { upsert: vi.fn() },
      $transaction: vi.fn(),
    } as unknown as RouterDatabase;
    const store = new PrismaEvaluationStore(database);

    expect(await store.list(10)).toEqual([
      expect.objectContaining({ target: "fixed:openai/frontier", actualCostUsd: "0.5" }),
    ]);
    await expect(
      store.persist([
        result(),
        result({ taskId: "different", target: { kind: "router", mode: "eco" } }),
      ]),
    ).rejects.toThrow("different targets");
  });
});

function result(
  patch: Partial<PersistedEvaluationResultInput> = {},
): PersistedEvaluationResultInput {
  return {
    runId: "eval-run-1",
    taskId: "repair-a",
    taskClass: "test_repair",
    environment: {
      dataset: "coding-public",
      datasetVersion: "1.0.0",
      datasetDigest: `sha256:${"c".repeat(64)}`,
      harnessVersion: "graph-v1",
      promptTemplateVersion: "prompt-v1",
      timeoutMs: 300_000,
      maxAttempts: 3,
      cacheEnabled: true,
      maxOutputTokens: 4096,
    },
    target: { kind: "router", mode: "balanced" },
    selectedModel: "deepseek/chat",
    success: true,
    attempts: 1,
    latencyMs: 100,
    actualCostUsd: "0.1",
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 5,
    completedAt: "2026-08-24T00:00:01.000Z",
    ...patch,
  };
}
