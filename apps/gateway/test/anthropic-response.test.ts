import type { CanonicalEvent } from "@vartma/canonical";
import { describe, expect, it } from "vitest";

import { collectAnthropicResponse, toAnthropicSse } from "../src/anthropic/response.js";

const signedThinkingEvents: CanonicalEvent[] = [
  {
    type: "response.started",
    responseId: "message-1",
    provider: "anthropic",
    model: "claude-upstream",
    inputTokens: 5,
  },
  {
    type: "content.started",
    index: 0,
    contentType: "reasoning",
    reasoningKind: "signed_thinking",
  },
  { type: "reasoning.delta", index: 0, text: "Private analysis." },
  {
    type: "reasoning.signature.delta",
    index: 0,
    signature: "signature-value",
  },
  { type: "content.completed", index: 0 },
  {
    type: "response.completed",
    finishReason: "end_turn",
    usage: {
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 3,
      reasoningTokens: 2,
    },
  },
];

describe("Anthropic response translation", () => {
  it("returns signed thinking in non-streaming Anthropic responses", async () => {
    const response = await collectAnthropicResponse(fromArray(signedThinkingEvents));

    expect(response.content).toEqual([
      {
        type: "thinking",
        thinking: "Private analysis.",
        signature: "signature-value",
      },
    ]);
  });

  it("streams signed thinking and signature deltas in Anthropic SSE form", async () => {
    const chunks = await collectStrings(toAnthropicSse(fromArray(signedThinkingEvents)));
    const stream = chunks.join("");

    expect(stream).toContain('"content_block":{"type":"thinking","thinking":""}');
    expect(stream).toContain('"type":"thinking_delta","thinking":"Private analysis."');
    expect(stream).toContain('"type":"signature_delta","signature":"signature-value"');
    expect(stream).toContain("event: content_block_stop");
  });

  it("does not expose unsigned provider reasoning summaries as Anthropic thinking", async () => {
    const events: CanonicalEvent[] = [
      signedThinkingEvents[0]!,
      {
        type: "content.started",
        index: 0,
        contentType: "reasoning",
        reasoningKind: "summary",
      },
      { type: "reasoning.delta", index: 0, text: "Portable summary" },
      { type: "content.completed", index: 0 },
      signedThinkingEvents.at(-1)!,
    ];

    const stream = (await collectStrings(toAnthropicSse(fromArray(events)))).join("");
    expect(stream).not.toContain("thinking_delta");
    expect(stream).not.toContain("content_block_stop");
  });
});

async function* fromArray(events: CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  await Promise.resolve();
  for (const event of events) {
    yield event;
  }
}

async function collectStrings(source: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = [];
  for await (const item of source) {
    result.push(item);
  }
  return result;
}
