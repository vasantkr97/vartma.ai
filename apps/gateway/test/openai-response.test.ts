import type { CanonicalEvent } from "@vartma/canonical";
import { describe, expect, it } from "vitest";

import { collectChatCompletion, toChatCompletionSse } from "../src/openai/chat-response.js";
import { collectOpenAIResponse, toOpenAIResponseSse } from "../src/openai/responses-response.js";
import { openAIResponsesRequestSchema } from "../src/openai/responses-schema.js";

describe("OpenAI response translation", () => {
  it("emits a complete Responses lifecycle and reports cached tokens in total input", async () => {
    const request = openAIResponsesRequestSchema.parse({
      model: "vartma-balanced",
      input: "hello",
      stream: true,
      max_output_tokens: 128,
      metadata: { test: "lifecycle" },
    });

    const chunks = await collectStrings(toOpenAIResponseSse(textEvents(), request));
    const events = parseResponseEvents(chunks);

    expect(events.map((event) => event["type"])).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.map((event) => event["sequence_number"])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(responseFrom(events[0]!)).toMatchObject({
      status: "in_progress",
      usage: null,
      max_output_tokens: 128,
      metadata: { test: "lifecycle" },
    });
    expect(events[2]).toMatchObject({
      item: { type: "message", status: "in_progress", content: [] },
    });
    expect(responseFrom(events.at(-1)!)).toMatchObject({
      status: "completed",
      output_text: "hello",
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens: 3,
        total_tokens: 13,
      },
    });
  });

  it("uses contiguous Chat tool indexes and reports cached tokens in prompt totals", async () => {
    const completion = await collectChatCompletion(chatToolEvents());
    expect(completion).toMatchObject({
      choices: [
        {
          message: {
            content: "checking",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "lookup", arguments: '{"query":"router"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    });

    const chunks = await collectStrings(
      toChatCompletionSse(chatToolEvents(), { includeUsage: true }),
    );
    const payloads = chunks
      .flatMap((chunk) => chunk.split("\n"))
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const toolChunks = payloads.filter((payload) =>
      JSON.stringify(payload).includes('"tool_calls":['),
    );
    expect(toolChunks).toHaveLength(2);
    expect(toolChunks.every((payload) => JSON.stringify(payload).includes('"index":0'))).toBe(true);
    expect(payloads.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 10, total_tokens: 14 },
    });
    expect(chunks.at(-1)).toBe("data: [DONE]\n\n");
  });

  it("maps content filtering to an incomplete Responses result", async () => {
    const request = openAIResponsesRequestSchema.parse({
      model: "vartma-balanced",
      input: "hello",
    });
    const response = await collectOpenAIResponse(contentFilterEvents(), request);
    expect(response).toMatchObject({
      status: "incomplete",
      completed_at: null,
      incomplete_details: { reason: "content_filter" },
    });
  });
});

async function* textEvents(): AsyncIterable<CanonicalEvent> {
  await Promise.resolve();
  yield {
    type: "response.started",
    responseId: "resp_router",
    provider: "fake",
    model: "fake-default",
    inputTokens: 8,
  };
  yield { type: "content.started", index: 0, contentType: "text" };
  yield { type: "text.delta", index: 0, text: "hello" };
  yield { type: "content.completed", index: 0 };
  const usage = {
    inputTokens: 8,
    cachedInputTokens: 2,
    outputTokens: 3,
    reasoningTokens: 0,
  };
  yield { type: "usage.updated", usage };
  yield { type: "response.completed", finishReason: "end_turn", usage };
}

async function* chatToolEvents(): AsyncIterable<CanonicalEvent> {
  await Promise.resolve();
  yield {
    type: "response.started",
    responseId: "chatcmpl_router",
    provider: "fake",
    model: "fake-default",
    inputTokens: 8,
  };
  yield { type: "content.started", index: 0, contentType: "text" };
  yield { type: "text.delta", index: 0, text: "checking" };
  yield { type: "content.completed", index: 0 };
  yield {
    type: "tool_call.started",
    index: 4,
    toolCallId: "call_1",
    name: "lookup",
  };
  yield {
    type: "tool_call.arguments.delta",
    index: 4,
    toolCallId: "call_1",
    partialJson: '{"query":"router"}',
  };
  yield { type: "tool_call.completed", index: 4, toolCallId: "call_1" };
  const usage = {
    inputTokens: 8,
    cachedInputTokens: 2,
    outputTokens: 4,
    reasoningTokens: 1,
  };
  yield { type: "usage.updated", usage };
  yield { type: "response.completed", finishReason: "tool_use", usage };
}

async function* contentFilterEvents(): AsyncIterable<CanonicalEvent> {
  await Promise.resolve();
  yield {
    type: "response.started",
    responseId: "resp_filtered",
    provider: "fake",
    model: "fake-default",
    inputTokens: 1,
  };
  const usage = {
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  yield { type: "response.completed", finishReason: "content_filter", usage };
}

async function collectStrings(values: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const value of values) {
    result.push(value);
  }
  return result;
}

function parseResponseEvents(chunks: string[]): Array<Record<string, unknown>> {
  return chunks.map((chunk) => {
    const data = chunk
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    if (!data) {
      throw new Error("Responses event did not contain an SSE data field.");
    }
    return JSON.parse(data) as Record<string, unknown>;
  });
}

function responseFrom(event: Record<string, unknown>): Record<string, unknown> {
  const response = event["response"];
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Expected a Responses event with a response object.");
  }
  return response as Record<string, unknown>;
}
