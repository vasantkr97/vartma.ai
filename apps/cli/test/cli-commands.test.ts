import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
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
      "trace",
      "sessions",
    ]) {
      expect(stdout).toContain(command);
    }
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

function runCli(arguments_: string[]) {
  return execFileAsync(process.execPath, [routerCli, ...arguments_], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    timeout: 30_000,
    windowsHide: true,
  });
}
