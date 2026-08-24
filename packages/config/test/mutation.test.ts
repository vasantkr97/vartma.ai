import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  initializeRouterConfig,
  loadConfig,
  mutateRouterConfig,
  readProviderDefinition,
  undoRouterConfigMutation,
} from "../src/index.js";

describe("router configuration mutations", () => {
  it("initializes without overwrite and removes only its own unchanged file on undo", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-init-"));
    const configPath = join(directory, "vartma.yaml");
    const initialized = await initializeRouterConfig({
      path: configPath,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    });

    expect(initialized.config.routing).toMatchObject({
      defaultMode: "balanced",
      defaultModel: "fake/default",
    });
    await expect(loadConfig({ path: configPath, env: {} })).resolves.toMatchObject({
      auth: { enabled: false },
    });
    await expect(initializeRouterConfig({ path: configPath })).rejects.toThrow("already exists");

    const undone = await undoRouterConfigMutation({ path: configPath });
    expect(undone).toMatchObject({
      operation: "init",
      removedInitializedFile: true,
      recoveredIncompleteMutation: false,
    });
    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stacks exact backups for mode and fixed-model changes and preserves YAML comments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-stack-"));
    const configPath = join(directory, "vartma.yaml");
    const original = `# operator comment\n${await readFile(
      resolve("configs", "vartma.example.yaml"),
      "utf8",
    )}`;
    await writeFile(configPath, original, "utf8");

    await mutateRouterConfig({
      path: configPath,
      mutation: { kind: "set-mode", mode: "eco" },
    });
    const afterMode = await readFile(configPath, "utf8");
    expect(afterMode).toContain("# operator comment");
    expect((await loadConfig({ path: configPath, env: {} })).routing.defaultMode).toBe("eco");

    await mutateRouterConfig({
      path: configPath,
      mutation: { kind: "use-model", modelId: "fake/default" },
    });
    expect((await loadConfig({ path: configPath, env: {} })).routing).toMatchObject({
      defaultMode: "fixed",
      defaultModel: "fake/default",
    });

    await undoRouterConfigMutation({ path: configPath });
    expect(await readFile(configPath, "utf8")).toBe(afterMode);
    await undoRouterConfigMutation({ path: configPath });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("adds, disables, re-enables, removes, and restores a validated provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-provider-"));
    const configPath = join(directory, "vartma.yaml");
    const providerPath = join(directory, "provider.yaml");
    await initializeRouterConfig({ path: configPath });
    await writeFile(providerPath, providerDefinitionYaml(), "utf8");
    const definition = await readProviderDefinition(providerPath);

    await mutateRouterConfig({
      path: configPath,
      mutation: { kind: "add-provider", provider: definition },
    });
    expect((await loadConfig({ path: configPath, env: {} })).providers).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "secondary", enabled: true })]),
    );

    await mutateRouterConfig({
      path: configPath,
      mutation: { kind: "set-baseline", modelId: "secondary/default" },
    });
    expect((await loadConfig({ path: configPath, env: {} })).routing.baselineModel).toBe(
      "secondary/default",
    );
    await expect(
      mutateRouterConfig({
        path: configPath,
        mutation: {
          kind: "set-provider-enabled",
          providerId: "secondary",
          enabled: false,
        },
      }),
    ).rejects.toThrow("owns baseline model");
    await undoRouterConfigMutation({ path: configPath });

    await mutateRouterConfig({
      path: configPath,
      mutation: { kind: "set-provider-enabled", providerId: "secondary", enabled: false },
    });
    expect(
      (await loadConfig({ path: configPath, env: {} })).providers.find(
        (provider) => provider.id === "secondary",
      )?.enabled,
    ).toBe(false);
    await undoRouterConfigMutation({ path: configPath });

    await mutateRouterConfig({
      path: configPath,
      mutation: { kind: "remove-provider", providerId: "secondary" },
    });
    expect(
      (await loadConfig({ path: configPath, env: {} })).providers.some(
        (provider) => provider.id === "secondary",
      ),
    ).toBe(false);
    await undoRouterConfigMutation({ path: configPath });
    expect(
      (await loadConfig({ path: configPath, env: {} })).providers.some(
        (provider) => provider.id === "secondary",
      ),
    ).toBe(true);
  });

  it("applies versioned calibration with backup and undo", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-calibration-"));
    const configPath = join(directory, "vartma.yaml");
    await initializeRouterConfig({
      path: configPath,
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    });

    const result = await mutateRouterConfig({
      path: configPath,
      mutation: {
        kind: "set-calibration",
        calibration: {
          enabled: true,
          version: "eval-v1",
          priorSampleSize: 10,
          models: {
            "fake/default": {
              tasks: {
                debugging: {
                  successRate: 0.75,
                  sampleSize: 20,
                  averageAttempts: 1.2,
                  observedAt: "2026-08-24T00:00:00.000Z",
                  source: "fixed-model test run",
                },
              },
            },
          },
        },
      },
    });

    expect(result.operation).toBe("calibration:eval-v1");
    expect(result.config.routing.calibration.version).toBe("eval-v1");
    await undoRouterConfigMutation({ path: configPath });
    expect((await loadConfig({ path: configPath })).routing.calibration.version).toBe(
      "uncalibrated",
    );
  });

  it("rejects unsafe provider/default-model mutations before writing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-safe-"));
    const configPath = join(directory, "vartma.yaml");
    await initializeRouterConfig({ path: configPath });
    const before = await readFile(configPath, "utf8");

    await expect(
      mutateRouterConfig({
        path: configPath,
        mutation: { kind: "remove-provider", providerId: "fake" },
      }),
    ).rejects.toThrow("owns default model");
    await expect(
      mutateRouterConfig({
        path: configPath,
        mutation: { kind: "set-provider-enabled", providerId: "fake", enabled: false },
      }),
    ).rejects.toThrow("owns default model");
    await expect(
      mutateRouterConfig({
        path: configPath,
        mutation: { kind: "use-model", modelId: "missing/model" },
      }),
    ).rejects.toThrow("Enabled model");
    await expect(
      mutateRouterConfig({
        path: configPath,
        mutation: { kind: "set-baseline", modelId: "missing/model" },
      }),
    ).rejects.toThrow("Enabled baseline model");
    expect(await readFile(configPath, "utf8")).toBe(before);
  });

  it("blocks undo and further mutation after external drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-drift-"));
    const configPath = join(directory, "vartma.yaml");
    await initializeRouterConfig({ path: configPath });
    await mutateRouterConfig({
      path: configPath,
      mutation: { kind: "set-mode", mode: "eco" },
    });
    await writeFile(configPath, `${await readFile(configPath, "utf8")}# external edit\n`, "utf8");

    await expect(undoRouterConfigMutation({ path: configPath })).rejects.toThrow(
      "drift was detected",
    );
    await expect(
      mutateRouterConfig({
        path: configPath,
        mutation: { kind: "set-mode", mode: "quality" },
      }),
    ).rejects.toThrow("drift was detected");
  });

  it("refuses concurrent operations when the configuration lock exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-lock-"));
    const configPath = join(directory, "vartma.yaml");
    await writeFile(`${configPath}.vartma.lock`, "held", "utf8");

    await expect(initializeRouterConfig({ path: configPath })).rejects.toThrow(
      "Another vartma configuration operation",
    );
    await expect(access(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function providerDefinitionYaml(): string {
  return `id: secondary
type: fake
enabled: true
models:
  - id: secondary/default
    provider: secondary
    upstreamModel: secondary-default
    enabled: true
    capabilities:
      text: true
      vision: false
      streaming: true
      tools: true
      structuredOutput: true
      reasoning: false
    contextWindow: 32000
    maxOutputTokens: 4096
    qualityTier: 2
    expectedLatencyTier: 1
    pricing:
      currency: USD
      effectiveFrom: 2026-07-28
      verifiedAt: 2026-07-28
      source: test
      inputPerMillion: 0
      cachedInputPerMillion: 0
      outputPerMillion: 0
`;
}
