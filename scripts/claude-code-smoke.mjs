import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createApp } from "../apps/gateway/dist/index.js";
import { configureClaudeCode } from "../apps/cli/dist/claude-code-settings.js";
import { loadConfig } from "../packages/config/dist/index.js";
import { ProviderRegistry } from "../packages/providers/dist/index.js";

const apiKey = "claude-code-smoke-key";
const marker = "VARTMA_SMOKE_OK";
const temporaryRoot = await mkdtemp(join(tmpdir(), "router-claude-smoke-"));

try {
  const config = await loadConfig({
    path: resolve(process.env.VARTMA_CONFIG_PATH ?? "./configs/vartma.example.yaml"),
  });
  config.auth.enabled = true;
  config.auth.apiKeys = [apiKey];
  config.database.requiredForReadiness = false;
  config.telemetry.logLevel = process.env.CLAUDE_SMOKE_LOG_LEVEL ?? "fatal";
  const smokeModel = config.providers
    .find((provider) => provider.type === "fake")
    ?.models.find((model) => model.id === config.routing.defaultModel);
  if (!smokeModel) {
    throw new Error("Smoke configuration must contain the enabled default fake model.");
  }
  smokeModel.qualityTier = 4;
  smokeModel.maxOutputTokens = 64_000;
  const taskPath = join(temporaryRoot, "router-smoke-task.txt");
  await writeFile(taskPath, `Completion marker: ${marker}\n`, "utf8");
  const smokeProvider = createClaudeCodeSmokeProvider(smokeModel, taskPath, marker);
  const registry = new ProviderRegistry();
  registry.register(smokeProvider);

  const app = createApp({
    config,
    runtime: {
      registry,
      models: new Map([[smokeModel.id, smokeModel]]),
    },
  });
  const server = await listen(app);
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Smoke gateway did not bind a TCP port.");
    }

    const settingsPath = join(temporaryRoot, "isolated-settings.json");
    await configureClaudeCode({
      settingsPath,
      gatewayUrl: `http://127.0.0.1:${address.port}`,
      apiKey,
      mode: "balanced",
    });

    const executable =
      process.env.CLAUDE_CODE_EXECUTABLE ??
      (process.platform === "win32" ? "claude.exe" : "claude");
    const version = await run(executable, ["--version"], sanitizedEnvironment(), temporaryRoot);
    assertSuccess(version, "version check");

    const debugPath = join(temporaryRoot, "claude-debug.log");
    let result;
    try {
      result = await run(
        executable,
        [
          "--safe-mode",
          "--settings",
          settingsPath,
          "--setting-sources",
          "local",
          "--no-session-persistence",
          "--tools",
          "Read",
          "--prompt-suggestions",
          "false",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--debug-file",
          debugPath,
          "--verbose",
          "--print",
          `Use the Read tool to read "${taskPath}", then respond with exactly the completion marker from that file.`,
        ],
        {
          ...sanitizedEnvironment(),
          CLAUDE_CONFIG_DIR: join(temporaryRoot, "claude-home"),
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_DISABLE_THINKING: "1",
        },
        temporaryRoot,
      );
    } catch (error) {
      const debug = await readFile(debugPath, "utf8").catch(() => "");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nClaude debug tail:\n${debug.slice(-12_000)}`,
        { cause: error },
      );
    }
    assertSuccess(result, "routed request");
    if (!result.stdout.includes(marker)) {
      throw new Error(`Claude Code did not return the routed marker.\n${diagnostic(result)}`);
    }
    if (!result.stdout.includes('"type":"stream_event"')) {
      throw new Error(`Claude Code did not expose streaming events.\n${diagnostic(result)}`);
    }
    if (!result.stdout.includes('"name":"Read"') || smokeProvider.requestCount !== 2) {
      throw new Error(
        `Claude Code did not complete the expected Read tool loop.\nProvider requests: ${smokeProvider.requestCount}\n${diagnostic(result)}`,
      );
    }

    process.stdout.write(
      `Claude Code ${version.stdout.trim()} reached the router and completed a streamed request.\n`,
    );
  } finally {
    await new Promise((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function sanitizedEnvironment() {
  const environment = { ...process.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_VERTEX",
  ]) {
    delete environment[key];
  }
  return environment;
}

function listen(app) {
  return new Promise((resolveServer, reject) => {
    const server = app.listen(0, "127.0.0.1", () => resolveServer(server));
    server.once("error", reject);
  });
}

function run(executable, arguments_, environment, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, arguments_, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error(`Claude Code smoke test exceeded 60 seconds.\n${diagnostic({ stdout, stderr })}`),
      );
    }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

function appendBounded(current, addition) {
  const next = current + addition;
  if (Buffer.byteLength(next, "utf8") > 2 * 1024 * 1024) {
    throw new Error("Claude Code smoke output exceeded 2 MiB.");
  }
  return next;
}

function assertSuccess(result, operation) {
  if (result.code !== 0) {
    throw new Error(
      `Claude Code ${operation} failed with exit ${result.code}.\n${diagnostic(result)}`,
    );
  }
}

function diagnostic(result) {
  return `stdout:\n${result.stdout.slice(-4000)}\nstderr:\n${result.stderr.slice(-4000)}`;
}

function createClaudeCodeSmokeProvider(modelDefinition, taskPath, completionMarker) {
  return new (class ClaudeCodeSmokeProvider {
    name = "fake";
    requestCount = 0;

    constructor() {
      this.model = modelDefinition;
      this.taskPath = taskPath;
      this.marker = completionMarker;
    }

    models() {
      return Promise.resolve([this.model]);
    }

    capabilities() {
      return this.model.capabilities;
    }

    estimateTokens(request) {
      const characters = request.messages.reduce(
        (sum, message) =>
          sum +
          message.content.reduce(
            (blockSum, block) =>
              blockSum +
              (block.type === "text"
                ? block.text.length
                : block.type === "tool_result" && typeof block.content === "string"
                  ? block.content.length
                  : 0),
            0,
          ),
        0,
      );
      return Promise.resolve({
        inputTokens: Math.max(1, Math.ceil(characters / 4)),
        expectedOutputTokens: 32,
      });
    }

    health() {
      return Promise.resolve({
        healthy: true,
        observedAt: new Date().toISOString(),
        latencyMs: 0,
      });
    }

    async *execute(model, request) {
      this.requestCount += 1;
      const estimate = await this.estimateTokens(request);
      const responseId = `smoke_${this.requestCount}`;
      yield {
        type: "response.started",
        responseId,
        provider: this.name,
        model,
        inputTokens: estimate.inputTokens,
      };

      const hasToolResult = request.messages.some((message) =>
        message.content.some((block) => block.type === "tool_result"),
      );
      if (!hasToolResult) {
        const readTool = request.tools.find((tool) => tool.name === "Read");
        if (!readTool) {
          throw new Error("Claude Code did not send the Read tool definition.");
        }
        const toolCallId = "tool_smoke_read";
        yield {
          type: "tool_call.started",
          index: 0,
          toolCallId,
          name: readTool.name,
        };
        yield {
          type: "tool_call.arguments.delta",
          index: 0,
          toolCallId,
          partialJson: JSON.stringify({ file_path: this.taskPath }),
        };
        yield { type: "tool_call.completed", index: 0, toolCallId };
        const usage = usageFor(estimate.inputTokens, 8);
        yield { type: "usage.updated", usage };
        yield { type: "response.completed", finishReason: "tool_use", usage };
        return;
      }

      yield { type: "content.started", index: 0, contentType: "text" };
      yield { type: "text.delta", index: 0, text: this.marker };
      yield { type: "content.completed", index: 0 };
      const usage = usageFor(estimate.inputTokens, 4);
      yield { type: "usage.updated", usage };
      yield { type: "response.completed", finishReason: "end_turn", usage };
    }
  })();
}

function usageFor(inputTokens, outputTokens) {
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    reasoningTokens: 0,
  };
}
