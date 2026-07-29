import type { CanonicalEvent, FinishReason, TokenUsage } from "@vartma/canonical";

interface ChatToolCall {
  index: number;
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatState {
  id: string;
  model: string;
  created: number;
  text: string;
  reasoning: string;
  toolCalls: Map<number, ChatToolCall>;
  finishReason: FinishReason | null;
  usage: TokenUsage;
}

export async function collectChatCompletion(
  events: AsyncIterable<CanonicalEvent>,
): Promise<Record<string, unknown>> {
  const state = createState();
  for await (const event of events) {
    applyEvent(event, state);
  }
  if (!state.id || !state.model || !state.finishReason) {
    throw new Error("Provider stream ended without a complete chat completion.");
  }
  return {
    id: state.id,
    object: "chat.completion",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: state.text || null,
          ...(state.reasoning ? { reasoning_content: state.reasoning } : {}),
          ...(state.toolCalls.size
            ? {
                tool_calls: [...state.toolCalls.values()].sort(
                  (left, right) => left.index - right.index,
                ),
              }
            : {}),
        },
        finish_reason: chatFinishReason(state.finishReason),
        logprobs: null,
      },
    ],
    usage: chatUsage(state.usage),
  };
}

export async function* toChatCompletionSse(
  events: AsyncIterable<CanonicalEvent>,
  options: { includeUsage: boolean },
): AsyncIterable<string> {
  const state = createState();
  for await (const event of events) {
    if (event.type === "response.failed") {
      yield `data: ${JSON.stringify({
        error: { message: event.message, type: event.errorType, code: null },
      })}\n\n`;
      yield "data: [DONE]\n\n";
      return;
    }
    applyEvent(event, state);
    if (event.type === "response.started") {
      yield chunk(state, { role: "assistant", content: "" }, null);
    } else if (event.type === "text.delta") {
      yield chunk(state, { content: event.text }, null);
    } else if (event.type === "reasoning.delta") {
      yield chunk(state, { reasoning_content: event.text }, null);
    } else if (event.type === "tool_call.started") {
      const toolCall = state.toolCalls.get(event.index);
      if (!toolCall) {
        throw new Error(`Tool call ${event.index} was not registered.`);
      }
      yield chunk(
        state,
        {
          tool_calls: [
            {
              index: toolCall.index,
              id: event.toolCallId,
              type: "function",
              function: { name: event.name, arguments: "" },
            },
          ],
        },
        null,
      );
    } else if (event.type === "tool_call.arguments.delta") {
      const toolCall = state.toolCalls.get(event.index);
      if (!toolCall) {
        throw new Error(`Tool-call delta received before tool ${event.index} started.`);
      }
      yield chunk(
        state,
        {
          tool_calls: [
            {
              index: toolCall.index,
              function: { arguments: event.partialJson },
            },
          ],
        },
        null,
      );
    } else if (event.type === "response.completed") {
      yield chunk(state, {}, chatFinishReason(event.finishReason));
      if (options.includeUsage) {
        yield `data: ${JSON.stringify({
          id: state.id,
          object: "chat.completion.chunk",
          created: state.created,
          model: state.model,
          choices: [],
          usage: chatUsage(state.usage),
        })}\n\n`;
      }
      yield "data: [DONE]\n\n";
    }
  }
}

function applyEvent(event: CanonicalEvent, state: ChatState): void {
  switch (event.type) {
    case "response.started":
      state.id = event.responseId;
      state.model = event.model;
      state.usage.inputTokens = event.inputTokens;
      break;
    case "text.delta":
      state.text += event.text;
      break;
    case "reasoning.delta":
      state.reasoning += event.text;
      break;
    case "tool_call.started":
      state.toolCalls.set(event.index, {
        index: state.toolCalls.size,
        id: event.toolCallId,
        type: "function",
        function: { name: event.name, arguments: "" },
      });
      break;
    case "tool_call.arguments.delta": {
      const toolCall = state.toolCalls.get(event.index);
      if (!toolCall) {
        throw new Error(`Tool-call delta received before tool ${event.index} started.`);
      }
      toolCall.function.arguments += event.partialJson;
      break;
    }
    case "usage.updated":
      state.usage = event.usage;
      break;
    case "response.completed":
      state.finishReason = event.finishReason;
      state.usage = event.usage;
      break;
    case "response.failed":
      throw new Error(event.message);
    case "content.started":
    case "content.completed":
    case "reasoning.signature.delta":
    case "tool_call.completed":
      break;
  }
}

function chunk(
  state: ChatState,
  delta: Record<string, unknown>,
  finishReason: string | null,
): string {
  return `data: ${JSON.stringify({
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    usage: null,
  })}\n\n`;
}

function chatFinishReason(reason: FinishReason): string {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    case "cancelled":
    case "error":
      return "stop";
  }
}

function chatUsage(usage: TokenUsage): Record<string, unknown> {
  const promptTokens = usage.inputTokens + usage.cachedInputTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: promptTokens + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedInputTokens },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
  };
}

function createState(): ChatState {
  return {
    id: "",
    model: "",
    created: Math.floor(Date.now() / 1000),
    text: "",
    reasoning: "",
    toolCalls: new Map(),
    finishReason: null,
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
  };
}
