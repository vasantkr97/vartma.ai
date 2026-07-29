import type { CanonicalEvent, FinishReason, TokenUsage } from "@vartma/canonical";

import type { OpenAIResponsesRequest } from "./responses-schema.js";

type OutputItem =
  | {
      id: string;
      type: "message";
      status: "in_progress" | "completed";
      role: "assistant";
      content: Array<{ type: "output_text"; text: string; annotations: unknown[] }>;
    }
  | {
      id: string;
      type: "reasoning";
      status: "in_progress" | "completed";
      summary: Array<{ type: "summary_text"; text: string }>;
    }
  | {
      id: string;
      type: "function_call";
      status: "in_progress" | "completed";
      call_id: string;
      name: string;
      arguments: string;
    };

interface ResponseState {
  id: string;
  model: string;
  createdAt: number;
  sequenceNumber: number;
  output: Map<number, OutputItem>;
  usage: TokenUsage;
  finishReason: FinishReason | null;
  error: { code: string; message: string } | null;
  usageKnown: boolean;
  request: OpenAIResponsesRequest;
}

export async function collectOpenAIResponse(
  events: AsyncIterable<CanonicalEvent>,
  request: OpenAIResponsesRequest,
): Promise<Record<string, unknown>> {
  const state = createState(request);
  for await (const event of events) {
    applyEvent(event, state);
  }
  if (!state.id || !state.model || (!state.finishReason && !state.error)) {
    throw new Error("Provider stream ended without a complete response.");
  }
  return responseObject(state);
}

export async function* toOpenAIResponseSse(
  events: AsyncIterable<CanonicalEvent>,
  request: OpenAIResponsesRequest,
): AsyncIterable<string> {
  const state = createState(request);
  for await (const event of events) {
    for (const outputEvent of applyEvent(event, state)) {
      yield `event: ${String(outputEvent["type"])}\ndata: ${JSON.stringify(outputEvent)}\n\n`;
    }
  }
}

function applyEvent(event: CanonicalEvent, state: ResponseState): Array<Record<string, unknown>> {
  const outputs: Array<Record<string, unknown>> = [];
  switch (event.type) {
    case "response.started":
      state.id = event.responseId;
      state.model = event.model;
      state.usage = { ...state.usage, inputTokens: event.inputTokens };
      outputs.push(
        streamEvent(state, "response.created", { response: responseObject(state) }),
        streamEvent(state, "response.in_progress", { response: responseObject(state) }),
      );
      break;
    case "content.started": {
      if (event.contentType === "text") {
        const item: OutputItem = {
          id: outputId(state, "msg", event.index),
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [{ type: "output_text", text: "", annotations: [] }],
        };
        state.output.set(event.index, item);
        outputs.push(
          streamEvent(state, "response.output_item.added", {
            output_index: event.index,
            item: { ...item, content: [] },
          }),
          streamEvent(state, "response.content_part.added", {
            item_id: item.id,
            output_index: event.index,
            content_index: 0,
            part: item.content[0],
          }),
        );
      } else {
        const item: OutputItem = {
          id: outputId(state, "rs", event.index),
          type: "reasoning",
          status: "in_progress",
          summary: [{ type: "summary_text", text: "" }],
        };
        state.output.set(event.index, item);
        outputs.push(
          streamEvent(state, "response.output_item.added", {
            output_index: event.index,
            item: { ...item, summary: [] },
          }),
          streamEvent(state, "response.reasoning_summary_part.added", {
            item_id: item.id,
            output_index: event.index,
            summary_index: 0,
            part: item.summary[0],
          }),
        );
      }
      break;
    }
    case "text.delta": {
      const item = requireOutput(state, event.index, "message");
      item.content[0]!.text += event.text;
      outputs.push(
        streamEvent(state, "response.output_text.delta", {
          item_id: item.id,
          output_index: event.index,
          content_index: 0,
          delta: event.text,
          logprobs: [],
        }),
      );
      break;
    }
    case "reasoning.delta": {
      const item = requireOutput(state, event.index, "reasoning");
      item.summary[0]!.text += event.text;
      outputs.push(
        streamEvent(state, "response.reasoning_summary_text.delta", {
          item_id: item.id,
          output_index: event.index,
          summary_index: 0,
          delta: event.text,
        }),
      );
      break;
    }
    case "reasoning.signature.delta":
      break;
    case "tool_call.started": {
      const item: OutputItem = {
        id: outputId(state, "fc", event.index),
        type: "function_call",
        status: "in_progress",
        call_id: event.toolCallId,
        name: event.name,
        arguments: "",
      };
      state.output.set(event.index, item);
      outputs.push(
        streamEvent(state, "response.output_item.added", {
          output_index: event.index,
          item,
        }),
      );
      break;
    }
    case "tool_call.arguments.delta": {
      const item = requireOutput(state, event.index, "function_call");
      item.arguments += event.partialJson;
      outputs.push(
        streamEvent(state, "response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: event.index,
          delta: event.partialJson,
        }),
      );
      break;
    }
    case "tool_call.completed": {
      const item = requireOutput(state, event.index, "function_call");
      item.status = "completed";
      outputs.push(
        streamEvent(state, "response.function_call_arguments.done", {
          item_id: item.id,
          output_index: event.index,
          name: item.name,
          arguments: item.arguments,
        }),
        streamEvent(state, "response.output_item.done", {
          output_index: event.index,
          item,
        }),
      );
      break;
    }
    case "content.completed": {
      const item = state.output.get(event.index);
      if (!item || item.type === "function_call") {
        break;
      }
      item.status = "completed";
      if (item.type === "message") {
        outputs.push(
          streamEvent(state, "response.output_text.done", {
            item_id: item.id,
            output_index: event.index,
            content_index: 0,
            text: item.content[0]!.text,
            logprobs: [],
          }),
          streamEvent(state, "response.content_part.done", {
            item_id: item.id,
            output_index: event.index,
            content_index: 0,
            part: item.content[0],
          }),
        );
      } else {
        outputs.push(
          streamEvent(state, "response.reasoning_summary_text.done", {
            item_id: item.id,
            output_index: event.index,
            summary_index: 0,
            text: item.summary[0]!.text,
          }),
          streamEvent(state, "response.reasoning_summary_part.done", {
            item_id: item.id,
            output_index: event.index,
            summary_index: 0,
            part: item.summary[0],
          }),
        );
      }
      outputs.push(
        streamEvent(state, "response.output_item.done", {
          output_index: event.index,
          item,
        }),
      );
      break;
    }
    case "usage.updated":
      state.usage = event.usage;
      state.usageKnown = true;
      break;
    case "response.completed": {
      state.finishReason = event.finishReason;
      state.usage = event.usage;
      state.usageKnown = true;
      const type =
        event.finishReason === "max_tokens" || event.finishReason === "content_filter"
          ? "response.incomplete"
          : "response.completed";
      outputs.push(streamEvent(state, type, { response: responseObject(state) }));
      break;
    }
    case "response.failed":
      state.error = { code: event.errorType, message: event.message };
      outputs.push(streamEvent(state, "response.failed", { response: responseObject(state) }));
      break;
  }
  return outputs;
}

