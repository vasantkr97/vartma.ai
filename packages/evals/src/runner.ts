import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import { evaluationResultSchema, type EvaluationResult, type EvaluationTarget } from "./results.js";
import type { EvaluationCommand, EvaluationSuite, EvaluationTask } from "./suite.js";

const executeFile = promisify(execFile);

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AnthropicResponseBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AgentMessage {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

interface AgentResponse {
  content: AnthropicResponseBlock[];
  stop_reason: string | null;
}

interface UsageResponse {
  totals: {
    requestCount: number;
    attemptCount: number;
    inputTokens: string;
    cachedInputTokens: string;
    outputTokens: string;
    reasoningTokens: string;
    actualAttemptCostUsd: string;
  };
  distribution?: Array<{ key: string; requestCount: number }>;
}

class EvaluationGatewayError extends Error {
  public constructor(
    public readonly status: number,
    public readonly selectedModel?: string,
  ) {
    super(`Gateway returned HTTP ${String(status)} during evaluation.`);
    this.name = "EvaluationGatewayError";
  }
}

const AgentState = Annotation.Root({
  messages: Annotation<AgentMessage[]>(),
  turns: Annotation<number>(),
  selectedModels: Annotation<string[]>(),
  verificationPassed: Annotation<boolean>(),
  verificationOutput: Annotation<string[]>(),
});

export interface EvaluationRunOptions {
  suite: EvaluationSuite;
  suiteDirectory: string;
  target: EvaluationTarget;
  gatewayUrl: string;
  apiKey: string;
  keepWorkspaces?: boolean;
  runId?: string;
  now?: () => Date;
  fetchImplementation?: typeof fetch;
}

export interface EvaluationTaskRun {
  result: EvaluationResult;
  workspacePath?: string;
  verificationOutput: string[];
}

export async function runEvaluationSuite(
  options: EvaluationRunOptions,
): Promise<EvaluationTaskRun[]> {
  const results: EvaluationTaskRun[] = [];
  const runId = options.runId ?? `vartma-eval-${randomUUID()}`;
  for (const task of options.suite.tasks) {
    results.push(await runEvaluationTask(task, { ...options, runId }));
  }
  return results;
}

async function runEvaluationTask(
  task: EvaluationTask,
  options: EvaluationRunOptions & { runId: string },
): Promise<EvaluationTaskRun> {
  const fixture = resolve(options.suiteDirectory, task.fixture);
  const fixtureRoot = await realpath(fixture);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "vartma-eval-task-"));
  const workspace = join(temporaryRoot, "workspace");
  const sessionId = `eval-${options.runId}-${task.id}`.slice(0, 200);
  const startedAt = options.now?.() ?? new Date();
  const started = performance.now();
  let retainWorkspace = options.keepWorkspaces ?? false;

  try {
    const fixtureStat = await lstat(fixtureRoot);
    if (!fixtureStat.isDirectory()) {
      throw new Error(`Evaluation fixture "${fixture}" must be a directory.`);
    }
    await cp(fixtureRoot, workspace, { recursive: true, errorOnExist: true });
    const workspaceRoot = await realpath(workspace);
    for (const command of task.setup) {
      const setup = await runCommand(command, workspaceRoot, options.suite.timeoutMs);
      if (!setup.success) {
        throw new Error(`Setup failed for task "${task.id}": ${setup.output}`);
      }
    }

    const evaluationSignal = AbortSignal.timeout(options.suite.timeoutMs);
    const graph = createAgentGraph(task, workspaceRoot, sessionId, options, evaluationSignal);
    let state: typeof AgentState.State | undefined;
    let executionFailure: unknown;
    try {
      state = await graph.invoke(
        {
          messages: [
            {
              role: "user",
              content:
                `${task.prompt}\n\n` +
                "Work only inside the provided evaluation workspace. Use tools to inspect and edit files. Run relevant checks, then finish with a concise summary.",
            },
          ],
          turns: 0,
          selectedModels: [],
          verificationPassed: false,
          verificationOutput: [],
        },
        {
          signal: evaluationSignal,
          recursionLimit: options.suite.maxAgentTurns * 2 + 10,
        },
      );
    } catch (error) {
      executionFailure = error;
      retainWorkspace = true;
    }
    const usage = await collectUsage(
      options.gatewayUrl,
      options.apiKey,
      sessionId,
      startedAt,
      options.fetchImplementation ?? fetch,
    );
    const selectedModel =
      state?.selectedModels.at(-1) ??
      (executionFailure instanceof EvaluationGatewayError
        ? executionFailure.selectedModel
        : undefined) ??
      (options.target.kind === "fixed" ? options.target.model : usage.distribution?.[0]?.key);
    if (!selectedModel) {
      throw new Error(`Task "${task.id}" completed without a routed model header.`);
    }
    if (options.target.kind === "fixed" && selectedModel !== options.target.model) {
      throw new Error(
        `Fixed target "${options.target.model}" unexpectedly selected "${selectedModel}".`,
      );
    }
    const completedAt = options.now?.() ?? new Date();
    const result = evaluationResultSchema.parse({
      runId: options.runId,
      taskId: task.id,
      taskClass: task.taskClass,
      environment: {
        dataset: options.suite.dataset,
        datasetVersion: options.suite.datasetVersion,
        harnessVersion: options.suite.harnessVersion,
        promptTemplateVersion: options.suite.promptTemplateVersion,
        timeoutMs: options.suite.timeoutMs,
        maxAttempts: options.suite.maxAttempts,
        cacheEnabled: options.suite.cacheEnabled,
        maxOutputTokens: options.suite.maxOutputTokens,
      },
      target: options.target,
      selectedModel,
      success: executionFailure === undefined && Boolean(state?.verificationPassed),
      attempts: usage.totals.attemptCount,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
      actualCostUsd: usage.totals.actualAttemptCostUsd,
      inputTokens: safeInteger(usage.totals.inputTokens, "input tokens"),
      cachedInputTokens: safeInteger(usage.totals.cachedInputTokens, "cached input tokens"),
      outputTokens: safeInteger(usage.totals.outputTokens, "output tokens"),
      reasoningTokens: safeInteger(usage.totals.reasoningTokens, "reasoning tokens"),
      completedAt: completedAt.toISOString(),
    });
    if (!result.success) retainWorkspace = true;
    const verificationOutput = state?.verificationOutput ?? [
      safeExecutionFailure(executionFailure),
    ];
    return {
      result,
      verificationOutput,
      ...(retainWorkspace ? { workspacePath: workspaceRoot } : {}),
    };
  } finally {
    if (!retainWorkspace) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

function createAgentGraph(
  task: EvaluationTask,
  workspace: string,
  sessionId: string,
  options: EvaluationRunOptions,
  signal: AbortSignal,
) {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const modelNode = async (state: typeof AgentState.State) => {
    const response = await callGateway(
      options.gatewayUrl,
      options.apiKey,
      sessionId,
      options.target,
      state.messages,
      options.suite.maxOutputTokens,
      signal,
      fetchImplementation,
    );
    return {
      messages: [...state.messages, { role: "assistant" as const, content: response.body.content }],
      turns: state.turns + 1,
      selectedModels: [...state.selectedModels, response.selectedModel],
    };
  };
  const toolNode = async (state: typeof AgentState.State) => {
    const assistant = state.messages.at(-1);
    const blocks = Array.isArray(assistant?.content) ? assistant.content : [];
    const results: Array<Record<string, unknown>> = [];
    for (const block of blocks) {
      if (block["type"] !== "tool_use") continue;
      const toolCallId = typeof block["id"] === "string" ? block["id"] : "unknown";
      const name = typeof block["name"] === "string" ? block["name"] : "unknown";
      const input = isRecord(block["input"]) ? block["input"] : {};
      try {
        results.push({
          type: "tool_result",
          tool_use_id: toolCallId,
          content: await executeAgentTool(name, input, workspace, task.allowedCommands),
          is_error: false,
        });
      } catch (error) {
        results.push({
          type: "tool_result",
          tool_use_id: toolCallId,
          content: safeToolError(error),
          is_error: true,
        });
      }
    }
    return {
      messages: [...state.messages, { role: "user" as const, content: results }],
    };
  };
  const verifyNode = async () => {
    const outputs: string[] = [];
    let passed = true;
    for (const command of task.verify) {
      const result = await runCommand(command, workspace, options.suite.timeoutMs);
      outputs.push(result.output);
      if (!result.success) passed = false;
    }
    return { verificationPassed: passed, verificationOutput: outputs };
  };
  const routeAfterModel = (state: typeof AgentState.State) => {
    const assistant = state.messages.at(-1);
    const hasToolCalls =
      Array.isArray(assistant?.content) &&
      assistant.content.some((block) => block["type"] === "tool_use");
    return hasToolCalls && state.turns < options.suite.maxAgentTurns ? "tools" : "verify";
  };

  return new StateGraph(AgentState)
    .addNode("model", modelNode)
    .addNode("tools", toolNode)
    .addNode("verify", verifyNode)
    .addEdge(START, "model")
    .addConditionalEdges("model", routeAfterModel, ["tools", "verify"])
    .addEdge("tools", "model")
    .addEdge("verify", END)
    .compile();
}

async function callGateway(
  gatewayUrl: string,
  apiKey: string,
  sessionId: string,
  target: EvaluationTarget,
  messages: AgentMessage[],
  maxOutputTokens: number,
  signal: AbortSignal,
  fetchImplementation: typeof fetch,
): Promise<{ body: AgentResponse; selectedModel: string }> {
  const response = await fetchImplementation(`${trimSlash(gatewayUrl)}/v1/messages`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "x-vartma-session-id": sessionId,
      "x-vartma-mode": target.kind === "fixed" ? "fixed" : target.mode,
      ...(target.kind === "fixed" ? { "x-vartma-model": target.model } : {}),
    },
    body: JSON.stringify({
      model: target.kind === "fixed" ? target.model : `vartma-${target.mode}`,
      max_tokens: maxOutputTokens,
      messages,
      tools: agentTools(),
    }),
  });
  if (!response.ok) {
    throw new EvaluationGatewayError(
      response.status,
      response.headers.get("x-vartma-model") ?? undefined,
    );
  }
  const selectedModel = response.headers.get("x-vartma-model");
  if (!selectedModel) {
    throw new Error("Gateway response omitted x-vartma-model.");
  }
  const body = (await response.json()) as AgentResponse;
  if (!Array.isArray(body.content)) {
    throw new Error("Gateway returned an invalid Anthropic-compatible evaluation response.");
  }
  return { body, selectedModel };
}

