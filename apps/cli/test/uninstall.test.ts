import { describe, expect, it, vi } from "vitest";

import { uninstallVartma } from "../src/uninstall.js";

describe("vartma uninstall", () => {
  it("stops the owned gateway and restores Claude settings managed by Vartma", async () => {
    const stopGateway = vi.fn(() =>
      Promise.resolve({
        pid: 123,
        instanceId: "00000000-0000-4000-8000-000000000000",
        healthUrl: "http://127.0.0.1:8080/healthz",
        statePath: "C:/test/vartma.yaml.vartma-server.json",
        stopped: true,
      }),
    );
    const inspectClaude = vi.fn(() =>
      Promise.resolve({
        configured: true as const,
        state: "active" as const,
        settingsPath: "C:/test/.claude/settings.json",
        statePath: "C:/test/.claude/.vartma-state.json",
      }),
    );
    const restoreClaude = vi.fn(() =>
      Promise.resolve({
        settingsPath: "C:/test/.claude/settings.json",
        restoredFrom: "C:/test/.claude/.vartma-backups/baseline.json",
      }),
    );

    await expect(
      uninstallVartma(
        {
          configPath: "C:/test/vartma.yaml",
          claudeLocation: { settingsPath: "C:/test/.claude/settings.json" },
          openAIEnvPath: "C:/test/.env",
          shutdownTimeoutMs: 5_000,
        },
        {
          stopGateway,
          inspectClaude,
          restoreClaude,
          inspectOpenAI: () =>
            Promise.resolve({
              configured: false,
              state: "not_configured",
              envPath: "C:/test/.env",
              statePath: "C:/test/.env.vartma-openai-state.json",
            }),
        },
      ),
    ).resolves.toEqual({
      gateway: "stopped",
      claudeCode: "restored",
      openAIClient: "not_configured",
      restoredSettingsPath: "C:/test/.claude/settings.json",
      retainedBackupPath: "C:/test/.claude/.vartma-backups/baseline.json",
    });
    expect(stopGateway).toHaveBeenCalledOnce();
    expect(restoreClaude).toHaveBeenCalledOnce();
  });

  it("is idempotent when no managed gateway or Claude configuration exists", async () => {
    const restoreClaude = vi.fn();
    await expect(
      uninstallVartma(
        {
          configPath: "C:/test/vartma.yaml",
          claudeLocation: { settingsPath: "C:/test/.claude/settings.json" },
          openAIEnvPath: "C:/test/.env",
          shutdownTimeoutMs: 5_000,
        },
        {
          stopGateway: () => Promise.resolve(undefined),
          inspectClaude: () =>
            Promise.resolve({
              configured: false,
              state: "not_configured",
              settingsPath: "C:/test/.claude/settings.json",
              statePath: "C:/test/.claude/.vartma-state.json",
            }),
          restoreClaude,
          inspectOpenAI: () =>
            Promise.resolve({
              configured: false,
              state: "not_configured",
              envPath: "C:/test/.env",
              statePath: "C:/test/.env.vartma-openai-state.json",
            }),
        },
      ),
    ).resolves.toEqual({
      gateway: "not_running",
      claudeCode: "not_configured",
      openAIClient: "not_configured",
    });
    expect(restoreClaude).not.toHaveBeenCalled();
  });

  it("restores a managed OpenAI dotenv configuration", async () => {
    const restoreOpenAI = vi.fn(() =>
      Promise.resolve({
        envPath: "C:/test/.env",
        restoredFrom: "C:/test/.env.vartma-backups/baseline",
      }),
    );
    const result = await uninstallVartma(
      {
        configPath: "C:/test/vartma.yaml",
        claudeLocation: { settingsPath: "C:/test/.claude/settings.json" },
        openAIEnvPath: "C:/test/.env",
        shutdownTimeoutMs: 5_000,
      },
      {
        stopGateway: () => Promise.resolve(undefined),
        inspectClaude: () =>
          Promise.resolve({
            configured: false,
            state: "not_configured",
            settingsPath: "C:/test/.claude/settings.json",
            statePath: "C:/test/.claude/.vartma-state.json",
          }),
        inspectOpenAI: () =>
          Promise.resolve({
            configured: true,
            state: "active",
            envPath: "C:/test/.env",
            statePath: "C:/test/.env.vartma-openai-state.json",
          }),
        restoreOpenAI,
      },
    );
    expect(result).toMatchObject({
      openAIClient: "restored",
      restoredOpenAIEnvPath: "C:/test/.env",
      retainedOpenAIBackupPath: "C:/test/.env.vartma-backups/baseline",
    });
    expect(restoreOpenAI).toHaveBeenCalledOnce();
  });
});
