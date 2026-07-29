import { describe, expect, it } from "vitest";

import { AnthropicProvider, OpenAIProvider } from "../src/index.js";
import { canonicalRequest, collect, joinedText, model, sseResponse } from "./helpers.js";

describe("live-provider canonical contract", () => {
  it("runs the same canonical request through Anthropic and OpenAI", async () => {
    const anthropic = new AnthropicProvider({
      name: "anthropic",
      apiKey: "test-key",
      models: [model("anthropic", "claude-test")],
      maxRetries: 0,
      fetchImplementation: () =>
        Promise.resolve(
          sseResponse([
            {
              type: "message_start",
              message: {
                id: "msg_1",
                model: "claude-test",
                usage: { input_tokens: 2, output_tokens: 1 },
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
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 2 },
            },
            { type: "message_stop" },
          ]),
        ),
    });
    const openai = new OpenAIProvider({
      name: "openai",
      apiKey: "test-key",
      models: [model("openai", "gpt-test")],
      maxRetries: 0,
      fetchImplementation: () =>
        Promise.resolve(
          sseResponse([
            {
              type: "response.created",
              response: { id: "resp_1", model: "gpt-test", usage: null },
            },
            {
              type: "response.content_part.added",
              item_id: "msg_1",
              content_index: 0,
              part: { type: "output_text", text: "" },
            },
            {
              type: "response.output_text.delta",
              item_id: "msg_1",
              content_index: 0,
              delta: "Hello",
            },
            {
              type: "response.output_text.done",
              item_id: "msg_1",
              content_index: 0,
              text: "Hello",
            },
            {
              type: "response.completed",
              response: {
                id: "resp_1",
                model: "gpt-test",
                usage: { input_tokens: 2, output_tokens: 2 },
              },
            },
          ]),
        ),
    });

    const [anthropicEvents, openAIEvents] = await Promise.all([
      collect(anthropic.execute("claude-test", canonicalRequest())),
      collect(openai.execute("gpt-test", canonicalRequest())),
    ]);

    expect(joinedText(anthropicEvents)).toBe("Hello");
    expect(joinedText(openAIEvents)).toBe("Hello");
    expect(anthropicEvents.at(-1)?.type).toBe("response.completed");
    expect(openAIEvents.at(-1)?.type).toBe("response.completed");
  });
});
