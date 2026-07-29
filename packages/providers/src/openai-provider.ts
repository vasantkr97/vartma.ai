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
  readNumber,
  readString,
  requestSse,
  resolveHttpProviderOptions,
  type HttpProviderOptions,
  type ResolvedHttpProviderOptions,
} from "./http.js";
import type { ProviderAdapter } from "./provider.js";

export interface OpenAIProviderOptions extends Omit<HttpProviderOptions, "baseUrl"> {
  baseUrl?: string;
  organization?: string;
  project?: string;
}

interface TextBlock {
  index: number;
  completed: boolean;
}

interface ToolBlock {
  index: number;
  itemId: string;
  callId: string;
  name: string;
  completed: boolean;
}

interface OpenAIStreamState {
  started: boolean;
  terminal: boolean;
  nextBlockIndex: number;
  textBlocks: Map<string, TextBlock>;
  toolBlocks: Map<string, ToolBlock>;
  sawToolCall: boolean;
  sawRefusal: boolean;
  usage: TokenUsage;
}

export class OpenAIProvider implements ProviderAdapter {
  public readonly name: string;
  private readonly options: ResolvedHttpProviderOptions;
  private readonly organization: string | undefined;
  private readonly project: string | undefined;

  public constructor(options: OpenAIProviderOptions) {
    this.options = resolveHttpProviderOptions({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.openai.com",
    });
    this.name = this.options.name;
    this.organization = options.organization;
    this.project = options.project;
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
        url: `${this.options.baseUrl}/v1/responses`,
        apiKey: this.options.apiKey,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          ...(this.organization ? { "openai-organization": this.organization } : {}),
          ...(this.project ? { "openai-project": this.project } : {}),
        },
        body: toOpenAIResponseRequest(model, request),
        signal: execution.signal,
        maxRetries: this.options.maxRetries,
        fetchImplementation: this.options.fetchImplementation,
        sleepImplementation: this.options.sleepImplementation,
      });

      const state: OpenAIStreamState = {
        started: false,
        terminal: false,
        nextBlockIndex: 0,
        textBlocks: new Map(),
        toolBlocks: new Map(),
        sawToolCall: false,
        sawRefusal: false,
        usage: emptyUsage(),
      };

      for await (const message of parseSse(response.body!)) {
        execution.signal.throwIfAborted();
        if (message.data === "[DONE]") {
          continue;
        }
        const event = parseJsonEvent(message.data, this.name);
        for (const canonicalEvent of translateOpenAIEvent(event, state, this.name)) {
          yield canonicalEvent;
        }
        if (state.terminal) {
          return;
        }
      }

      throw providerProtocolError(
        this.name,
        state.started
          ? "stream ended without a terminal response event."
          : "stream ended before response.created.",
      );
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

export function toOpenAIResponseRequest(
  model: string,
  request: CanonicalRequest,
): Record<string, unknown> {
  const passthrough =
    request.protocolPassthrough?.protocol === "openai_responses"
      ? request.protocolPassthrough.body
      : {};
  return {
    ...passthrough,
    model,
    input: toOpenAIInput(request),
    stream: true,
    store: false,
    max_output_tokens: request.maxOutputTokens,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            parameters: tool.inputSchema,
            strict: false,
          })),
        }
      : {}),
    ...(request.toolChoice ? { tool_choice: toOpenAIToolChoice(request.toolChoice) } : {}),
    ...(request.responseFormat
      ? {
          text: {
            format:
              request.responseFormat.type === "json_schema"
                ? {
                    type: "json_schema",
                    name: request.responseFormat.name,
                    schema: request.responseFormat.schema,
                    strict: true,
                  }
                : { type: request.responseFormat.type },
          },
        }
      : {}),
    ...(Object.keys(request.metadata).length ? { metadata: request.metadata } : {}),
  };
}

