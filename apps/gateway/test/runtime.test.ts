import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { routerConfigSchema, setEncryptedCredential } from "@vartma/config";
import { describe, expect, it } from "vitest";

import { createRuntime } from "../src/runtime.js";

describe("runtime provider wiring", () => {
  it("registers native and compatible provider families from environment keys", () => {
    const previousAnthropic = process.env["TEST_ANTHROPIC_KEY"];
    const previousOpenAI = process.env["TEST_OPENAI_KEY"];
    const previousGemini = process.env["TEST_GEMINI_KEY"];
    const previousLocal = process.env["TEST_LOCAL_KEY"];
    process.env["TEST_ANTHROPIC_KEY"] = "anthropic-test-key";
    process.env["TEST_OPENAI_KEY"] = "openai-test-key";
    process.env["TEST_GEMINI_KEY"] = "gemini-test-key";
    process.env["TEST_LOCAL_KEY"] = "local-test-key";

    try {
      const runtime = createRuntime(
        routerConfigSchema.parse({
          environment: "test",
          server: {
            host: "127.0.0.1",
            port: 8080,
            trustProxy: false,
            requestBodyLimitBytes: 1_000_000,
          },
          auth: { enabled: false, apiKeys: [] },
          database: {
            url: "postgresql://vartma:vartma@localhost:5432/vartma",
            requiredForReadiness: false,
          },
          routing: {
            defaultMode: "balanced",
            defaultModel: "anthropic/default",
            routerVersion: "test-v1",
          },
          providers: [
            configuredProvider("anthropic", "anthropic", "claude-test", "TEST_ANTHROPIC_KEY"),
            configuredProvider("openai", "openai", "gpt-test", "TEST_OPENAI_KEY"),
            configuredProvider("gemini", "gemini", "gemini-test", "TEST_GEMINI_KEY"),
            configuredProvider(
              "local",
              "openai-compatible",
              "local-test",
              "TEST_LOCAL_KEY",
              "http://127.0.0.1:8000",
            ),
          ],
          telemetry: {
            serviceName: "router-test",
            logLevel: "error",
            langSmith: {
              enabled: false,
              apiKeyEnv: "LANGSMITH_API_KEY",
              project: "router-test",
              exportContent: false,
            },
          },
        }),
      );

      expect(runtime.registry.list().map((adapter) => adapter.name)).toEqual([
        "anthropic",
        "openai",
        "gemini",
        "local",
      ]);
      expect([...runtime.models.keys()]).toEqual([
        "anthropic/default",
        "openai/default",
        "gemini/default",
        "local/default",
      ]);
    } finally {
      restoreEnv("TEST_ANTHROPIC_KEY", previousAnthropic);
      restoreEnv("TEST_OPENAI_KEY", previousOpenAI);
      restoreEnv("TEST_GEMINI_KEY", previousGemini);
      restoreEnv("TEST_LOCAL_KEY", previousLocal);
    }
  });

  it("fails fast when an enabled live provider key is absent", () => {
    const previous = process.env["TEST_MISSING_PROVIDER_KEY"];
    delete process.env["TEST_MISSING_PROVIDER_KEY"];
    try {
      const config = routerConfigSchema.parse({
        environment: "test",
        server: {
          host: "127.0.0.1",
          port: 8080,
          trustProxy: false,
          requestBodyLimitBytes: 1_000_000,
        },
        auth: { enabled: false, apiKeys: [] },
        database: {
          url: "postgresql://vartma:vartma@localhost:5432/vartma",
          requiredForReadiness: false,
        },
        routing: {
          defaultMode: "balanced",
          defaultModel: "openai/default",
          routerVersion: "test-v1",
        },
        providers: [
          configuredProvider("openai", "openai", "gpt-test", "TEST_MISSING_PROVIDER_KEY"),
        ],
        telemetry: {
          serviceName: "router-test",
          logLevel: "error",
          langSmith: {
            enabled: false,
            apiKeyEnv: "LANGSMITH_API_KEY",
            project: "router-test",
            exportContent: false,
          },
        },
      });

      expect(() => createRuntime(config)).toThrow(
        'Provider "openai" requires environment variable "TEST_MISSING_PROVIDER_KEY".',
      );
    } finally {
      restoreEnv("TEST_MISSING_PROVIDER_KEY", previous);
    }
  });

  it("registers Ollama without an artificial API key", () => {
    const config = routerConfigSchema.parse({
      environment: "test",
      server: {
        host: "127.0.0.1",
        port: 8080,
        trustProxy: false,
        requestBodyLimitBytes: 1_000_000,
      },
      auth: { enabled: false, apiKeys: [] },
      database: {
        url: "postgresql://vartma:vartma@localhost:5432/vartma",
        requiredForReadiness: false,
      },
      routing: {
        defaultMode: "fixed",
        defaultModel: "ollama/default",
        routerVersion: "test-v1",
      },
      providers: [
        {
          ...configuredProvider("ollama", "openai-compatible", "qwen2.5:7b", "unused"),
          apiKeyEnv: undefined,
          profile: "ollama",
        },
      ],
      telemetry: {
        serviceName: "router-test",
        logLevel: "error",
        langSmith: {
          enabled: false,
          apiKeyEnv: "LANGSMITH_API_KEY",
          project: "router-test",
          exportContent: false,
        },
      },
    });

    expect(createRuntime(config, { environment: {} }).registry.get("ollama").name).toBe("ollama");
  });

  it("loads an enabled provider key from the authenticated encrypted store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-runtime-credential-"));
    const credentialStorePath = join(directory, "credentials.enc");
    const masterKey = "runtime-test-master-passphrase";
    await setEncryptedCredential({
      path: credentialStorePath,
      masterKey,
      reference: "openai/byok",
      value: "encrypted-openai-test-secret",
    });
    const config = routerConfigSchema.parse({
      environment: "test",
      server: {
        host: "127.0.0.1",
        port: 8080,
        trustProxy: false,
        requestBodyLimitBytes: 1_000_000,
      },
      auth: { enabled: false, apiKeys: [] },
      credentials: {
        storePath: credentialStorePath,
        masterKeyEnv: "TEST_VARTMA_MASTER_KEY",
      },
      database: {
        url: "postgresql://vartma:vartma@localhost:5432/vartma",
        requiredForReadiness: false,
      },
      routing: {
        defaultMode: "balanced",
        defaultModel: "openai/default",
        routerVersion: "test-v1",
      },
      providers: [
        {
          ...configuredProvider("openai", "openai", "gpt-test", "unused"),
          apiKeyEnv: undefined,
          credentialRef: "openai/byok",
        },
      ],
      telemetry: {
        serviceName: "router-test",
        logLevel: "error",
        langSmith: {
          enabled: false,
          apiKeyEnv: "LANGSMITH_API_KEY",
          project: "router-test",
          exportContent: false,
        },
      },
    });

    const runtime = createRuntime(config, {
      credentialStorePath,
      environment: { TEST_VARTMA_MASTER_KEY: masterKey },
    });
    expect(runtime.registry.get("openai").name).toBe("openai");
    expect(() =>
      createRuntime(config, {
        credentialStorePath,
        environment: { TEST_VARTMA_MASTER_KEY: "wrong-master-passphrase-value" },
      }),
    ).toThrow("could not be authenticated");
  });
});

function configuredProvider(
  id: string,
  type: "anthropic" | "openai" | "gemini" | "openai-compatible",
  upstreamModel: string,
  apiKeyEnv: string,
  baseUrl?: string,
) {
  return {
    id,
    type,
    enabled: true,
    apiKeyEnv,
    ...(baseUrl ? { baseUrl } : {}),
    models: [
      {
        id: `${id}/default`,
        provider: id,
        upstreamModel,
        enabled: true,
        capabilities: {
          text: true,
          vision: true,
          streaming: true,
          tools: true,
          structuredOutput: true,
          reasoning: true,
        },
        contextWindow: 100_000,
        maxOutputTokens: 4096,
        qualityTier: 3,
        expectedLatencyTier: 3,
        pricing: {
          currency: "USD" as const,
          effectiveFrom: "2026-07-23",
          verifiedAt: "2026-07-23",
          source: "runtime test fixture",
          inputPerMillion: 0,
          cachedInputPerMillion: 0,
          outputPerMillion: 0,
        },
      },
    ],
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
