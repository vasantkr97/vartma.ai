import type {
  CanonicalContent,
  CanonicalEvent,
  CanonicalRequest,
  FinishReason,
  HealthStatus,
  ModelDefinition,
  TokenEstimate,
  TokenUsage,
} from "@vartma/canonical";

import {
  configuredHealth,
  configuredModels,
  createExecutionSignal,
  estimateCanonicalTokens,
  isRecord,
  modelCapabilities,
  parseJsonEvent,
  parseSse,
  providerAbortError,
  providerProtocolError,
  requestSse,
  resolveHttpProviderOptions,
  type HttpProviderOptions,
  type ResolvedHttpProviderOptions,
} from "./http.js";
import type { ProviderAdapter } from "./provider.js";

export interface OpenAICompatibleProviderOptions extends Omit<HttpProviderOptions, "baseUrl"> {
  baseUrl: string;
}

interface CompatibleStreamState {
  id: string;
  model: string;
  started: boolean;
  nextBlockIndex: number;
  textIndex?: number;
  reasoningIndex?: number;
  toolCalls: Map<number, { index: number; id: string; name: string; completed: boolean }>;
  finishReason?: FinishReason;
  usage: TokenUsage;
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  public readonly name: string;
  private readonly options: ResolvedHttpProviderOptions;

  public constructor(options: OpenAICompatibleProviderOptions) {
    this.options = resolveHttpProviderOptions(options);
    this.name = this.options.name;
  }

  public models(): Promise<ModelDefinition[]> {
    return configuredModels(this.options);
  }

  public capabilities(model: string) {
    return modelCapabilities(this.options, model);
  }

  public estimateTokens(request: CanonicalRequest, signal?: AbortSignal): Promise<TokenEstimate> {
    signal?.throwIfAborted();
    return Promise.resolve(estimateCanonicalTokens(request));
  }

  public async *execute(
    model: string,
    request: CanonicalRequest,
    callerSignal?: AbortSignal,
  ): AsyncIterable<CanonicalEvent> {
    modelCapabilities(this.options, model);
    const execution = createExecutionSignal(callerSignal, this.options.requestTimeoutMs);
    try {
      const response = await requestSse({
        provider: this.name,
        url: `${this.options.baseUrl}/v1/chat/completions`,
        apiKey: this.options.apiKey,
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        body: toCompatibleChatRequest(model, request),
        signal: execution.signal,
        maxRetries: this.options.maxRetries,
        fetchImplementation: this.options.fetchImplementation,
        sleepImplementation: this.options.sleepImplementation,
      });
      const state: CompatibleStreamState = {
        id: "",
        model,
        started: false,
        nextBlockIndex: 0,
        toolCalls: new Map(),
        usage: emptyUsage(),
      };
      let sawDone = false;
      for await (const message of parseSse(response.body!)) {
        execution.signal.throwIfAborted();
        if (message.data === "[DONE]") {
          sawDone = true;
          break;
        }
        const chunk = parseJsonEvent(message.data, this.name);
        for (const event of translateCompatibleChunk(chunk, state, this.name)) {
          yield event;
        }
      }
      if (!state.started) {
        throw providerProtocolError(this.name, "stream ended before the first chat chunk.");
      }
      if (!sawDone && state.finishReason === undefined) {
        throw providerProtocolError(this.name, "stream ended without a finish reason.");
      }
      yield* completeCompatibleStream(state);
    } catch (error) {
      throw providerAbortError(this.name, callerSignal, execution.timedOut(), error);
    } finally {
      execution.dispose();
    }
  }

  public health(model: string, signal?: AbortSignal): Promise<HealthStatus> {
    return configuredHealth(this.options, model, signal);
  }
}

export function toCompatibleChatRequest(
  model: string,
  request: CanonicalRequest,
): Record<string, unknown> {
  return {
    model,
    messages: toChatMessages(request),
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: request.maxOutputTokens,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.stopSequences ? { stop: request.stopSequences } : {}),
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              parameters: tool.inputSchema,
            },
          })),
        }
      : {}),
    ...(request.toolChoice ? { tool_choice: compatibleToolChoice(request.toolChoice) } : {}),
    ...(request.responseFormat
      ? {
          response_format:
            request.responseFormat.type === "json_schema"
              ? {
                  type: "json_schema",
                  json_schema: {
                    name: request.responseFormat.name,
                    schema: request.responseFormat.schema,
                    strict: true,
                  },
                }
              : { type: request.responseFormat.type },
        }
      : {}),
  };
}

function toChatMessages(request: CanonicalRequest): unknown[] {
  const messages: unknown[] = [];
  for (const message of request.messages) {
    const content: unknown[] = [];
    const toolCalls: unknown[] = [];
    const flush = () => {
      if (content.length === 0 && toolCalls.length === 0) {
        return;
      }
      const outgoingContent = content.splice(0);
      messages.push({
        role: message.role === "tool" ? "user" : message.role,
        content:
          outgoingContent.length === 1 && isTextPart(outgoingContent[0])
            ? outgoingContent[0].text
            : outgoingContent,
        ...(toolCalls.length ? { tool_calls: toolCalls.splice(0) } : {}),
      });
    };
    for (const block of message.content) {
      if (block.type === "tool_result") {
        flush();
        messages.push({
          role: "tool",
          tool_call_id: block.toolCallId,
          content: compatibleToolOutput(block.content, block.isError),
        });
      } else if (block.type === "tool_call") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: { name: block.name, arguments: JSON.stringify(block.arguments) },
        });
      } else {
        const converted = compatibleContent(block);
        if (converted) {
          content.push(converted);
        }
      }
    }
    flush();
  }
  return messages;
}

