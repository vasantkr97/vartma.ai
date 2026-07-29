import { describe, expect, it, vi } from "vitest";

import { OpenAIProvider, toOpenAIResponseRequest } from "../src/index.js";
import type { ProviderError } from "../src/index.js";
import { canonicalRequest, collect, joinedText, model, sseResponse } from "./helpers.js";

const textEvents = [
  {
    type: "response.created",
    response: {
      id: "resp_1",
      model: "gpt-test",
      usage: null,
    },
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [],
    },
  },
  {
    type: "response.content_part.added",
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  },
  {
    type: "response.output_text.delta",
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    delta: "Hello",
  },
  {
    type: "response.output_text.done",
    item_id: "msg_1",
    output_index: 0,
    content_index: 0,
    text: "Hello",
  },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      model: "gpt-test",
      status: "completed",
      usage: {
        input_tokens: 14,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens: 3,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 17,
      },
    },
  },
];

function provider(fetchImplementation: typeof fetch, maxRetries = 0): OpenAIProvider {
  return new OpenAIProvider({
    name: "openai",
    apiKey: "openai-secret",
    models: [model("openai", "gpt-test")],
    maxRetries,
    fetchImplementation,
    sleepImplementation: () => Promise.resolve(),
  });
}

describe("OpenAIProvider", () => {
  it("preserves open-ended Responses fields for a native OpenAI upstream", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        sseResponse([
          {
            type: "response.created",
            response: { id: "resp_passthrough", model: "gpt-test", usage: null },
          },
          {
            type: "response.completed",
            response: {
              id: "resp_passthrough",
              model: "gpt-test",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ]),
      ),
    );
    const provider = new OpenAIProvider({
      name: "openai",
      apiKey: "openai-secret",
      models: [model("openai", "gpt-test")],
      maxRetries: 0,
      fetchImplementation: fetchMock,
    });
    const request = canonicalRequest();
    request.protocolPassthrough = {
      protocol: "openai_responses",
      headers: {},
      body: {
        model: "vartma-balanced",
        input: "original",
        stream: false,
        prompt_cache_key: "stable-user",
        future_option: { enabled: true },
      },
    };

    await collect(provider.execute("gpt-test", request));

    const [, init] = fetchMock.mock.calls[0]!;
    expect(typeof init?.body).toBe("string");
    if (typeof init?.body !== "string") {
      throw new Error("Expected serialized OpenAI request JSON.");
    }
    expect(JSON.parse(init.body)).toMatchObject({
      model: "gpt-test",
      stream: true,
      store: false,
      prompt_cache_key: "stable-user",
      future_option: { enabled: true },
    });
  });

  it("translates Responses text events and detailed usage", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(sseResponse(textEvents)));

    const events = await collect(provider(fetchMock).execute("gpt-test", canonicalRequest()));

    expect(joinedText(events)).toBe("Hello");
    expect(events[0]).toMatchObject({
      type: "response.started",
      responseId: "resp_1",
      provider: "openai",
      model: "gpt-test",
    });
    expect(events.at(-1)).toEqual({
      type: "response.completed",
      finishReason: "end_turn",
      usage: {
        inputTokens: 9,
        cachedInputTokens: 5,
        outputTokens: 3,
        reasoningTokens: 1,
      },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      authorization: "Bearer openai-secret",
    });
    if (typeof init?.body !== "string") {
      throw new Error("Expected a serialized JSON request body.");
    }
    expect(JSON.parse(init.body)).toMatchObject({
      model: "gpt-test",
      stream: true,
      store: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Hello" }],
        },
      ],
    });
  });

  it("streams function calls using call_id as the portable tool ID", async () => {
    const events = await collect(
      provider(() =>
        Promise.resolve(
          sseResponse([
            textEvents[0],
            {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                id: "fc_item_1",
                type: "function_call",
                call_id: "call_1",
                name: "weather",
                arguments: "",
              },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: "fc_item_1",
              output_index: 0,
              delta: '{"city":',
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: "fc_item_1",
              output_index: 0,
              delta: '"Pune"}',
            },
            {
              type: "response.function_call_arguments.done",
              item_id: "fc_item_1",
              output_index: 0,
              name: "weather",
              arguments: '{"city":"Pune"}',
            },
            {
              type: "response.completed",
              response: {
                id: "resp_1",
                model: "gpt-test",
                usage: { input_tokens: 12, output_tokens: 7 },
              },
            },
          ]),
        ),
      ).execute("gpt-test", canonicalRequest()),
    );

    expect(events).toContainEqual({
      type: "tool_call.started",
      index: 0,
      toolCallId: "call_1",
      name: "weather",
    });
    expect(events.filter((event) => event.type === "tool_call.arguments.delta")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      finishReason: "tool_use",
    });
  });

  it("round-trips prior function calls and outputs in canonical history", () => {
    const request = canonicalRequest();
    request.messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_history",
            name: "weather",
            arguments: { city: "Pune" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_history",
            content: "27 C",
            isError: false,
          },
        ],
      },
    ];

    const outbound = toOpenAIResponseRequest("gpt-test", request);

    expect(outbound["input"]).toEqual([
      {
        type: "function_call",
        call_id: "call_history",
        name: "weather",
        arguments: '{"city":"Pune"}',
      },
      {
        type: "function_call_output",
        call_id: "call_history",
        output: "27 C",
      },
    ]);
  });

  it("preserves failed tool-result semantics in function output", () => {
    const request = canonicalRequest();
    request.messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_failed",
            content: "weather service unavailable",
            isError: true,
          },
        ],
      },
    ];

    expect(toOpenAIResponseRequest("gpt-test", request)["input"]).toEqual([
      {
        type: "function_call_output",
        call_id: "call_failed",
        output: "Tool execution failed: weather service unavailable",
      },
    ]);
  });

  it("safely retries transient HTTP failures before response.created", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "temporarily unavailable" } }), {
          status: 503,
        }),
      )
      .mockResolvedValueOnce(sseResponse(textEvents));

    const events = await collect(provider(fetchMock, 1).execute("gpt-test", canonicalRequest()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.type).toBe("response.completed");
  });

  it("classifies authentication failures without leaking the key", async () => {
    const consume = collect(
      provider(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "invalid_api_key", message: "bad openai-secret" },
            }),
            { status: 401 },
          ),
        ),
      ).execute("gpt-test", canonicalRequest()),
    );

    await expect(consume).rejects.toMatchObject<Partial<ProviderError>>({
      code: "authentication",
      statusCode: 401,
      retryable: false,
      message: "bad [REDACTED]",
    });
  });

  it("turns in-stream failures into a terminal canonical event", async () => {
    const events = await collect(
      provider(() =>
        Promise.resolve(
          sseResponse([
            textEvents[0],
            {
              type: "response.failed",
              response: {
                id: "resp_1",
                model: "gpt-test",
                error: { code: "server_error", message: "generation failed" },
              },
            },
          ]),
        ),
      ).execute("gpt-test", canonicalRequest()),
    );

    expect(events.at(-1)).toEqual({
      type: "response.failed",
      errorType: "server_error",
      message: "generation failed",
      retryable: false,
    });
  });
});