function safeExecutionFailure(error: unknown): string {
  if (error instanceof EvaluationGatewayError) return error.message;
  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return "Evaluation execution exceeded the suite timeout.";
  }
  return "Evaluation execution failed before verification.";
}

async function collectUsage(
  gatewayUrl: string,
  apiKey: string,
  sessionId: string,
  startedAt: Date,
  fetchImplementation: typeof fetch,
): Promise<UsageResponse> {
  const query = new URLSearchParams({
    session_id: sessionId,
    from: new Date(startedAt.getTime() - 1_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
    group_by: "model",
  });
  const response = await fetchImplementation(`${trimSlash(gatewayUrl)}/vartma/v1/usage?${query}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    throw new Error(`Usage collection returned HTTP ${String(response.status)}.`);
  }
  const usage = (await response.json()) as UsageResponse;
  if (!usage.totals || usage.totals.requestCount < 1 || usage.totals.attemptCount < 1) {
    throw new Error("No actual provider usage was recorded for the evaluation session.");
  }
  return usage;
}

async function executeAgentTool(
  name: string,
  input: Record<string, unknown>,
  workspace: string,
  allowedCommands: string[],
): Promise<string> {
  switch (name) {
    case "read_file": {
      const path = await safeExistingPath(workspace, requireString(input, "path"));
      return (await readFile(path, "utf8")).slice(0, 200_000);
    }
    case "write_file": {
      const path = await safeWritablePath(workspace, requireString(input, "path"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, requireString(input, "content"), "utf8");
      return `Wrote ${relative(workspace, path)}.`;
    }
    case "list_files": {
      const path = await safeExistingPath(workspace, optionalString(input, "path") ?? ".");
      return (await listFiles(path, workspace)).join("\n");
    }
    case "delete_file": {
      const path = await safeExistingPath(workspace, requireString(input, "path"));
      if (!(await lstat(path)).isFile()) throw new Error("delete_file accepts files only.");
      await unlink(path);
      return `Deleted ${relative(workspace, path)}.`;
    }
    case "run_command": {
      const command = requireString(input, "command");
      if (!allowedCommands.includes(command) && !allowedCommands.includes(basename(command))) {
        throw new Error(`Command "${command}" is not allowed by this evaluation task.`);
      }
      const args = optionalStringArray(input, "args");
      const result = await runCommand({ command, args, timeoutMs: 120_000 }, workspace, 120_000);
      if (!result.success) throw new Error(result.output);
      return result.output;
    }
    default:
      throw new Error(`Unknown evaluation tool "${name}".`);
  }
}

function agentTools() {
  return [
    tool(
      "read_file",
      "Read a UTF-8 file inside the evaluation workspace.",
      {
        path: { type: "string" },
      },
      ["path"],
    ),
    tool(
      "write_file",
      "Create or replace a UTF-8 file inside the evaluation workspace.",
      {
        path: { type: "string" },
        content: { type: "string" },
      },
      ["path", "content"],
    ),
    tool("list_files", "List files recursively inside a workspace directory.", {
      path: { type: "string" },
    }),
    tool(
      "delete_file",
      "Delete one file inside the disposable evaluation workspace.",
      {
        path: { type: "string" },
      },
      ["path"],
    ),
    tool(
      "run_command",
      "Run an explicitly allowlisted executable without a shell.",
      {
        command: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      ["command"],
    ),
  ];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    name,
    description,
    input_schema: { type: "object", properties, required, additionalProperties: false },
  };
}

async function runCommand(
  specification: EvaluationCommand,
  workspace: string,
  suiteTimeoutMs: number,
): Promise<{ success: boolean; output: string }> {
  const timeout = Math.min(specification.timeoutMs, suiteTimeoutMs);
  try {
    const { stdout, stderr } = await executeFile(specification.command, specification.args, {
      cwd: workspace,
      encoding: "utf8",
      windowsHide: true,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: safeCommandEnvironment(),
    });
    return { success: true, output: truncateCommandOutput(`${stdout}${stderr}`) };
  } catch (error) {
    const output = isRecord(error)
      ? `${typeof error["stdout"] === "string" ? error["stdout"] : ""}${typeof error["stderr"] === "string" ? error["stderr"] : ""}`
      : "";
    return {
      success: false,
      output: truncateCommandOutput(output || "Command failed without captured output."),
    };
  }
}

async function safeExistingPath(workspace: string, requested: string): Promise<string> {
  const candidate = lexicalWorkspacePath(workspace, requested);
  const actual = await realpath(candidate);
  assertWithinWorkspace(workspace, actual);
  return actual;
}

async function safeWritablePath(workspace: string, requested: string): Promise<string> {
  const candidate = lexicalWorkspacePath(workspace, requested);
  try {
    assertWithinWorkspace(workspace, await realpath(candidate));
    return candidate;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  let ancestor = dirname(candidate);
  while (ancestor !== workspace) {
    try {
      assertWithinWorkspace(workspace, await realpath(ancestor));
      return candidate;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      ancestor = dirname(ancestor);
    }
  }
  return candidate;
}

function lexicalWorkspacePath(workspace: string, requested: string): string {
  if (isAbsolute(requested)) throw new Error("Absolute paths are not allowed.");
  const candidate = resolve(workspace, requested);
  assertWithinWorkspace(workspace, candidate);
  return candidate;
}

function assertWithinWorkspace(workspace: string, candidate: string): void {
  const path = relative(workspace, candidate);
  if (path === "" || (!path.startsWith("..") && !isAbsolute(path))) return;
  throw new Error("Tool path escapes the evaluation workspace.");
}

async function listFiles(directory: string, workspace: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (output.length >= 2_000) return;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(relative(workspace, path));
    }
  };
  await visit(directory);
  return output.sort();
}

function safeCommandEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"];
  return Object.fromEntries(
    allowed.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
  );
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value) throw new Error(`Tool argument "${key}" is required.`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Tool argument "${key}" must be a string.`);
  return value;
}

function optionalStringArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Tool argument "${key}" must be an array of strings.`);
  }
  return (value as unknown[]).map((item) => item as string);
}

function safeToolError(error: unknown): string {
  return (error instanceof Error ? error.message : "Tool execution failed.").slice(0, 2_000);
}

function safeInteger(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Evaluation ${label} are outside the safe integer range.`);
  }
  return number;
}

function truncateCommandOutput(output: string): string {
  return output.slice(-100_000);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
