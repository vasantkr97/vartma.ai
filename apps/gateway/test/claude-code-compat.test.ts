import type { ModelDefinition } from "@vartma/canonical";
import { routerConfigSchema } from "@vartma/config";
import { AnthropicProvider, OpenAIProvider, ProviderRegistry } from "@vartma/providers";
import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/index.js";
import type { Runtime } from "../src/runtime.js";

describe("Claude Code multi-provider compatibility", () => {
  it("serves different turns through native Anthropic and OpenAI adapters", async () => {
    const anthropicFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        sseResponse([
          {
            type: "message_start",
            message: {
              id: "msg_anthropic",
              model: "claude-upstream",
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "anthropic turn" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 2 },
          },
          { type: "message_stop" },
        ]),
      ),
    );
    const openaiFetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        sseResponse([
          {
            type: "response.created",
            response: { id: "resp_openai", model: "gpt-upstream", usage: null },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              id: "message_openai",
              type: "message",
              role: "assistant",
              content: [],
            },
          },
          {
            type: "response.content_part.added",
            item_id: "message_openai",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "" },
          },
          {
            type: "response.output_text.delta",
            item_id: "message_openai",
            output_index: 0,
            content_index: 0,
            delta: "openai turn",
          },
          {
            type: "response.output_text.done",
            item_id: "message_openai",
            output_index: 0,
            content_index: 0,
            text: "openai turn",
          },
          {
            type: "response.completed",
            response: {
              id: "resp_openai",
              model: "gpt-upstream",
              status: "completed",
              usage: {
                input_tokens: 10,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 2,
                output_tokens_details: { reasoning_tokens: 0 },
              },
            },
          },
        ]),
      ),
    );
    const runtime = compatibilityRuntime(anthropicFetch, openaiFetch);
    const gateway = createApp({
      config: compatibilityConfig(),
      runtime,
      logger: pino({ level: "silent" }),
    });

    const qualityTurn = await request(gateway)
      .post("/v1/messages?beta=true")
      .set("x-api-key", "test-api-key")
      .set("anthropic-version", "2023-06-01")
      .set("anthropic-beta", "future-capability")
      .set("x-claude-code-session-id", "multi-provider-session")
      .set("x-vartma-mode", "quality")
      .send(claudeRequest("Design the architecture"));
    expect(qualityTurn.status).toBe(200);
    expect(qualityTurn.headers["x-vartma-provider"]).toBe("anthropic");
    expect(qualityTurn.body.content[0].text).toBe("anthropic turn");

    const ecoTurn = await request(gateway)
      .post("/v1/messages?beta=true")
      .set("x-api-key", "test-api-key")
      .set("anthropic-version", "2023-06-01")
      .set("x-claude-code-session-id", "multi-provider-session")
      .set("x-vartma-mode", "eco")
      .send(claudeRequest("Explain this variable"));
    expect(ecoTurn.status).toBe(200);
    expect(ecoTurn.headers["x-vartma-provider"]).toBe("openai");
    expect(ecoTurn.body.content[0].text).toBe("openai turn");

    expect(anthropicFetch).toHaveBeenCalledTimes(1);
    expect(openaiFetch).toHaveBeenCalledTimes(1);
    const serializedOpenaiBody = openaiFetch.mock.calls[0]?.[1]?.body;
    expect(typeof serializedOpenaiBody).toBe("string");
    const openaiBody = JSON.parse(serializedOpenaiBody as string) as Record<string, unknown>;
    expect(JSON.stringify(openaiBody.input)).toContain("Design the architecture");
    expect(JSON.stringify(openaiBody.input)).toContain("anthropic turn");
    expect(JSON.stringify(openaiBody.input)).toContain("Explain this variable");
    expect(openaiBody.metadata).toMatchObject({
      canonical_history_owned: "true",
      canonical_history_messages: "3",
      canonical_history_incoming_messages: "1",
    });
  });
});

function compatibilityRuntime(anthropicFetch: typeof fetch, openaiFetch: typeof fetch): Runtime {
  const anthropic = model("anthropic/frontier", "anthropic", "claude-upstream", 5, 50, 4);
  const openai = model("openai/economy", "openai", "gpt-upstream", 1, 0.1, 1);
  const registry = new ProviderRegistry();
  registry.register(
    new AnthropicProvider({
      name: "anthropic",
      apiKey: "anthropic-test-key",
      models: [anthropic],
      maxRetries: 0,
      fetchImplementation: anthropicFetch,
    }),
  );
  registry.register(
    new OpenAIProvider({
      name: "openai",
      apiKey: "openai-test-key",
      models: [openai],
      maxRetries: 0,
      fetchImplementation: openaiFetch,
    }),
  );
  return {
    registry,
    models: new Map([
      [anthropic.id, anthropic],
      [openai.id, openai],
    ]),
  };
}

function compatibilityConfig() {
  const configured = model("openai/economy", "openai", "gpt-upstream", 1, 0.1, 1);
  return routerConfigSchema.parse({
    environment: "test",
    server: {
      host: "127.0.0.1",
      port: 8080,
      trustProxy: false,
      requestBodyLimitBytes: 1_048_576,
    },
    auth: { enabled: true, apiKeys: ["test-api-key"] },
    database: {
      url: "postgresql://vartma:vartma@localhost:5432/vartma",
      requiredForReadiness: false,
    },
    routing: {
      defaultMode: "balanced",
      defaultModel: configured.id,
      routerVersion: "claude-code-test",
    },
    providers: [
      {
        id: "openai",
        type: "openai",
        enabled: true,
        apiKeyEnv: "UNUSED_IN_INJECTED_RUNTIME",
        models: [configured],
      },
    ],
    telemetry: {
      serviceName: "claude-code-compat-test",
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

function model(
  id: string,
  provider: string,
  upstreamModel: string,
  qualityTier: number,
  inputPerMillion: number,
  expectedLatencyTier: number,
): ModelDefinition {
  return {
    id,
    provider,
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
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    qualityTier,
    expectedLatencyTier,
    pricing: {
      currency: "USD",
      effectiveFrom: "2026-07-28",
      verifiedAt: "2026-07-28",
      source: "Claude Code compatibility fixture",
      inputPerMillion,
      cachedInputPerMillion: inputPerMillion / 10,
      outputPerMillion: inputPerMillion * 4,
    },
  };
}

function claudeRequest(text: string) {
  return {
    model: "claude-vartma-balanced",
    max_tokens: 512,
    messages: [{ role: "user", content: text }],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  };
}

function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => {
      const type =
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        typeof event.type === "string"
          ? event.type
          : "message";
      return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
