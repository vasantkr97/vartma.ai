import { describe, expect, it, vi } from "vitest";

import { AnthropicProvider, toAnthropicRequest } from "../src/index.js";
import type { ProviderError } from "../src/index.js";
import { canonicalRequest, collect, joinedText, model, sseResponse } from "./helpers.js";

const textEvents = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      model: "claude-test",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
        output_tokens: 1,
      },
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
    delta: { type: "text_delta", text: "Hello" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 4 },
  },
  { type: "message_stop" },
];

function provider(fetchImplementation: typeof fetch, maxRetries = 0): AnthropicProvider {
  return new AnthropicProvider({
    name: "anthropic",
    apiKey: "anthropic-secret",
    models: [model("anthropic", "claude-test")],
    maxRetries,
    fetchImplementation,
    sleepImplementation: () => Promise.resolve(),
  });
}

describe("AnthropicProvider", () => {
  it("translates text, finish reason, cache usage, and request IDs", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        sseResponse(textEvents, 200, {
          "request-id": "req_upstream_1",
        }),
      ),
    );

    const events = await collect(provider(fetchMock).execute("claude-test", canonicalRequest()));

    expect(joinedText(events)).toBe("Hello");
    expect(events[0]).toMatchObject({
      type: "response.started",
      responseId: "msg_1",
      provider: "anthropic",
      model: "claude-test",
      inputTokens: 12,
    });
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      finishReason: "end_turn",
      usage: {
        inputTokens: 12,
        cachedInputTokens: 3,
        outputTokens: 4,
      },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "x-api-key": "anthropic-secret",
      "anthropic-version": "2023-06-01",
    });
  });

  it("forwards Claude Code beta headers and open-ended Anthropic body fields", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(sseResponse(textEvents)));
    const request = canonicalRequest();
    request.protocolPassthrough = {
      protocol: "anthropic_messages",
      headers: {
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "context-management-2025-06-27,future-capability",
      },
      body: {
        model: "client-model-hint",
        max_tokens: 999,
        stream: false,
        messages: [{ role: "user", content: "Hello" }],
        system: [
          {
            type: "text",
            text: "Claude Code attribution",
            cache_control: { type: "ephemeral" },
          },
        ],
        thinking: { type: "adaptive" },
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        future_field: { enabled: true },
      },
    };

    await collect(provider(fetchMock).execute("claude-test", request));

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      "x-api-key": "anthropic-secret",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "context-management-2025-06-27,future-capability",
    });
    expect(typeof init?.body).toBe("string");
    if (typeof init?.body !== "string") {
      throw new Error("Expected the Anthropic request body to be serialized JSON.");
    }
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-test",
      max_tokens: 256,
      stream: true,
      thinking: { type: "adaptive" },
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      future_field: { enabled: true },
    });
    expect(body["system"]).toEqual([
      {
        type: "text",
        text: "Claude Code attribution",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("streams tool calls and preserves tool IDs", async () => {
    const events = await collect(
      provider(() =>
        Promise.resolve(
          sseResponse([
            textEvents[0],
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "toolu_1",
                name: "weather",
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"city":' },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '"Pune"}' },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 8 },
            },
            { type: "message_stop" },
          ]),
        ),
      ).execute("claude-test", canonicalRequest()),
    );

    expect(events).toContainEqual({
      type: "tool_call.started",
      index: 0,
      toolCallId: "toolu_1",
      name: "weather",
    });
    expect(events.filter((event) => event.type === "tool_call.arguments.delta")).toEqual([
      {
        type: "tool_call.arguments.delta",
        index: 0,
        toolCallId: "toolu_1",
        partialJson: '{"city":',
      },
      {
        type: "tool_call.arguments.delta",
        index: 0,
        toolCallId: "toolu_1",
        partialJson: '"Pune"}',
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      finishReason: "tool_use",
    });
  });

  it("round-trips prior tool calls and tool results in the outbound request", () => {
    const request = canonicalRequest();
    request.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "toolu_history",
            name: "weather",
            arguments: { city: "Pune" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "toolu_history",
            content: "27 C",
            isError: false,
          },
        ],
      },
    ];
    request.tools = [
      {
        name: "weather",
        description: "Read the weather",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
      },
    ];

    const outbound = toAnthropicRequest("claude-test", request);

    expect(outbound["messages"]).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_history",
            name: "weather",
            input: { city: "Pune" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_history",
            content: "27 C",
            is_error: false,
          },
        ],
      },
    ]);
  });

  it("maps portable JSON schema output and rejects non-portable loose JSON mode", () => {
    const request = canonicalRequest();
    request.responseFormat = {
      type: "json_schema",
      name: "weather",
      schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
    };

    expect(toAnthropicRequest("claude-test", request)).toMatchObject({
      output_config: {
        format: {
          type: "json_schema",
          schema: request.responseFormat.schema,
        },
      },
    });

    request.responseFormat = { type: "json_object" };
    expect(() => toAnthropicRequest("claude-test", request)).toThrow(
      "Anthropic requires a JSON schema",
    );
  });

  it("classifies and safely retries a rate limit before streaming starts", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "slow down" },
          }),
          { status: 429, headers: { "retry-after": "0" } },
        ),
      )
      .mockResolvedValueOnce(sseResponse(textEvents));

    const events = await collect(provider(fetchMock, 1).execute("claude-test", canonicalRequest()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("redacts the configured secret from upstream errors", async () => {
    const consume = collect(
      provider(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                type: "authentication_error",
                message: "bad key anthropic-secret",
              },
            }),
            { status: 401 },
          ),
        ),
      ).execute("claude-test", canonicalRequest()),
    );

    await expect(consume).rejects.toMatchObject<Partial<ProviderError>>({
      code: "authentication",
      retryable: false,
      statusCode: 401,
      message: "bad key [REDACTED]",
    });
  });

  it("maps cancellation to a stable provider error", async () => {
    const controller = new AbortController();
    const waitingFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const reason = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          },
          { once: true },
        );
      });
    const consume = collect(
      provider(waitingFetch).execute("claude-test", canonicalRequest(), controller.signal),
    );

    controller.abort(new Error("client went away"));
    await expect(consume).rejects.toMatchObject<Partial<ProviderError>>({
      code: "cancelled",
      retryable: false,
    });
  });

  it("rejects malformed known events as protocol errors", async () => {
    const malformed = [
      textEvents[0],
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "bad" },
      },
    ];

    await expect(
      collect(
        provider(() => Promise.resolve(sseResponse(malformed))).execute(
          "claude-test",
          canonicalRequest(),
        ),
      ),
    ).rejects.toMatchObject<Partial<ProviderError>>({ code: "protocol" });
  });

  it("parses CRLF event boundaries split across network chunks", async () => {
    const encoded = new TextEncoder().encode(
      textEvents
        .map((event) => `event: ${String(event.type)}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
        .join(""),
    );
    const splitAt = encoded.findIndex((byte, index) => byte === 13 && index > 20) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, splitAt));
        controller.enqueue(encoded.slice(splitAt));
        controller.close();
      },
    });

    const events = await collect(
      provider(() =>
        Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      ).execute("claude-test", canonicalRequest()),
    );

    expect(joinedText(events)).toBe("Hello");
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("preserves signed thinking deltas for Claude Code continuity", async () => {
    const thinkingEvents = [
      textEvents[0],
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Analyze carefully." },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "signed-thinking-value" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 4 },
      },
      { type: "message_stop" },
    ];

    const events = await collect(
      provider(() => Promise.resolve(sseResponse(thinkingEvents))).execute(
        "claude-test",
        canonicalRequest(),
      ),
    );

    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: "content.started",
          index: 0,
          contentType: "reasoning",
          reasoningKind: "signed_thinking",
        },
        { type: "reasoning.delta", index: 0, text: "Analyze carefully." },
        {
          type: "reasoning.signature.delta",
          index: 0,
          signature: "signed-thinking-value",
        },
      ]),
    );
  });

  it("maps the configured request deadline to a timeout error", async () => {
    const waitingFetch: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const reason = init.signal?.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          },
          { once: true },
        );
      });
    const timedProvider = new AnthropicProvider({
      name: "anthropic",
      apiKey: "test-key",
      models: [model("anthropic", "claude-test")],
      maxRetries: 0,
      requestTimeoutMs: 5,
      fetchImplementation: waitingFetch,
    });

    await expect(
      collect(timedProvider.execute("claude-test", canonicalRequest())),
    ).rejects.toMatchObject<Partial<ProviderError>>({
      code: "timeout",
      retryable: true,
    });
  });
});
