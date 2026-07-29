import type { AddressInfo } from "node:net";

import { routerConfigSchema } from "@vartma/config";
import OpenAI from "openai";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/index.js";

const config = routerConfigSchema.parse({
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
    defaultModel: "fake/default",
    routerVersion: "openai-ingress-test",
  },
  providers: [
    {
      id: "fake",
      type: "fake",
      enabled: true,
      models: [
        {
          id: "fake/default",
          provider: "fake",
          upstreamModel: "fake-default",
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
          maxOutputTokens: 64_000,
          qualityTier: 5,
          expectedLatencyTier: 1,
          pricing: {
            currency: "USD",
            effectiveFrom: "2026-07-28",
            verifiedAt: "2026-07-28",
            source: "test",
            inputPerMillion: 0,
            cachedInputPerMillion: 0,
            outputPerMillion: 0,
          },
        },
      ],
    },
  ],
  telemetry: {
    serviceName: "openai-ingress-test",
    logLevel: "error",
    langSmith: {
      enabled: false,
      apiKeyEnv: "LANGSMITH_API_KEY",
      project: "test",
      exportContent: false,
    },
  },
});

function gateway() {
  return createApp({ config, logger: pino({ level: "silent" }) });
}

describe("OpenAI-compatible ingress", () => {
  it("works through the official OpenAI Node SDK for Responses and Chat Completions", async () => {
    const server = gateway().listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    try {
      const address = server.address() as AddressInfo;
      const client = new OpenAI({
        apiKey: "test-api-key",
        baseURL: `http://127.0.0.1:${String(address.port)}/v1`,
        maxRetries: 0,
      });

      const response = await client.responses.create({
        model: "vartma-balanced",
        input: "hello through the SDK",
      });
      expect(response.status).toBe("completed");
      expect(response.output_text).toContain("hello through the SDK");

      const stream = await client.responses.create({
        model: "vartma-balanced",
        input: "stream through the SDK",
        stream: true,
      });
      const eventTypes: string[] = [];
      let streamedText = "";
      for await (const event of stream) {
        eventTypes.push(event.type);
        if (event.type === "response.output_text.delta") {
          streamedText += event.delta;
        }
      }
      expect(eventTypes.slice(0, 2)).toEqual(["response.created", "response.in_progress"]);
      expect(eventTypes.at(-1)).toBe("response.completed");
      expect(streamedText).toContain("stream through the SDK");

      const completion = await client.chat.completions.create({
        model: "vartma-eco",
        messages: [{ role: "user", content: "chat through the SDK" }],
      });
      expect(completion.choices[0]?.message.content).toContain("chat through the SDK");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });

  it("returns a non-streaming Responses object through the shared router", async () => {
    const response = await request(gateway())
      .post("/v1/responses")
      .set("authorization", "Bearer test-api-key")
      .set("x-vartma-session-id", "responses-session")
      .send({
        model: "vartma-balanced",
        input: "hello from responses",
        max_output_tokens: 256,
      });

    expect(response.status).toBe(200);
    expect(response.headers["x-vartma-provider"]).toBe("fake");
    expect(response.headers["x-vartma-mode"]).toBe("balanced");
    expect(response.body).toMatchObject({
      object: "response",
      status: "completed",
      model: "fake-default",
    });
    expect(response.body.output_text).toContain("hello from responses");
    expect(response.body.usage.total_tokens).toBeGreaterThan(0);
  });

  it("streams Responses function-call events with stable call IDs", async () => {
    const response = await request(gateway())
      .post("/v1/responses")
      .set("x-api-key", "test-api-key")
      .send({
        model: "vartma-quality",
        input: "use a tool",
        max_output_tokens: 256,
        stream: true,
        tools: [
          {
            type: "function",
            name: "echo",
            parameters: {
              type: "object",
              properties: { message: { type: "string" } },
            },
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.text).toContain("response.function_call_arguments.delta");
    expect(response.text).toContain("response.output_item.done");
    expect(response.text).toContain("response.completed");
    expect(response.text).toContain('"call_id":"tool_');
  });

  it("returns a non-streaming Chat Completions response", async () => {
    const response = await request(gateway())
      .post("/v1/chat/completions")
      .set("authorization", "Bearer test-api-key")
      .send({
        model: "vartma-eco",
        messages: [{ role: "user", content: "hello from chat" }],
        max_completion_tokens: 128,
      });

    expect(response.status).toBe(200);
    expect(response.headers["x-vartma-mode"]).toBe("eco");
    expect(response.body.object).toBe("chat.completion");
    expect(response.body.choices[0]).toMatchObject({
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant" },
    });
    expect(response.body.choices[0].message.content).toContain("hello from chat");
  });

  it("streams Chat Completions chunks, final usage, and DONE", async () => {
    const response = await request(gateway())
      .post("/v1/chat/completions")
      .set("x-api-key", "test-api-key")
      .send({
        model: "vartma-balanced",
        messages: [{ role: "user", content: "stream this" }],
        stream: true,
        stream_options: { include_usage: true },
      });

    expect(response.status).toBe(200);
    expect(response.text).toContain('"object":"chat.completion.chunk"');
    expect(response.text).toContain('"choices":[]');
    expect(response.text).toContain('"completion_tokens"');
    expect(response.text).toContain("data: [DONE]");
  });

  it("normalizes explicit tool history and rejects non-portable server state", async () => {
    const toolHistory = await request(gateway())
      .post("/v1/responses")
      .set("x-api-key", "test-api-key")
      .send({
        model: "vartma-balanced",
        input: [
          { role: "user", content: "call a tool" },
          {
            type: "function_call",
            call_id: "call_1",
            name: "lookup",
            arguments: '{"query":"router"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "found",
          },
          { role: "user", content: "summarize" },
        ],
      });
    expect(toolHistory.status).toBe(200);

    const stateful = await request(gateway())
      .post("/v1/responses")
      .set("x-api-key", "test-api-key")
      .send({
        model: "vartma-balanced",
        input: "continue",
        previous_response_id: "resp_external",
      });
    expect(stateful.status).toBe(400);
    expect(stateful.body.error.message).toContain("explicit input history");
  });

  it("uses OpenAI error envelopes without exposing secrets", async () => {
    const response = await request(gateway())
      .post("/v1/chat/completions")
      .set("x-api-key", "test-api-key")
      .send({ model: "vartma-balanced", messages: [] });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        message: expect.stringContaining("Invalid request"),
        type: "invalid_request_error",
        param: null,
        code: null,
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("test-api-key");

    const unauthenticated = await request(gateway())
      .post("/v1/responses")
      .send({ model: "vartma-balanced", input: "hello" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toEqual({
      error: {
        message: "A valid router API key is required.",
        type: "authentication_error",
        param: null,
        code: "invalid_api_key",
      },
    });
  });
});
