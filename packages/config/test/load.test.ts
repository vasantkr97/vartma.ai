import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, providerConfigSchema, routerConfigSchema } from "../src/index.js";

const validConfig = `
environment: test
server:
  host: 127.0.0.1
  port: 8080
  trustProxy: false
  requestBodyLimitBytes: 1048576
auth:
  enabled: true
  apiKeys:
    - test-api-key
database:
  url: postgresql://vartma:vartma@localhost:5432/vartma
  requiredForReadiness: false
routing:
  defaultMode: balanced
  defaultModel: fake/default
  routerVersion: rules-v0
providers:
  - id: fake
    type: fake
    enabled: true
    models:
      - id: fake/default
        provider: fake
        upstreamModel: fake-default
        enabled: true
        capabilities:
          text: true
          vision: false
          streaming: true
          tools: true
          structuredOutput: true
          reasoning: false
        contextWindow: 100000
        maxOutputTokens: 4096
        qualityTier: 1
        expectedLatencyTier: 1
        pricing:
          currency: USD
          effectiveFrom: 2026-07-23
          verifiedAt: 2026-07-23
          source: config test fixture
          inputPerMillion: 0
          cachedInputPerMillion: 0
          outputPerMillion: 0
telemetry:
  serviceName: vartma-ai-test
  logLevel: error
  langSmith:
    enabled: false
    apiKeyEnv: LANGSMITH_API_KEY
    project: vartma-ai-test
    exportContent: false
`;

describe("loadConfig", () => {
  it("loads YAML and applies environment overrides", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-"));
    const path = join(directory, "vartma.yaml");
    await writeFile(path, validConfig, "utf8");

    const config = await loadConfig({
      path,
      env: {
        VARTMA_PORT: "9090",
        VARTMA_API_KEYS: "first-key,second-key",
      },
    });

    expect(config.server.port).toBe(9090);
    expect(config.auth.apiKeys).toEqual(["first-key", "second-key"]);
    expect(config.providers[0]?.id).toBe("fake");
    expect(config.routing.priceBookVersion).toBe("prices-v1");
    expect(config.routing.policies.quality.qualityWeight).toBe(0.82);
    expect(config.routing.policies.eco.costWeight).toBe(0.68);
    expect(config.routing.session.switchScoreThreshold).toBe(0.06);
    expect(config.routing.fallback.maxAttempts).toBe(3);
    expect(config.routing.circuitBreaker.failureThreshold).toBe(3);
  });

  it("rejects an invalid environment port", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-"));
    const path = join(directory, "vartma.yaml");
    await writeFile(path, validConfig, "utf8");

    await expect(loadConfig({ path, env: { VARTMA_PORT: "not-a-port" } })).rejects.toThrow(
      "VARTMA_PORT must be an integer",
    );
  });

  it("rejects duplicate provider/model identifiers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-"));
    const path = join(directory, "vartma.yaml");
    await writeFile(path, validConfig, "utf8");
    const config = await loadConfig({ path, env: {} });

    expect(() =>
      routerConfigSchema.parse({
        ...config,
        providers: [...config.providers, structuredClone(config.providers[0]!)],
      }),
    ).toThrow("Duplicate provider id");
  });

  it("rejects mismatched model ownership and an unavailable default model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-"));
    const path = join(directory, "vartma.yaml");
    await writeFile(path, validConfig, "utf8");
    const config = await loadConfig({ path, env: {} });

    expect(() =>
      routerConfigSchema.parse({
        ...config,
        routing: { ...config.routing, defaultModel: "missing/default" },
        providers: config.providers.map((provider) => ({
          ...provider,
          models: provider.models.map((model) => ({ ...model, provider: "wrong-provider" })),
        })),
      }),
    ).toThrow("must match containing provider");
  });

  it("requires credentials for live providers and a base URL for compatible providers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-"));
    const path = join(directory, "vartma.yaml");
    await writeFile(path, validConfig, "utf8");
    const config = await loadConfig({ path, env: {} });
    const model = config.providers[0]!.models[0]!;

    expect(() =>
      providerConfigSchema.parse({
        id: "openai",
        type: "openai",
        enabled: false,
        models: [{ ...model, id: "openai/default", provider: "openai" }],
      }),
    ).toThrow("requires apiKeyEnv");
    expect(() =>
      providerConfigSchema.parse({
        id: "compatible",
        type: "openai-compatible",
        enabled: false,
        apiKeyEnv: "COMPATIBLE_API_KEY",
        models: [{ ...model, id: "compatible/default", provider: "compatible" }],
      }),
    ).toThrow("requires baseUrl");
  });

  it("requires a configured baseline to identify an enabled model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "router-config-"));
    const path = join(directory, "vartma.yaml");
    await writeFile(path, validConfig, "utf8");
    const config = await loadConfig({ path, env: {} });

    expect(() =>
      routerConfigSchema.parse({
        ...config,
        routing: { ...config.routing, baselineModel: "missing/baseline" },
      }),
    ).toThrow("Baseline model");
  });
});
