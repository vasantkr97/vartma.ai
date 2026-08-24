import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { evaluationSuiteSchema, runEvaluationSuite } from "../src/index.js";

describe("LangGraph evaluation runner", () => {
  it("runs a tool loop in a disposable fixture, verifies it, and records actual usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-eval-runner-"));
    const fixture = join(directory, "fixture");
    await mkdir(fixture);
    await writeFile(join(fixture, "value.txt"), "old\n", "utf8");
    const modelRequests: Array<Record<string, unknown>> = [];
    const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/vartma/v1/usage?")) {
        return Promise.resolve(
          Response.json({
            totals: {
              requestCount: 2,
              attemptCount: 2,
              inputTokens: "120",
              cachedInputTokens: "40",
              outputTokens: "30",
              reasoningTokens: "5",
              actualAttemptCostUsd: "0.00125",
            },
          }),
        );
      }
      if (typeof init?.body !== "string") throw new Error("Expected a serialized request body.");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      modelRequests.push(body);
      const content =
        modelRequests.length === 1
          ? [
              {
                type: "tool_use",
                id: "write-1",
                name: "write_file",
                input: { path: "value.txt", content: "new\n" },
              },
            ]
          : [{ type: "text", text: "Finished." }];
      return Promise.resolve(
        Response.json(
          {
            id: `response-${String(modelRequests.length)}`,
            type: "message",
            role: "assistant",
            content,
            stop_reason: modelRequests.length === 1 ? "tool_use" : "end_turn",
          },
          { headers: { "x-vartma-model": "fake/default" } },
        ),
      );
    });
    const suite = evaluationSuiteSchema.parse({
      dataset: "fixture-suite",
      datasetVersion: "1",
      promptTemplateVersion: "coding-agent-v1",
      timeoutMs: 30_000,
      maxAttempts: 3,
      cacheEnabled: true,
      maxAgentTurns: 5,
      tasks: [
        {
          id: "replace-value",
          taskClass: "small_edit",
          fixture: "fixture",
          prompt: "Replace old with new in value.txt.",
          verify: [
            {
              command: process.execPath,
              args: [
                "-e",
                "const fs=require('fs');process.exit(fs.readFileSync('value.txt','utf8')==='new\\n'?0:1)",
              ],
              timeoutMs: 5_000,
            },
          ],
        },
      ],
    });

    const runs = await runEvaluationSuite({
      suite,
      suiteDirectory: directory,
      target: { kind: "fixed", model: "fake/default" },
      gatewayUrl: "http://127.0.0.1:8080",
      apiKey: "test-router-key",
      runId: "runner-test",
      fetchImplementation,
    });

    expect(runs).toHaveLength(1);
    expect(runs[0]?.result).toMatchObject({
      runId: "runner-test",
      taskId: "replace-value",
      selectedModel: "fake/default",
      success: true,
      attempts: 2,
      actualCostUsd: "0.00125",
      inputTokens: 120,
      cachedInputTokens: 40,
      outputTokens: 30,
      reasoningTokens: 5,
    });
    expect(runs[0]?.workspacePath).toBeUndefined();
    expect(JSON.stringify(modelRequests[1])).toContain("write-1");
    expect(JSON.stringify(modelRequests[1])).toContain("Wrote value.txt");
    expect(modelRequests.every((request) => request["max_tokens"] === 4096)).toBe(true);
    expect(await readFile(join(fixture, "value.txt"), "utf8")).toBe("old\n");
  });

  it("records gateway failures with actual usage and retains the diagnostic workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-eval-failure-"));
    const fixture = join(directory, "fixture");
    await mkdir(fixture);
    await writeFile(join(fixture, "value.txt"), "old\n", "utf8");
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/vartma/v1/usage?")) {
        return Promise.resolve(
          Response.json({
            totals: {
              requestCount: 1,
              attemptCount: 1,
              inputTokens: "40",
              cachedInputTokens: "0",
              outputTokens: "0",
              reasoningTokens: "0",
              actualAttemptCostUsd: "0.0002",
            },
            distribution: [{ key: "model/a", requestCount: 1 }],
          }),
        );
      }
      return Promise.resolve(
        Response.json(
          { error: { type: "provider_error" } },
          { status: 502, headers: { "x-vartma-model": "model/a" } },
        ),
      );
    });
    const suite = evaluationSuiteSchema.parse({
      dataset: "failure-suite",
      datasetVersion: "1",
      promptTemplateVersion: "coding-agent-v1",
      timeoutMs: 30_000,
      tasks: [
        {
          id: "failed-provider-turn",
          taskClass: "debugging",
          fixture: "fixture",
          prompt: "Repair the fixture.",
          verify: [{ command: process.execPath, args: ["--version"] }],
        },
      ],
    });

    const [run] = await runEvaluationSuite({
      suite,
      suiteDirectory: directory,
      target: { kind: "fixed", model: "model/a" },
      gatewayUrl: "http://127.0.0.1:8080",
      apiKey: "test-router-key",
      runId: "failure-run",
      fetchImplementation,
    });

    expect(run?.result).toMatchObject({
      selectedModel: "model/a",
      success: false,
      attempts: 1,
      actualCostUsd: "0.0002",
      inputTokens: 40,
    });
    expect(run?.verificationOutput).toEqual(["Gateway returned HTTP 502 during evaluation."]);
    expect(run?.workspacePath).toBeTruthy();
  });

  it("propagates the suite deadline into the in-flight gateway request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-eval-timeout-"));
    const fixture = join(directory, "fixture");
    await mkdir(fixture);
    await writeFile(join(fixture, "value.txt"), "old\n", "utf8");
    let observedSignal: AbortSignal | undefined;
    const fetchImplementation = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/vartma/v1/usage?")) {
        return Promise.resolve(
          Response.json({
            totals: {
              requestCount: 1,
              attemptCount: 1,
              inputTokens: "1",
              cachedInputTokens: "0",
              outputTokens: "0",
              reasoningTokens: "0",
              actualAttemptCostUsd: "0",
            },
          }),
        );
      }
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener(
          "abort",
          () => {
            const reason: unknown = observedSignal?.reason;
            reject(reason instanceof Error ? reason : new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    });
    const suite = evaluationSuiteSchema.parse({
      dataset: "timeout-suite",
      datasetVersion: "1",
      promptTemplateVersion: "coding-agent-v1",
      timeoutMs: 25,
      tasks: [
        {
          id: "provider-timeout",
          taskClass: "debugging",
          fixture: "fixture",
          prompt: "Repair the fixture.",
          verify: [{ command: process.execPath, args: ["--version"] }],
        },
      ],
    });

    const [run] = await runEvaluationSuite({
      suite,
      suiteDirectory: directory,
      target: { kind: "fixed", model: "model/a" },
      gatewayUrl: "http://127.0.0.1:8080",
      apiKey: "test-router-key",
      runId: "timeout-run",
      fetchImplementation,
    });

    expect(observedSignal?.aborted).toBe(true);
    expect(run?.result.success).toBe(false);
    expect(run?.verificationOutput).toEqual(["Evaluation execution exceeded the suite timeout."]);
  });
});
