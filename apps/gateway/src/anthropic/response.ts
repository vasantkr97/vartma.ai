import type { CanonicalEvent, FinishReason, TokenUsage } from "@vartma/canonical";

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  };
}

export async function collectAnthropicResponse(
  events: AsyncIterable<CanonicalEvent>,
): Promise<AnthropicMessageResponse> {
  let id = "";
  let model = "";
  let inputTokens = 0;
  let finishReason: FinishReason | null = null;
  let usage: TokenUsage = emptyUsage();
  const blocks = new Map<
    number,
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; signature: string }
    | { type: "tool_use"; id: string; name: string; partialJson: string }
  >();

  for await (const event of events) {
    switch (event.type) {
      case "response.started":
        id = event.responseId;
        model = event.model;
        inputTokens = event.inputTokens;
        break;
      case "content.started":
        if (event.contentType === "text") {
          blocks.set(event.index, { type: "text", text: "" });
        } else if (event.reasoningKind === "signed_thinking") {
          blocks.set(event.index, { type: "thinking", thinking: "", signature: "" });
        }
        break;
      case "text.delta": {
        const block = blocks.get(event.index);
        if (!block || block.type !== "text") {
          throw new Error(`Text delta received before text block ${event.index} started.`);
        }
        block.text += event.text;
        break;
      }
      case "reasoning.delta": {
        const block = blocks.get(event.index);
        if (block?.type === "thinking") {
          block.thinking += event.text;
        }
        break;
      }
      case "reasoning.signature.delta": {
        const block = blocks.get(event.index);
        if (block?.type === "thinking") {
          block.signature += event.signature;
        }
        break;
      }
      case "tool_call.started":
        blocks.set(event.index, {
          type: "tool_use",
          id: event.toolCallId,
          name: event.name,
          partialJson: "",
        });
        break;
      case "tool_call.arguments.delta": {
        const block = blocks.get(event.index);
        if (!block || block.type !== "tool_use") {
          throw new Error(`Tool arguments received before tool block ${event.index} started.`);
        }
        block.partialJson += event.partialJson;
        break;
      }
      case "usage.updated":
        usage = event.usage;
        break;
      case "response.completed":
        finishReason = event.finishReason;
        usage = event.usage;
        break;
      case "response.failed":
        throw new Error(event.message);
      case "content.completed":
      case "tool_call.completed":
        break;
    }
  }

  if (!id || !model || !finishReason) {
    throw new Error("Provider stream ended without a complete response.");
  }

  return {
    id,
    type: "message",
    role: "assistant",
    content: [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => {
        if (block.type === "text" || block.type === "thinking") {
          return block;
        }
        return {
          type: "tool_use" as const,
          id: block.id,
          name: block.name,
          input: parseToolInput(block.partialJson),
        };
      }),
    model,
    stop_reason: toAnthropicStopReason(finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens || inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cachedInputTokens,
    },
  };
}

export async function* toAnthropicSse(
  events: AsyncIterable<CanonicalEvent>,
): AsyncIterable<string> {
  const emittedBlocks = new Set<number>();
  for await (const event of events) {
    switch (event.type) {
      case "response.started":
        yield sse("message_start", {
          type: "message_start",
          message: {
            id: event.responseId,
            type: "message",
            role: "assistant",
            content: [],
            model: event.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: event.inputTokens, output_tokens: 0 },
          },
        });
        break;
      case "content.started":
        if (event.contentType === "text") {
          emittedBlocks.add(event.index);
          yield sse("content_block_start", {
            type: "content_block_start",
            index: event.index,
            content_block: { type: "text", text: "" },
          });
        } else if (event.reasoningKind === "signed_thinking") {
          emittedBlocks.add(event.index);
          yield sse("content_block_start", {
            type: "content_block_start",
            index: event.index,
            content_block: { type: "thinking", thinking: "" },
          });
        }
        break;
      case "text.delta":
        yield sse("content_block_delta", {
          type: "content_block_delta",
          index: event.index,
          delta: { type: "text_delta", text: event.text },
        });
        break;
      case "reasoning.delta":
        if (emittedBlocks.has(event.index)) {
          yield sse("content_block_delta", {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "thinking_delta", thinking: event.text },
          });
        }
        break;
      case "reasoning.signature.delta":
        if (emittedBlocks.has(event.index)) {
          yield sse("content_block_delta", {
            type: "content_block_delta",
            index: event.index,
            delta: { type: "signature_delta", signature: event.signature },
          });
        }
        break;
      case "tool_call.started":
        emittedBlocks.add(event.index);
        yield sse("content_block_start", {
          type: "content_block_start",
          index: event.index,
          content_block: {
            type: "tool_use",
            id: event.toolCallId,
            name: event.name,
            input: {},
          },
        });
        break;
      case "tool_call.arguments.delta":
        yield sse("content_block_delta", {
          type: "content_block_delta",
          index: event.index,
          delta: { type: "input_json_delta", partial_json: event.partialJson },
        });
        break;
      case "tool_call.completed":
      case "content.completed":
        if (emittedBlocks.delete(event.index)) {
          yield sse("content_block_stop", {
            type: "content_block_stop",
            index: event.index,
          });
        }
        break;
      case "response.completed":
        yield sse("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: toAnthropicStopReason(event.finishReason),
            stop_sequence: null,
          },
          usage: { output_tokens: event.usage.outputTokens },
        });
        yield sse("message_stop", { type: "message_stop" });
        break;
      case "response.failed":
        yield sse("error", {
          type: "error",
          error: { type: event.errorType, message: event.message },
        });
        break;
      case "usage.updated":
        break;
    }
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseToolInput(value: string): unknown {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("Provider produced invalid JSON tool arguments.", { cause: error });
  }
}

function toAnthropicStopReason(reason: FinishReason): string {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "stop_sequence":
      return "stop_sequence";
    case "content_filter":
    case "cancelled":
    case "error":
      return "end_turn";
  }
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}