function responseObject(state: ResponseState): Record<string, unknown> {
  const status = state.error
    ? "failed"
    : state.finishReason === "max_tokens" || state.finishReason === "content_filter"
      ? "incomplete"
      : state.finishReason
        ? "completed"
        : "in_progress";
  return {
    id: state.id,
    object: "response",
    created_at: state.createdAt,
    completed_at: status === "completed" ? Math.floor(Date.now() / 1000) : null,
    status,
    error: state.error,
    incomplete_details:
      state.finishReason === "max_tokens"
        ? { reason: "max_output_tokens" }
        : state.finishReason === "content_filter"
          ? { reason: "content_filter" }
          : null,
    instructions: state.request.instructions ?? null,
    max_output_tokens: state.request.max_output_tokens,
    model: state.model,
    output: [...state.output.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, item]) => item),
    output_text: [...state.output.values()]
      .flatMap((item) => (item.type === "message" ? item.content.map((part) => part.text) : []))
      .join(""),
    parallel_tool_calls: state.request.parallel_tool_calls,
    previous_response_id: null,
    reasoning: {
      effort: state.request.reasoning?.effort ?? null,
      summary: state.request.reasoning?.summary ?? null,
    },
    store: state.request.store,
    temperature: state.request.temperature ?? 1,
    text: state.request.text ?? { format: { type: "text" } },
    tool_choice: state.request.tool_choice ?? "auto",
    tools: state.request.tools ?? [],
    top_p: state.request.top_p ?? 1,
    truncation: state.request.truncation,
    usage: state.usageKnown ? usageObject(state.usage) : null,
    user: null,
    metadata: state.request.metadata ?? {},
  };
}

function streamEvent(
  state: ResponseState,
  type: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  state.sequenceNumber += 1;
  return { type, ...fields, sequence_number: state.sequenceNumber };
}

function outputId(state: ResponseState, prefix: string, index: number): string {
  return `${prefix}_${state.id || "router"}_${index}`;
}

function requireOutput<T extends OutputItem["type"]>(
  state: ResponseState,
  index: number,
  type: T,
): Extract<OutputItem, { type: T }> {
  const item = state.output.get(index);
  if (!item || item.type !== type) {
    throw new Error(`Canonical ${type} output ${index} was not started.`);
  }
  return item as Extract<OutputItem, { type: T }>;
}

function usageObject(usage: TokenUsage): Record<string, unknown> {
  const inputTokens = usage.inputTokens + usage.cachedInputTokens;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: usage.cachedInputTokens },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    total_tokens: inputTokens + usage.outputTokens,
  };
}

function createState(request: OpenAIResponsesRequest): ResponseState {
  return {
    id: "",
    model: "",
    createdAt: Math.floor(Date.now() / 1000),
    sequenceNumber: 0,
    output: new Map(),
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    finishReason: null,
    error: null,
    usageKnown: false,
    request,
  };
}
