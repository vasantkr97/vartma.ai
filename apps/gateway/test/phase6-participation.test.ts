import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { routerConfigSchema } from "@vartma/config";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/index.js";

describe("Phase 6 provider participation", () => {
  it.each([
    ["kimi", "/v1/chat/completions", "max_completion_tokens", true],
    ["deepseek", "/chat/completions", "max_tokens", false],
    ["zai", "/chat/completions", "max_tokens", false],
    ["xai", "/v1/chat/completions", "max_tokens", false],
  ] as const)(
    "routes through the %s compatibility profile",
    async (profile, expectedPath, tokenField, sendsStreamUsage) => {
      await withMockServer(
        async (incoming, response) => {
          expect(incoming.url).toBe(expectedPath);
          expect(incoming.headers["authorization"]).toBe("Bearer profile-test-key");
          const body = JSON.parse(await readBody(incoming)) as Record<string, unknown>;
          expect(body[tokenField]).toBe(256);
          expect(Object.hasOwn(body, "stream_options")).toBe(sendsStreamUsage);
          writeSse(response, [
            {
              id: `chatcmpl_${profile}`,
              model: `${profile}-test`,
              choices: [
                {
                  index: 0,
                  delta: { content: `${profile} route works` },
                  finish_reason: "stop",
                },
              ],
            },
          ]);
        },
        async (baseUrl) => {
          const previousKey = process.env["PROFILE_TEST_KEY"];
          process.env["PROFILE_TEST_KEY"] = "profile-test-key";
          try {
            const app = createApp({
              config: providerConfig({
                id: profile,
                type: "openai-compatible",
                profile,
                baseUrl,
                apiKeyEnv: "PROFILE_TEST_KEY",
                upstreamModel: `${profile}-test`,
                tools: true,
              }),
              logger: pino({ level: "silent" }),
            });
            const result = await request(app)
              .post("/v1/messages")
              .send({
                model: `${profile}/default`,
                max_tokens: 256,
                messages: [{ role: "user", content: `use ${profile}` }],
              });
            expect(result.status).toBe(200);
            expect(result.headers["x-vartma-provider"]).toBe(profile);
            expect(result.body.content[0].text).toBe(`${profile} route works`);
          } finally {
            restoreEnv("PROFILE_TEST_KEY", previousKey);
          }
        },
      );
    },
  );

  it("routes through a local OpenAI-compatible model and rejects unsupported tools preflight", async () => {
    let upstreamRequests = 0;
    await withMockServer(
      async (incoming, response) => {
        upstreamRequests += 1;
        expect(incoming.url).toBe("/v1/chat/completions");
        await readBody(incoming);
        writeSse(response, [
          {
            id: "chatcmpl_local",
            model: "local-test",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          },
          {
            id: "chatcmpl_local",
            model: "local-test",
            choices: [{ index: 0, delta: { content: "local route works" }, finish_reason: null }],
          },
          {
            id: "chatcmpl_local",
            model: "local-test",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
          {
            id: "chatcmpl_local",
            model: "local-test",
            choices: [],
            usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
          },
        ]);
      },
      async (baseUrl) => {
        const previousKey = process.env["PHASE6_LOCAL_KEY"];
        process.env["PHASE6_LOCAL_KEY"] = "local-test-key";
        try {
          const app = createApp({
            config: providerConfig({
              id: "local",
              type: "openai-compatible",
              baseUrl,
              apiKeyEnv: "PHASE6_LOCAL_KEY",
              upstreamModel: "local-test",
              tools: false,
            }),
            logger: pino({ level: "silent" }),
          });

          const completion = await request(app)
            .post("/v1/chat/completions")
            .send({
              model: "vartma-balanced",
              messages: [{ role: "user", content: "use the local model" }],
            });
          expect(completion.status).toBe(200);
          expect(completion.headers["x-vartma-provider"]).toBe("local");
          expect(completion.body.choices[0].message.content).toBe("local route works");
          expect(upstreamRequests).toBe(1);

          const unsupported = await request(app)
            .post("/v1/chat/completions")
            .send({
              model: "vartma-balanced",
              messages: [{ role: "user", content: "call a tool" }],
              tools: [
                {
                  type: "function",
                  function: {
                    name: "lookup",
                    parameters: { type: "object", properties: {} },
                  },
                },
              ],
            });
          expect(unsupported.status).toBeGreaterThanOrEqual(400);
          expect(unsupported.status).toBeLessThan(500);
          expect(JSON.stringify(unsupported.body)).toContain("eligible");
          expect(upstreamRequests).toBe(1);
        } finally {
          restoreEnv("PHASE6_LOCAL_KEY", previousKey);
        }
      },
    );
  });

  it("routes Responses text through the native Gemini adapter", async () => {
    let upstreamRequests = 0;
    await withMockServer(
      async (incoming, response) => {
        upstreamRequests += 1;
        expect(incoming.url).toBe("/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
        expect(incoming.headers["x-goog-api-key"]).toBe("gemini-test-key");
        const body = JSON.parse(await readBody(incoming)) as Record<string, unknown>;
        expect(body["contents"]).toBeTruthy();
        writeSse(response, [
          {
            responseId: "gemini_response_gateway",
            modelVersion: "gemini-test",
            candidates: [
              {
                content: { role: "model", parts: [{ text: "gemini route works" }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 9,
              cachedContentTokenCount: 2,
              candidatesTokenCount: 4,
            },
          },
        ]);
      },
      async (baseUrl) => {
        const previousKey = process.env["PHASE6_GEMINI_KEY"];
        process.env["PHASE6_GEMINI_KEY"] = "gemini-test-key";
        try {
          const app = createApp({
            config: providerConfig({
              id: "gemini",
              type: "gemini",
              baseUrl,
              apiKeyEnv: "PHASE6_GEMINI_KEY",
              upstreamModel: "gemini-test",
              tools: true,
            }),
            logger: pino({ level: "silent" }),
          });

          const result = await request(app).post("/v1/responses").send({
            model: "vartma-balanced",
            input: "use Gemini",
          });
          expect(result.status).toBe(200);
          expect(result.headers["x-vartma-provider"]).toBe("gemini");
          expect(result.body.output_text).toBe("gemini route works");
          expect(result.body.usage).toMatchObject({
            input_tokens: 9,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens: 4,
            total_tokens: 13,
          });
          expect(upstreamRequests).toBe(1);
        } finally {
          restoreEnv("PHASE6_GEMINI_KEY", previousKey);
        }
      },
    );
  });
});

interface ProviderFixture {
  id: string;
  type: "gemini" | "openai-compatible";
  baseUrl: string;
  profile?: "kimi" | "deepseek" | "zai" | "xai";
  apiKeyEnv: string;
  upstreamModel: string;
  tools: boolean;
}

function providerConfig(provider: ProviderFixture) {
  return routerConfigSchema.parse({
    environment: "test",
    server: {
      host: "127.0.0.1",
      port: 8080,
      trustProxy: false,
      requestBodyLimitBytes: 1_048_576,
    },
    auth: { enabled: false, apiKeys: [] },
    database: {
      url: "postgresql://vartma:vartma@localhost:5432/vartma",
      requiredForReadiness: false,
    },
    routing: {
      defaultMode: "balanced",
      defaultModel: `${provider.id}/default`,
      routerVersion: "phase6-participation-test",
    },
    providers: [
      {
        id: provider.id,
        type: provider.type,
        enabled: true,
        baseUrl: provider.baseUrl,
        ...(provider.profile ? { profile: provider.profile } : {}),
        apiKeyEnv: provider.apiKeyEnv,
        requestTimeoutMs: 5_000,
        maxRetries: 0,
        models: [
          {
            id: `${provider.id}/default`,
            provider: provider.id,
            upstreamModel: provider.upstreamModel,
            enabled: true,
            capabilities: {
              text: true,
              vision: false,
              streaming: true,
              tools: provider.tools,
              structuredOutput: false,
              reasoning: false,
            },
            contextWindow: 32_000,
            maxOutputTokens: 4_096,
            qualityTier: 3,
            expectedLatencyTier: 2,
            pricing: {
              currency: "USD",
              effectiveFrom: "2026-07-28",
              verifiedAt: "2026-07-28",
              source: "test fixture",
              inputPerMillion: 0,
              cachedInputPerMillion: 0,
              outputPerMillion: 0,
            },
          },
        ],
      },
    ],
    telemetry: {
      serviceName: "phase6-participation-test",
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

async function withMockServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  task: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock provider did not expose a TCP port.");
    }
    await task(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeSse(response: ServerResponse, values: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "close",
  });
  for (const value of values) {
    response.write(`data: ${JSON.stringify(value)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