function compatibleContent(block: CanonicalContent): unknown {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image_url",
        image_url: {
          url:
            block.source.type === "url"
              ? block.source.url
              : `data:${block.source.mediaType};base64,${block.source.data}`,
        },
      };
    case "reasoning":
    case "tool_call":
    case "tool_result":
      return undefined;
  }
}

function compatibleToolOutput(content: string | CanonicalContent[], isError: boolean): string {
  const value =
    typeof content === "string"
      ? content
      : content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  return isError ? `Tool execution failed: ${value}` : value;
}

function compatibleToolChoice(choice: NonNullable<CanonicalRequest["toolChoice"]>): unknown {
  if (choice.type === "tool") {
    return { type: "function", function: { name: choice.name } };
  }
  return choice.type === "any" ? "required" : choice.type;
}

function translateCompatibleChunk(
  chunk: Record<string, unknown>,
  state: CompatibleStreamState,
  provider: string,
): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  const id = typeof chunk["id"] === "string" ? chunk["id"] : state.id;
  const model = typeof chunk["model"] === "string" ? chunk["model"] : state.model;
  if (!state.started) {
    if (!id) {
      throw providerProtocolError(provider, 'the first chat chunk needs an "id".');
    }
    state.started = true;
    state.id = id;
    state.model = model;
    events.push({
      type: "response.started",
      responseId: id,
      provider,
      model,
      inputTokens: 0,
    });
  }
  const usage = readCompatibleUsage(chunk["usage"]);
  if (usage) {
    state.usage = usage;
  }
  const choices: unknown[] = Array.isArray(chunk["choices"]) ? (chunk["choices"] as unknown[]) : [];
  const choice = choices.find(
    (value) => isRecord(value) && (value["index"] === 0 || value["index"] === undefined),
  );
  if (!isRecord(choice)) {
    return events;
  }
  const delta = isRecord(choice["delta"]) ? choice["delta"] : {};
  const content = delta["content"];
  if (typeof content === "string" && content) {
    if (state.textIndex === undefined) {
      state.textIndex = state.nextBlockIndex++;
      events.push({ type: "content.started", index: state.textIndex, contentType: "text" });
    }
    events.push({ type: "text.delta", index: state.textIndex, text: content });
  }
  const reasoning = delta["reasoning_content"] ?? delta["reasoning"];
  if (typeof reasoning === "string" && reasoning) {
    if (state.reasoningIndex === undefined) {
      state.reasoningIndex = state.nextBlockIndex++;
      events.push({
        type: "content.started",
        index: state.reasoningIndex,
        contentType: "reasoning",
        reasoningKind: "summary",
      });
    }
    events.push({
      type: "reasoning.delta",
      index: state.reasoningIndex,
      text: reasoning,
    });
  }
  if (Array.isArray(delta["tool_calls"])) {
    for (const value of delta["tool_calls"]) {
      if (!isRecord(value) || typeof value["index"] !== "number") {
        continue;
      }
      const upstreamIndex = value["index"];
      const functionValue = isRecord(value["function"]) ? value["function"] : {};
      let tool = state.toolCalls.get(upstreamIndex);
      if (!tool) {
        const idValue = value["id"];
        const name = functionValue["name"];
        if (typeof idValue !== "string" || typeof name !== "string") {
          throw providerProtocolError(
            provider,
            "the first tool-call delta needs id and function.name.",
          );
        }
        tool = {
          index: state.nextBlockIndex++,
          id: idValue,
          name,
          completed: false,
        };
        state.toolCalls.set(upstreamIndex, tool);
        events.push({
          type: "tool_call.started",
          index: tool.index,
          toolCallId: tool.id,
          name: tool.name,
        });
      }
      if (typeof functionValue["arguments"] === "string" && functionValue["arguments"]) {
        events.push({
          type: "tool_call.arguments.delta",
          index: tool.index,
          toolCallId: tool.id,
          partialJson: functionValue["arguments"],
        });
      }
    }
  }
  if (typeof choice["finish_reason"] === "string") {
    state.finishReason = compatibleFinishReason(choice["finish_reason"]);
  }
  return events;
}

function* completeCompatibleStream(state: CompatibleStreamState): Iterable<CanonicalEvent> {
  if (state.textIndex !== undefined) {
    yield { type: "content.completed", index: state.textIndex };
  }
  if (state.reasoningIndex !== undefined) {
    yield { type: "content.completed", index: state.reasoningIndex };
  }
  for (const tool of state.toolCalls.values()) {
    if (!tool.completed) {
      tool.completed = true;
      yield {
        type: "tool_call.completed",
        index: tool.index,
        toolCallId: tool.id,
      };
    }
  }
  yield { type: "usage.updated", usage: state.usage };
  yield {
    type: "response.completed",
    finishReason: state.finishReason ?? (state.toolCalls.size > 0 ? "tool_use" : "end_turn"),
    usage: state.usage,
  };
}

function readCompatibleUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const promptDetails = isRecord(value["prompt_tokens_details"])
    ? value["prompt_tokens_details"]
    : {};
  const completionDetails = isRecord(value["completion_tokens_details"])
    ? value["completion_tokens_details"]
    : {};
  const totalInput = numberOrZero(value["prompt_tokens"]);
  const cached = numberOrZero(promptDetails["cached_tokens"]);
  return {
    inputTokens: Math.max(0, totalInput - cached),
    cachedInputTokens: cached,
    outputTokens: numberOrZero(value["completion_tokens"]),
    reasoningTokens: numberOrZero(completionDetails["reasoning_tokens"]),
  };
}

function compatibleFinishReason(value: string): FinishReason {
  switch (value) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "content_filter";
    case "stop":
    default:
      return "end_turn";
  }
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value["type"] === "text" && typeof value["text"] === "string";
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}