function toOpenAIInput(request: CanonicalRequest): unknown[] {
  const input: unknown[] = [];

  for (const message of request.messages) {
    const messageContent: unknown[] = [];
    const flushMessage = () => {
      if (messageContent.length === 0) {
        return;
      }
      input.push({
        type: "message",
        role: message.role === "tool" ? "user" : message.role,
        content: messageContent.splice(0),
      });
    };

    for (const block of message.content) {
      if (block.type === "tool_call") {
        flushMessage();
        input.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.arguments),
        });
      } else if (block.type === "tool_result") {
        flushMessage();
        input.push({
          type: "function_call_output",
          call_id: block.toolCallId,
          output: toOpenAIToolOutput(block.content, block.isError),
        });
      } else {
        const converted = toOpenAIMessageContent(block);
        if (converted) {
          messageContent.push(converted);
        }
      }
    }
    flushMessage();
  }

  return input;
}

function toOpenAIMessageContent(block: CanonicalContent): unknown {
  switch (block.type) {
    case "text":
      return { type: "input_text", text: block.text };
    case "image":
      return {
        type: "input_image",
        detail: "auto",
        image_url:
          block.source.type === "url"
            ? block.source.url
            : `data:${block.source.mediaType};base64,${block.source.data}`,
      };
    case "reasoning":
      // Hidden reasoning is not portable and must not be replayed as user-visible context.
      return undefined;
    case "tool_call":
    case "tool_result":
      return undefined;
  }
}

function toOpenAIToolOutput(content: string | CanonicalContent[], isError: boolean): unknown {
  if (typeof content === "string") {
    return isError ? `Tool execution failed: ${content}` : content;
  }
  const output = content.flatMap((block) => {
    const converted = toOpenAIMessageContent(block);
    return converted ? [converted] : [];
  });
  if (!isError) {
    return output.length ? output : "";
  }
  return [{ type: "input_text", text: "Tool execution failed." }, ...output];
}

function toOpenAIToolChoice(choice: NonNullable<CanonicalRequest["toolChoice"]>): unknown {
  switch (choice.type) {
    case "auto":
    case "none":
      return choice.type;
    case "any":
      return "required";
    case "tool":
      return { type: "function", name: choice.name };
  }
}

function translateOpenAIEvent(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): CanonicalEvent[] {
  const type = readString(event, "type", provider);
  switch (type) {
    case "response.created":
      return onResponseCreated(event, state, provider);
    case "response.content_part.added":
      return onContentPartAdded(event, state, provider);
    case "response.output_text.delta":
      return onOutputTextDelta(event, state, provider);
    case "response.refusal.delta":
      return onRefusalDelta(event, state, provider);
    case "response.output_text.done":
    case "response.refusal.done":
      return onOutputTextDone(event, state, provider);
    case "response.output_item.added":
      return onOutputItemAdded(event, state, provider);
    case "response.function_call_arguments.delta":
      return onFunctionArgumentsDelta(event, state, provider);
    case "response.function_call_arguments.done":
      return onFunctionArgumentsDone(event, state, provider);
    case "response.output_item.done":
      return onOutputItemDone(event, state, provider);
    case "response.completed":
      return onResponseCompleted(event, state, provider);
    case "response.incomplete":
      return onResponseIncomplete(event, state, provider);
    case "response.failed":
    case "response.cancelled":
      return onResponseFailure(event, state, provider, type);
    case "error": {
      state.terminal = true;
      return [
        {
          type: "response.failed",
          errorType: typeof event["code"] === "string" ? event["code"] : "upstream_stream_error",
          message:
            typeof event["message"] === "string"
              ? event["message"]
              : `${provider} returned an in-stream error.`,
          retryable: false,
        },
      ];
    }
    default:
      // Responses adds events over time. Unknown event families do not invalidate known output.
      return [];
  }
}

