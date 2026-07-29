import type { CanonicalRequest } from "@vartma/canonical";
import { describe, expect, it, vi } from "vitest";

import { OpenAICompatibleProvider, toCompatibleChatRequest } from "../src/index.js";
import { canonicalRequest, collect, joinedText, model } from "./helpers.js";

describe("OpenAICompatibleProvider", () => {
  it("streams Chat Completions text and final usage", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        chatSse([
          {
            id: "chatcmpl_1",
            model: "local-test",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          },
          {
            id: "chatcmpl_1",
            model: "local-test",
            choices: [{ index: 0, delta: { content: "local answer" }, finish_reason: null }],
          },
          {
            id: "chatcmpl_1",
            model: "local-test",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
          {
            id: "chatcmpl_1",
            model: "local-test",
            choices: [],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 3,
              total_tokens: 15,
              prompt_tokens_details: { cached_tokens: 2 },
            },
          },
        ]),
      ),
    );
    const provider = compatibleProvider(fetchMock);

    const events = await collect(provider.execute("local-test", canonicalRequest()));

    expect(joinedText(events)).toBe("local answer");
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      finishReason: "end_turn",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
      },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(init?.headers).toMatchObject({ authorization: "Bearer local-key" });
  });

  it("streams compatible tool calls with partial JSON", async () => {
    const provider = compatibleProvider(() =>
      Promise.resolve(
        chatSse([
          {
            id: "chatcmpl_tool",
            model: "local-test",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_local",
                      type: "function",
                      function: { name: "lookup", arguments: '{"query":' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl_tool",
            model: "local-test",
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: '"router"}' } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]),
      ),
    );

    const events = await collect(provider.execute("local-test", toolRequest()));
    expect(events).toContainEqual({
      type: "tool_call.started",
      index: 0,
      toolCallId: "call_local",
      name: "lookup",
    });
    expect(events.filter((event) => event.type === "tool_call.arguments.delta")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      finishReason: "tool_use",
    });
  });

  it("converts canonical tool and image history to compatible chat messages", () => {
    const request = toolRequest();
    request.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "call_1",
            name: "lookup",
            arguments: { query: "router" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call_1",
            content: "found",
            isError: false,
          },
        ],
      },
    ];
    expect(toCompatibleChatRequest("local-test", request)).toMatchObject({
      model: "local-test",
      stream: true,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "image_url",
              image_url: { url: "https://example.com/a.png" },
            },
          ],
        },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"router"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "found" },
      ],
    });
  });
});

function compatibleProvider(fetchImplementation: typeof fetch) {
  return new OpenAICompatibleProvider({
    name: "local",
    apiKey: "local-key",
    baseUrl: "http://127.0.0.1:8000",
    models: [model("local", "local-test")],
    maxRetries: 0,
    fetchImplementation,
  });
}

function toolRequest(): CanonicalRequest {
  const request = canonicalRequest();
  request.tools = [
    {
      name: "lookup",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  ];
  return request;
}

function chatSse(chunks: unknown[]): Response {
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}
