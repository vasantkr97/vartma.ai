import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  claudeCodeStatus,
  configureClaudeCode,
  setClaudeCodeBypass,
  undoClaudeCodeConfiguration,
} from "../src/claude-code-settings.js";

describe("Claude Code settings management", () => {
  it("configures, bypasses, re-enables, and undoes without losing unrelated settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-claude-settings-"));
    const settingsPath = join(directory, "settings.json");
    await writeJson(settingsPath, {
      env: {
        ANTHROPIC_BASE_URL: "https://baseline.example",
        ANTHROPIC_API_KEY: "baseline-key",
        KEEP_ME: "yes",
      },
      permissions: { allow: ["Read"] },
    });

    const configured = await configureClaudeCode({
      settingsPath,
      gatewayUrl: "http://127.0.0.1:8080/",
      apiKey: "router-test-key",
      mode: "balanced",
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    });
    expect(configured.gatewayUrl).toBe("http://127.0.0.1:8080");
    expect(await claudeCodeStatus({ settingsPath })).toMatchObject({
      configured: true,
      state: "active",
      mode: "balanced",
    });
    const routed = await readJson(settingsPath);
    expect(routed).toMatchObject({
      permissions: { allow: ["Read"] },
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
        ANTHROPIC_AUTH_TOKEN: "router-test-key",
        ANTHROPIC_MODEL: "claude-vartma-balanced",
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        KEEP_ME: "yes",
      },
    });
    expect((routed["env"] as Record<string, unknown>)["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect((routed["env"] as Record<string, unknown>)["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"]).toBe(
      "1",
    );
    expect(
      (routed["env"] as Record<string, unknown>)["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
    ).toBeUndefined();

    await writeJson(settingsPath, {
      ...routed,
      theme: "dark",
      env: { ...(routed["env"] as Record<string, unknown>), UNRELATED_AFTER_SETUP: "kept" },
    });
    const bypassed = await setClaudeCodeBypass(true, { settingsPath });
    expect(bypassed.state).toBe("bypassed");
    const baselineActive = await readJson(settingsPath);
    expect(baselineActive).toMatchObject({
      theme: "dark",
      env: {
        ANTHROPIC_BASE_URL: "https://baseline.example",
        ANTHROPIC_API_KEY: "baseline-key",
        KEEP_ME: "yes",
        UNRELATED_AFTER_SETUP: "kept",
      },
    });
    expect((baselineActive["env"] as Record<string, unknown>)["ANTHROPIC_AUTH_TOKEN"]).toBe(
      undefined,
    );

    const active = await setClaudeCodeBypass(false, { settingsPath });
    expect(active.state).toBe("active");
    expect(await readJson(settingsPath)).toMatchObject({
      theme: "dark",
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
        ANTHROPIC_AUTH_TOKEN: "router-test-key",
        UNRELATED_AFTER_SETUP: "kept",
      },
    });

    const undone = await undoClaudeCodeConfiguration({ settingsPath });
    expect(undone.restoredFrom).toBe(configured.baselineBackupPath);
    const restored = await readJson(settingsPath);
    expect(restored).toMatchObject({
      theme: "dark",
      env: {
        ANTHROPIC_BASE_URL: "https://baseline.example",
        ANTHROPIC_API_KEY: "baseline-key",
        UNRELATED_AFTER_SETUP: "kept",
      },
    });
    expect(await claudeCodeStatus({ settingsPath })).toMatchObject({
      configured: false,
      state: "not_configured",
    });
    await expect(access(configured.baselineBackupPath)).resolves.toBeUndefined();
  });

  it("preserves the original baseline across reconfiguration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-claude-reconfigure-"));
    const settingsPath = join(directory, "settings.json");
    await writeJson(settingsPath, {
      env: { ANTHROPIC_BASE_URL: "https://original.example" },
    });

    const first = await configureClaudeCode({
      settingsPath,
      gatewayUrl: "http://localhost:8080",
      apiKey: "first-router-key",
      mode: "eco",
    });
    const second = await configureClaudeCode({
      settingsPath,
      gatewayUrl: "http://localhost:9090",
      apiKey: "second-router-key",
      mode: "quality",
    });

    expect(second.reconfigured).toBe(true);
    expect(second.baselineBackupPath).toBe(first.baselineBackupPath);
    expect(await readJson(settingsPath)).toMatchObject({
      env: {
        ANTHROPIC_BASE_URL: "http://localhost:9090",
        ANTHROPIC_MODEL: "claude-vartma-quality",
      },
    });
    await undoClaudeCodeConfiguration({ settingsPath });
    expect(await readJson(settingsPath)).toMatchObject({
      env: { ANTHROPIC_BASE_URL: "https://original.example" },
    });
  });

  it("detects managed-setting drift without exposing credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-claude-drift-"));
    const settingsPath = join(directory, "settings.json");
    await configureClaudeCode({
      settingsPath,
      gatewayUrl: "http://localhost:8080",
      apiKey: "router-secret-key",
      mode: "balanced",
    });
    const settings = await readJson(settingsPath);
    await writeJson(settingsPath, {
      ...settings,
      env: {
        ...(settings["env"] as Record<string, unknown>),
        ANTHROPIC_BASE_URL: "http://localhost:9999",
      },
    });

    const status = await claudeCodeStatus({ settingsPath });
    expect(status.state).toBe("drifted");
    expect(JSON.stringify(status)).not.toContain("router-secret-key");
  });

  it("rejects malformed settings and invalid gateway URLs before writing state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-claude-invalid-"));
    const settingsPath = join(directory, "settings.json");
    await writeFile(settingsPath, "{not-json", "utf8");

    await expect(
      configureClaudeCode({
        settingsPath,
        gatewayUrl: "http://localhost:8080/v1",
        apiKey: "router-test-key",
        mode: "balanced",
      }),
    ).rejects.toThrow("without a path such as /v1");

    await expect(
      configureClaudeCode({
        settingsPath,
        gatewayUrl: "http://localhost:8080",
        apiKey: "router-test-key",
        mode: "balanced",
      }),
    ).rejects.toThrow("Invalid JSON");
    expect(await claudeCodeStatus({ settingsPath })).toMatchObject({
      configured: false,
    });
  });

  it("resolves user and project settings paths deterministically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-claude-paths-"));
    expect(
      (
        await claudeCodeStatus({
          scope: "user",
          homeDirectory: directory,
        })
      ).settingsPath,
    ).toBe(join(directory, ".claude", "settings.json"));
    expect(
      (
        await claudeCodeStatus({
          scope: "project",
          cwd: directory,
        })
      ).settingsPath,
    ).toBe(join(directory, ".claude", "settings.local.json"));
  });

  it("gitignores project-local settings, state, and credential-bearing backups", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-claude-project-"));
    await configureClaudeCode({
      scope: "project",
      cwd: directory,
      gatewayUrl: "http://localhost:8080",
      apiKey: "router-project-key",
      mode: "balanced",
    });

    const gitignore = await readFile(join(directory, ".gitignore"), "utf8");
    expect(gitignore).toContain(".claude/settings.local.json");
    expect(gitignore).toContain(".claude/.vartma-state.json");
    expect(gitignore).toContain(".claude/.vartma-backups/");

    await configureClaudeCode({
      scope: "project",
      cwd: directory,
      gatewayUrl: "http://localhost:9090",
      apiKey: "router-project-key",
      mode: "eco",
    });
    const updatedGitignore = await readFile(join(directory, ".gitignore"), "utf8");
    expect(updatedGitignore.match(/\.claude\/settings\.local\.json/g)).toHaveLength(1);
    expect(updatedGitignore.match(/\.claude\/\.vartma-state\.json/g)).toHaveLength(1);
    expect(updatedGitignore.match(/\.claude\/\.vartma-backups\//g)).toHaveLength(1);
  });
});

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