function onResponseCreated(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): CanonicalEvent[] {
  if (state.started) {
    throw providerProtocolError(provider, "duplicate response.created.");
  }
  const response = requireRecord(event["response"], provider, "response");
  state.started = true;
  state.usage = readOpenAIUsage(response["usage"]);
  return [
    {
      type: "response.started",
      responseId: readString(response, "id", provider),
      provider,
      model: readString(response, "model", provider),
      inputTokens: state.usage.inputTokens,
    },
  ];
}

function onContentPartAdded(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): CanonicalEvent[] {
  requireStarted(state, provider);
  const part = requireRecord(event["part"], provider, "part");
  const partType = readString(part, "type", provider);
  if (partType !== "output_text" && partType !== "refusal") {
    return [];
  }
  const key = textKey(event, provider);
  if (state.textBlocks.has(key)) {
    return [];
  }
  const block = { index: state.nextBlockIndex++, completed: false };
  state.textBlocks.set(key, block);
  return [{ type: "content.started", index: block.index, contentType: "text" }];
}

function onOutputTextDelta(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): CanonicalEvent[] {
  const { block, startedEvents } = requireTextBlock(event, state, provider);
  return [
    ...startedEvents,
    { type: "text.delta", index: block.index, text: readString(event, "delta", provider) },
  ];
}

function onRefusalDelta(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): CanonicalEvent[] {
  state.sawRefusal = true;
  return onOutputTextDelta(event, state, provider);
}

function onOutputTextDone(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): CanonicalEvent[] {
  const { block, startedEvents } = requireTextBlock(event, state, provider);
  if (block.completed) {
    return startedEvents;
  }
  block.completed = true;
  return [...startedEvents, { type: "content.completed", index: block.index }];
}

function onOutputItemAdded(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): CanonicalEvent[] {
  requireStarted(state, provider);
  const item = requireRecord(event["item"], provider, "item");
  if (item["type"] !== "function_call") {
    return [];
  }
  const itemId = readString(item, "id", provider);
  if (state.toolBlocks.has(itemId)) {
    return [];
  }
  const tool: ToolBlock = {
    index: state.nextBlockIndex++,
    itemId,
    callId: readString(item, "call_id", provider),
    name: readString(item, "name", provider),
    completed: false,
  };
  state.toolBlocks.set(itemId, tool);
  state.sawToolCall = true;
  return [
    {
      type: "tool_call.started",
      index: tool.index,
      toolCallId: tool.callId,
      name: tool.name,
    },
  ];
}

function onFunctionArgumentsDelta(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): CanonicalEvent[] {
  const tool = requireToolBlock(event, state, provider);
  return [
    {
      type: "tool_call.arguments.delta",
      index: tool.index,
      toolCallId: tool.callId,
      partialJson: readString(event, "delta", provider),
    },
  ];
}

function onFunctionArgumentsDone(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): CanonicalEvent[] {
  const tool = requireToolBlock(event, state, provider);
  return completeTool(tool);
}

function onOutputItemDone(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): CanonicalEvent[] {
  requireStarted(state, provider);
  const item = requireRecord(event["item"], provider, "item");
  if (item["type"] !== "function_call") {
    return [];
  }
  const itemId = readString(item, "id", provider);
  const tool = state.toolBlocks.get(itemId);
  if (!tool) {
    throw providerProtocolError(provider, `function call item "${itemId}" completed before start.`);
  }
  return completeTool(tool);
}

function onResponseCompleted(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): CanonicalEvent[] {
  requireStarted(state, provider);
  const response = requireRecord(event["response"], provider, "response");
  state.usage = readOpenAIUsage(response["usage"]);
  state.terminal = true;
  return [
    { type: "usage.updated", usage: { ...state.usage } },
    {
      type: "response.completed",
      finishReason: state.sawToolCall
        ? "tool_use"
        : state.sawRefusal
          ? "content_filter"
          : "end_turn",
      usage: { ...state.usage },
    },
  ];
}

