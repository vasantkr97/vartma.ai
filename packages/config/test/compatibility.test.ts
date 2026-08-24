import { describe, expect, it } from "vitest";

import {
  providerConfigSchema,
  providerRequiresCredential,
  resolveOpenAICompatibleEndpoint,
} from "../src/index.js";

describe("OpenAI-compatible provider profiles", () => {
  it.each([
    ["kimi", "https://api.moonshot.ai", "/v1/chat/completions"],
    ["deepseek", "https://api.deepseek.com", "/chat/completions"],
    ["zai", "https://api.z.ai/api/paas/v4", "/chat/completions"],
    ["xai", "https://api.x.ai", "/v1/chat/completions"],
    ["ollama", "http://127.0.0.1:11434", "/v1/chat/completions"],
  ] as const)("resolves the %s endpoint profile", (profile, baseUrl, chatCompletionsPath) => {
    expect(resolveOpenAICompatibleEndpoint({ id: profile, profile })).toMatchObject({
      profile,
      baseUrl,
      chatCompletionsPath,
    });
  });

  it("allows safe operator overrides without losing profile dialect defaults", () => {
    expect(
      resolveOpenAICompatibleEndpoint({
        id: "zai-proxy",
        profile: "zai",
        baseUrl: "https://proxy.example/v4/",
        chatCompletionsPath: "/custom/chat",
      }),
    ).toMatchObject({
      profile: "zai",
      baseUrl: "https://proxy.example/v4",
      chatCompletionsPath: "/custom/chat",
      maxOutputTokensField: "max_tokens",
      sendStreamUsage: false,
    });
  });

  it("accepts a named profile without a base URL and rejects unsafe paths", () => {
    const provider = providerConfigSchema.parse({
      id: "kimi",
      type: "openai-compatible",
      profile: "kimi",
      enabled: false,
      apiKeyEnv: "KIMI_API_KEY",
      models: [model("kimi", "kimi-k3")],
    });
    expect(provider.baseUrl).toBeUndefined();

    expect(() =>
      providerConfigSchema.parse({
        ...provider,
        chatCompletionsPath: "//attacker.example/chat",
      }),
    ).toThrow("Provider API paths");
  });

  it("defaults Ollama to unauthenticated access and permits explicit local-server auth modes", () => {
    const ollama = providerConfigSchema.parse({
      id: "ollama",
      type: "openai-compatible",
      profile: "ollama",
      enabled: true,
      models: [model("ollama", "qwen2.5:7b")],
    });
    expect(resolveOpenAICompatibleEndpoint(ollama).authentication).toBe("none");
    expect(providerRequiresCredential(ollama)).toBe(false);

    const local = providerConfigSchema.parse({
      id: "local",
      type: "openai-compatible",
      authentication: "none",
      baseUrl: "http://127.0.0.1:8000",
      enabled: true,
      models: [model("local", "served-model")],
    });
    expect(providerRequiresCredential(local)).toBe(false);

    expect(() =>
      providerConfigSchema.parse({
        ...local,
        authentication: "bearer",
      }),
    ).toThrow("requires apiKeyEnv or credentialRef");
  });
});

function model(provider: string, upstreamModel: string) {
  return {
    id: `${provider}/default`,
    provider,
    upstreamModel,
    enabled: true,
    capabilities: {
      text: true,
      vision: false,
      streaming: true,
      tools: true,
      structuredOutput: true,
      reasoning: true,
    },
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    qualityTier: 3,
    expectedLatencyTier: 2,
    pricing: {
      currency: "USD" as const,
      effectiveFrom: "2026-08-24",
      verifiedAt: "2026-08-24",
      source: "provider profile test fixture",
      inputPerMillion: 0,
      cachedInputPerMillion: 0,
      outputPerMillion: 0,
    },
  };
}
