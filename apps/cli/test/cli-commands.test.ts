import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const workspace = resolve(".");
const routerCli = resolve("apps", "cli", "dist", "index.js");
const exampleConfig = resolve("configs", "vartma.example.yaml");

describe("vartma commands", () => {
  it("lists enabled models as machine-readable JSON", async () => {
    const { stdout, stderr } = await runCli(["models", "--config", exampleConfig, "--json"]);
    expect(stderr).toBe("");
    const models = JSON.parse(stdout) as Array<Record<string, unknown>>;
    expect(models).toEqual([
      expect.objectContaining({
        id: "fake/default",
        provider: "fake",
        providerType: "fake",
        upstreamModel: "fake-default",
      }),
    ]);
  }, 30_000);

  it("tests the selected fake provider without requiring gateway or database access", async () => {
    const { stdout, stderr } = await runCli([
      "provider",
      "test",
      "fake",
      "--config",
      exampleConfig,
      "--json",
    ]);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as {
      ok: boolean;
      checks: Array<Record<string, unknown>>;
    };
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual([
      expect.objectContaining({
        id: "provider:fake:fake-default",
        category: "provider",
        status: "pass",
      }),
    ]);
  }, 30_000);

  it("executes deliberate provider conformance through the selected model", async () => {
    const { stdout, stderr } = await runCli([
      "provider",
      "conformance",
      "fake",
      "--config",
      exampleConfig,
      "--timeout",
      "300000",
      "--json",
    ]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      passed: true,
      reports: [
        {
          configuredModel: "fake/default",
          provider: "fake",
          model: "fake-default",
          passed: true,
          checks: {
            health: true,
            tokenEstimate: true,
            lifecycle: true,
            contentBlocks: true,
            toolJson: true,
          },
        },
      ],
    });
  }, 30_000);

  it("reports secret-safe offline operator status as JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-cli-status-"));
    const { stdout, stderr } = await runCli([
      "status",
      "--offline",
      "--config",
      exampleConfig,
      "--settings-path",
      join(directory, "settings.json"),
      "--json",
    ]);
    expect(stderr).toBe("");
    const status = JSON.parse(stdout) as {
      ok: boolean;
      configuration: Record<string, unknown>;
      gateway: Record<string, unknown>;
      claudeCode: Record<string, unknown>;
    };
    expect(status).toMatchObject({
      ok: true,
      configuration: {
        state: "valid",
        defaultMode: "balanced",
        defaultModel: "fake/default",
      },
      gateway: { state: "skipped", reason: "offline_requested" },
      claudeCode: { state: "not_configured" },
    });
    expect(stdout).not.toContain("local-development-key");
    expect(stdout).not.toContain("postgresql://");
  }, 30_000);

  it("advertises diagnostics and inspection commands in help", async () => {
    const { stdout } = await runCli(["--help"]);
    for (const command of [
      "init",
      "config",
      "doctor",
      "models",
      "provider",
      "mode",
      "use",
      "baseline",
      "eval",
      "trace",
      "sessions",
      "start",
      "stop",
      "login",
      "uninstall",
    ]) {
      expect(stdout).toContain(command);
    }
  }, 30_000);

  it("stores a provider key encrypted and references it without writing secrets to YAML", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-cli-login-"));
    const configPath = join(directory, "vartma.yaml");
    const storePath = join(directory, ".vartma", "credentials.enc");
    const providerSecret = "openai-provider-secret-value";
    const masterKey = "cli-login-master-passphrase";
    await writeFile(configPath, await readFile(exampleConfig, "utf8"), "utf8");

    const { stdout, stderr } = await runCli(
      ["login", "openai", "--from-env", "LOGIN_PROVIDER_KEY", "--config", configPath],
      {
        VARTMA_MASTER_KEY: masterKey,
        LOGIN_PROVIDER_KEY: providerSecret,
      },
    );
    expect(stderr).toBe("");
    expect(stdout).toContain('Stored encrypted credential for provider "openai"');
    expect(stdout).not.toContain(providerSecret);
    const config = await readFile(configPath, "utf8");
    const encrypted = await readFile(storePath, "utf8");
    expect(config).toContain("credentialRef: openai");
    expect(config).not.toContain(providerSecret);
    expect(config).not.toContain(masterKey);
    expect(encrypted).not.toContain(providerSecret);
    expect(encrypted).not.toContain(masterKey);
  }, 30_000);

  it("configures and exactly removes OpenAI-compatible dotenv routing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-cli-openai-config-"));
    const envPath = join(directory, ".env");
    await writeFile(envPath, "UNRELATED=preserved\n", "utf8");

    const configured = await runCli([
      "configure",
      "openai",
      "--config",
      exampleConfig,
      "--env-path",
      envPath,
      "--mode",
      "eco",
    ]);
    expect(configured.stderr).toBe("");
    expect(configured.stdout).toContain("OpenAI-compatible clients can now route");
    expect(configured.stdout).not.toContain("local-development-key");
    expect(await readFile(envPath, "utf8")).toContain('OPENAI_MODEL="vartma-eco"');

    await runCli(["configure", "openai", "--undo", "--env-path", envPath]);
    expect(await readFile(envPath, "utf8")).toBe("UNRELATED=preserved\n");
  }, 30_000);

  it("summarizes results and writes reusable routing calibration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-cli-eval-"));
    const resultsPath = join(directory, "results.jsonl");
    const calibrationPath = join(directory, "calibration.json");
    const configPath = join(directory, "vartma.yaml");
    await runCli(["init", "--config", configPath]);
    const base = {
      runId: "run-1",
      taskClass: "debugging",
      environment: {
        dataset: "terminal-bench",
        datasetVersion: "2.0",
        harnessVersion: "vartma-eval-v1",
        promptTemplateVersion: "coding-agent-v1",
        timeoutMs: 900_000,
        maxAttempts: 3,
        cacheEnabled: true,
      },
      target: { kind: "fixed", model: "fake/default" },
      selectedModel: "fake/default",
      attempts: 1,
      latencyMs: 1000,
      actualCostUsd: "0.25",
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 20,
      reasoningTokens: 0,
      completedAt: "2026-08-24T00:00:00.000Z",
    };
    await writeFile(
      resultsPath,
      [
        JSON.stringify({ ...base, taskId: "task-1", success: true }),
        JSON.stringify({ ...base, taskId: "task-2", success: false, attempts: 2 }),
      ].join("\n"),
      "utf8",
    );

    const summary = await runCli(["eval", "summarize", resultsPath, "--json"]);
    expect(JSON.parse(summary.stdout)).toMatchObject({
      comparable: true,
      targets: [{ target: "fixed:fake/default", solved: 1, tasks: 2 }],
    });

    await runCli([
      "eval",
      "calibrate",
      resultsPath,
      "--calibration-version",
      "eval-v1",
      "--output",
      calibrationPath,
      "--config",
      configPath,
      "--apply",
    ]);
    expect(JSON.parse(await readFile(calibrationPath, "utf8"))).toMatchObject({
      version: "eval-v1",
      models: {
        "fake/default": {
          tasks: { debugging: { successRate: 0.5, sampleSize: 2 } },
        },
      },
    });
    expect(await readFile(configPath, "utf8")).toContain("version: eval-v1");
  }, 30_000);

  it("initializes, changes mode, fixes a model, and rolls each change back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-cli-config-"));
    const configPath = join(directory, "vartma.yaml");

    expect((await runCli(["init", "--config", configPath])).stdout).toContain(
      "Router configuration created",
    );
    expect((await runCli(["mode", "eco", "--config", configPath])).stdout).toContain(
      "Applied mode:eco",
    );
    expect((await runCli(["use", "fake/default", "--config", configPath])).stdout).toContain(
      "Applied use:fake/default",
    );
    expect(await readFile(configPath, "utf8")).toContain("defaultMode: fixed");

    await runCli(["config", "undo", "--config", configPath]);
    expect(await readFile(configPath, "utf8")).toContain("defaultMode: eco");
    await runCli(["config", "undo", "--config", configPath]);
    expect(await readFile(configPath, "utf8")).toContain("defaultMode: balanced");
  }, 30_000);

  it("requires a terminal or definition file for provider add", async () => {
    await expect(runCli(["provider", "add", "--config", exampleConfig])).rejects.toThrow(
      "Interactive provider setup requires a terminal",
    );
  }, 30_000);
});

function runCli(arguments_: string[], environment: NodeJS.ProcessEnv = {}) {
  return execFileAsync(process.execPath, [routerCli, ...arguments_], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      ...environment,
    },
    timeout: 30_000,
    windowsHide: true,
  });
}