function onResponseIncomplete(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): CanonicalEvent[] {
  requireStarted(state, provider);
  const response = requireRecord(event["response"], provider, "response");
  const details = isRecord(response["incomplete_details"]) ? response["incomplete_details"] : {};
  const reason =
    typeof details["reason"] === "string" ? openAIIncompleteReason(details["reason"]) : "error";
  state.usage = readOpenAIUsage(response["usage"]);
  state.terminal = true;
  return [
    { type: "usage.updated", usage: { ...state.usage } },
    { type: "response.completed", finishReason: reason, usage: { ...state.usage } },
  ];
}

function onResponseFailure(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
  eventType: string,
): CanonicalEvent[] {
  requireStarted(state, provider);
  const response = requireRecord(event["response"], provider, "response");
  const error = isRecord(response["error"]) ? response["error"] : {};
  state.terminal = true;
  return [
    {
      type: "response.failed",
      errorType:
        eventType === "response.cancelled"
          ? "cancelled"
          : typeof error["code"] === "string"
            ? error["code"]
            : "upstream_response_failed",
      message:
        typeof error["message"] === "string"
          ? error["message"]
          : eventType === "response.cancelled"
            ? `${provider} cancelled the response.`
            : `${provider} failed to generate a response.`,
      retryable: false,
    },
  ];
}

function requireTextBlock(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): { block: TextBlock; startedEvents: CanonicalEvent[] } {
  requireStarted(state, provider);
  const key = textKey(event, provider);
  const existing = state.textBlocks.get(key);
  if (existing) {
    return { block: existing, startedEvents: [] };
  }
  const block = { index: state.nextBlockIndex++, completed: false };
  state.textBlocks.set(key, block);
  return {
    block,
    startedEvents: [{ type: "content.started", index: block.index, contentType: "text" }],
  };
}

function requireToolBlock(
  event: Record<string, unknown>,
  state: OpenAIStreamState,
  provider: string,
): ToolBlock {
  requireStarted(state, provider);
  const itemId = readString(event, "item_id", provider);
  const tool = state.toolBlocks.get(itemId);
  if (!tool) {
    throw providerProtocolError(provider, `function arguments arrived before item "${itemId}".`);
  }
  return tool;
}

function completeTool(tool: ToolBlock): CanonicalEvent[] {
  if (tool.completed) {
    return [];
  }
  tool.completed = true;
  return [{ type: "tool_call.completed", index: tool.index, toolCallId: tool.callId }];
}

function textKey(event: Record<string, unknown>, provider: string): string {
  const itemId = readString(event, "item_id", provider);
  const contentIndex = readNumber(event, "content_index", provider, 0);
  return `${itemId}:${contentIndex}`;
}

function readOpenAIUsage(value: unknown): TokenUsage {
  if (!isRecord(value)) {
    return emptyUsage();
  }
  const inputDetails = isRecord(value["input_tokens_details"]) ? value["input_tokens_details"] : {};
  const outputDetails = isRecord(value["output_tokens_details"])
    ? value["output_tokens_details"]
    : {};
  const totalInputTokens = optionalNumber(value["input_tokens"]);
  const cachedInputTokens = optionalNumber(inputDetails["cached_tokens"]);
  return {
    inputTokens: Math.max(0, totalInputTokens - cachedInputTokens),
    cachedInputTokens,
    outputTokens: optionalNumber(value["output_tokens"]),
    reasoningTokens: optionalNumber(outputDetails["reasoning_tokens"]),
  };
}

function requireRecord(value: unknown, provider: string, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw providerProtocolError(provider, `"${field}" must be an object.`);
  }
  return value;
}

function requireStarted(state: OpenAIStreamState, provider: string): void {
  if (!state.started) {
    throw providerProtocolError(provider, "output event received before response.created.");
  }
}

function optionalNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function openAIIncompleteReason(reason: string): FinishReason {
  switch (reason) {
    case "max_output_tokens":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    default:
      return "error";
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
