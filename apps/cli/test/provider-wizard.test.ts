import { describe, expect, it } from "vitest";

import { buildProviderInteractively } from "../src/provider-wizard.js";

describe("interactive provider wizard", () => {
  it("builds a fully validated compatible provider without collecting a secret", async () => {
    const answers = [
      "bad id",
      "local",
      "local2",
      "openai-compatible",
      "yes",
      "https://user:secret@example.test?bad=1",
      "http://127.0.0.1:8000/",
      "",
      "",
      "",
      "served-model",
      "",
      "local2/custom",
      "",
      "no",
      "",
      "yes",
      "yes",
      "no",
      "131072",
      "16384",
      "2",
      "2",
      "",
      "local, private,local",
      "",
      "",
      "operator-supplied local inference cost",
      "0",
      "0",
      "0",
      "",
      "",
    ];
    const prompts: string[] = [];
    const messages: string[] = [];

    const provider = await buildProviderInteractively({
      ask: (prompt) => {
        prompts.push(prompt);
        const answer = answers.shift();
        if (answer === undefined) {
          throw new Error(`No test answer remains for prompt: ${prompt}`);
        }
        return Promise.resolve(answer);
      },
      write: (message) => messages.push(message),
      now: () => new Date("2026-07-28T00:00:00.000Z"),
      existingProviderIds: ["local"],
      existingModelIds: ["local2/served-model"],
    });

    expect(answers).toEqual([]);
    expect(provider).toMatchObject({
      id: "local2",
      type: "openai-compatible",
      enabled: true,
      baseUrl: "http://127.0.0.1:8000",
      apiKeyEnv: "COMPATIBLE_API_KEY",
      requestTimeoutMs: 120_000,
      maxRetries: 2,
      models: [
        {
          id: "local2/custom",
          provider: "local2",
          upstreamModel: "served-model",
          capabilities: {
            text: true,
            vision: false,
            streaming: true,
            tools: true,
            structuredOutput: true,
            reasoning: false,
          },
          contextWindow: 131_072,
          maxOutputTokens: 16_384,
          qualityTier: 2,
          expectedLatencyTier: 2,
          regions: ["local", "private"],
          pricing: {
            effectiveFrom: "2026-07-28",
            verifiedAt: "2026-07-28",
            source: "operator-supplied local inference cost",
          },
        },
      ],
    });
    expect(messages.join("")).toContain("Provider secrets are not collected");
    expect(messages.join("")).toContain("Use letters, numbers");
    expect(messages.join("")).toContain('"local" already exists');
    expect(messages.join("")).toContain('"local2/served-model" already exists');
    expect(messages.join("")).toContain("without credentials");
    expect(prompts.join(" ")).not.toContain("secret value");
    expect(JSON.stringify(provider)).not.toContain("user:secret");
  });
});
