import { routerConfigSchema } from "@vartma/config";
import type { loadConfig } from "@vartma/config";
import { describe, expect, it, vi } from "vitest";

import type { claudeCodeStatus } from "../src/claude-code-settings.js";
import { formatOperatorStatus, runOperatorStatus } from "../src/operator-status.js";

describe("vartma operator status", () => {
  it("reports config, gateway, provider credentials, and Claude state without secrets", async () => {
    const config = statusConfig();
    const fetchImplementation = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"status":"ready"}', { status: 200 })),
    );
    const report = await runOperatorStatus(
      {
        configPath: "./vartma.yaml",
        claudeLocation: { settingsPath: "C:/test/.claude/settings.json" },
        openAIEnvPath: "C:/test/.env",
        timeoutMs: 1_000,
        offline: false,
      },
      {
        environment: {
          STATUS_OPENAI_KEY: "provider-secret-value",
        },
        fetchImplementation,
        loadConfigImplementation: vi.fn<typeof loadConfig>(() => Promise.resolve(config)),
        claudeStatusImplementation: vi.fn<typeof claudeCodeStatus>(() =>
          Promise.resolve({
            configured: true,
            state: "active",
            settingsPath: "C:/test/.claude/settings.json",
            statePath: "C:/test/.claude/.vartma-state.json",
            gatewayUrl: "http://127.0.0.1:8080",
            mode: "balanced",
            baselineBackupPath: "C:/test/credential-bearing-backup.json",
          }),
        ),
        openAIStatusImplementation: () =>
          Promise.resolve({
            configured: false,
            state: "not_configured",
            envPath: "C:/test/.env",
            statePath: "C:/test/.env.vartma-openai-state.json",
          }),
        now: () => new Date("2026-07-28T00:00:00.000Z"),
      },
    );

    expect(report).toMatchObject({
      ok: true,
      generatedAt: "2026-07-28T00:00:00.000Z",
      configuration: {
        state: "valid",
        defaultMode: "balanced",
        defaultModel: "fake/default",
        authenticationEnabled: true,
        configuredGatewayKeyCount: 1,
        databaseRequiredForReadiness: true,
        providers: [
          {
            id: "fake",
            enabled: true,
            enabledModelCount: 1,
            credentialPresent: true,
          },
          {
            id: "openai",
            enabled: false,
            enabledModelCount: 0,
            credentialEnvironment: "STATUS_OPENAI_KEY",
            credentialPresent: true,
          },
        ],
      },
      gateway: {
        state: "ready",
        url: "http://127.0.0.1:8080/readyz",
        statusCode: 200,
      },
      claudeCode: {
        configured: true,
        state: "active",
        gatewayUrl: "http://127.0.0.1:8080",
        mode: "balanced",
      },
      openAIClient: { configured: false, state: "not_configured", envPath: "C:/test/.env" },
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("provider-secret-value");
    expect(serialized).not.toContain("router-gateway-secret");
    expect(serialized).not.toContain("database-password");
    expect(serialized).not.toContain("credential-bearing-backup");
    expect(formatOperatorStatus(report)).toContain("Status result: PASS");
  });

  it("reports a missing config without attempting gateway readiness", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const missing = Object.assign(new Error("secret path details"), { code: "ENOENT" });
    const report = await runOperatorStatus(
      {
        configPath: "./missing.yaml",
        claudeLocation: { settingsPath: "C:/test/.claude/settings.json" },
        openAIEnvPath: "C:/test/.env",
        timeoutMs: 1_000,
        offline: false,
      },
      {
        fetchImplementation,
        loadConfigImplementation: vi.fn<typeof loadConfig>(() => Promise.reject(missing)),
        claudeStatusImplementation: vi.fn<typeof claudeCodeStatus>(() =>
          Promise.resolve({
            configured: false,
            state: "not_configured",
            settingsPath: "C:/test/.claude/settings.json",
            statePath: "C:/test/.claude/.vartma-state.json",
          }),
        ),
        openAIStatusImplementation: () =>
          Promise.resolve({
            configured: false,
            state: "not_configured",
            envPath: "C:/test/.env",
            statePath: "C:/test/.env.vartma-openai-state.json",
          }),
      },
    );

    expect(report).toMatchObject({
      ok: false,
      configuration: { state: "missing" },
      gateway: { state: "skipped", reason: "configuration_unavailable" },
      claudeCode: { state: "not_configured" },
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain("secret path details");
  });

  it("converts gateway and Claude inspection failures into safe status states", async () => {
    const report = await runOperatorStatus(
      {
        configPath: "./vartma.yaml",
        claudeLocation: { settingsPath: "C:/test/.claude/settings.json" },
        openAIEnvPath: "C:/test/.env",
        timeoutMs: 1_000,
        offline: false,
      },
      {
        loadConfigImplementation: vi.fn<typeof loadConfig>(() => Promise.resolve(statusConfig())),
        fetchImplementation: () =>
          Promise.reject(new Error("Bearer router-gateway-secret connection failed")),
        claudeStatusImplementation: vi.fn<typeof claudeCodeStatus>(() =>
          Promise.reject(new Error("ANTHROPIC_AUTH_TOKEN=provider-secret-value")),
        ),
        openAIStatusImplementation: () =>
          Promise.resolve({
            configured: false,
            state: "not_configured",
            envPath: "C:/test/.env",
            statePath: "C:/test/.env.vartma-openai-state.json",
          }),
      },
    );

    expect(report).toMatchObject({
      ok: false,
      gateway: { state: "unreachable" },
      claudeCode: { configured: true, state: "drifted" },
    });
    expect(JSON.stringify(report)).not.toContain("router-gateway-secret");
    expect(JSON.stringify(report)).not.toContain("provider-secret-value");
    expect(formatOperatorStatus(report)).toContain("Status result: FAIL");
  });
});

function statusConfig() {
  const fakeModel = model("fake", "fake/default", "fake-default");
  return routerConfigSchema.parse({
    environment: "test",
    server: {
      host: "0.0.0.0",
      port: 8080,
      trustProxy: false,
      requestBodyLimitBytes: 1_048_576,
    },
    auth: { enabled: true, apiKeys: ["router-gateway-secret"] },
    database: {
      url: "postgresql://vartma:database-password@localhost:5432/vartma",
      requiredForReadiness: true,
    },
    routing: {
      defaultMode: "balanced",
      defaultModel: "fake/default",
      routerVersion: "status-test",
    },
    providers: [
      {
        id: "fake",
        type: "fake",
        enabled: true,
        models: [fakeModel],
      },
      {
        id: "openai",
        type: "openai",
        enabled: false,
        apiKeyEnv: "STATUS_OPENAI_KEY",
        models: [model("openai", "openai/default", "gpt-status-test")],
      },
    ],
    telemetry: {
      serviceName: "status-test",
      logLevel: "error",
      langSmith: {
        enabled: false,
        apiKeyEnv: "LANGSMITH_API_KEY",
        project: "test",
        exportContent: false,
      },
    },
  });
}

function model(provider: string, id: string, upstreamModel: string) {
  return {
    id,
    provider,
    upstreamModel,
    enabled: true,
    capabilities: {
      text: true,
      vision: false,
      streaming: true,
      tools: true,
      structuredOutput: true,
      reasoning: false,
    },
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    qualityTier: 1,
    expectedLatencyTier: 1,
    pricing: {
      currency: "USD" as const,
      effectiveFrom: "2026-07-28",
      verifiedAt: "2026-07-28",
      source: "status test",
      inputPerMillion: 0,
      cachedInputPerMillion: 0,
      outputPerMillion: 0,
    },
  };
}
