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
import { ProviderError, type ProviderAdapter } from "./provider.js";

export interface AnthropicProviderOptions extends Omit<HttpProviderOptions, "baseUrl"> {
  baseUrl?: string;
  anthropicVersion?: string;
}

interface AnthropicStreamState {
  started: boolean;
  responseId: string;
  model: string;
  finishReason: FinishReason;
  usage: TokenUsage;
  blocks: Map<number, "text" | "reasoning" | "tool_call">;
  toolCallIds: Map<number, string>;
  failed: boolean;
  terminal: boolean;
}

export class AnthropicProvider implements ProviderAdapter {
  public readonly name: string;
  private readonly options: ResolvedHttpProviderOptions;
  private readonly anthropicVersion: string;

  public constructor(options: AnthropicProviderOptions) {
    this.options = resolveHttpProviderOptions({
      ...options,
      baseUrl: options.baseUrl ?? "https://api.anthropic.com",
    });
    this.name = this.options.name;
    this.anthropicVersion = options.anthropicVersion ?? "2023-06-01";
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
        url: `${this.options.baseUrl}/v1/messages`,
        apiKey: this.options.apiKey,
        headers: {
          ...anthropicPassthroughHeaders(request),
          "x-api-key": this.options.apiKey,
          "anthropic-version":
            anthropicPassthroughHeaders(request)["anthropic-version"] ?? this.anthropicVersion,
        },
        body: toAnthropicRequestWithPassthrough(model, request),
        signal: execution.signal,
        maxRetries: this.options.maxRetries,
        fetchImplementation: this.options.fetchImplementation,
        sleepImplementation: this.options.sleepImplementation,
      });

      const state: AnthropicStreamState = {
        started: false,
        responseId: "",
        model,
        finishReason: "end_turn",
        usage: emptyUsage(),
        blocks: new Map(),
        toolCallIds: new Map(),
        failed: false,
        terminal: false,
      };

      for await (const message of parseSse(response.body!)) {
        execution.signal.throwIfAborted();
        if (message.data === "[DONE]") {
          continue;
        }
        const event = parseJsonEvent(message.data, this.name);
        const events = translateAnthropicEvent(event, state, this.name);
        for (const canonicalEvent of events) {
          yield canonicalEvent;
        }
        if (state.failed) {
          return;
        }
        if (state.terminal) {
          return;
        }
      }

      if (state.started) {
        throw providerProtocolError(this.name, "stream ended before message_stop.");
      }
      throw providerProtocolError(this.name, "stream ended before message_start.");
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

function toAnthropicRequestWithPassthrough(
  model: string,
  request: CanonicalRequest,
): Record<string, unknown> {
  const translated = toAnthropicRequest(model, request);
  const passthrough =
    request.protocolPassthrough?.protocol === "anthropic_messages"
      ? request.protocolPassthrough.body
      : undefined;
  return {
    ...translated,
    ...(passthrough ?? {}),
    model,
    max_tokens: request.maxOutputTokens,
    stream: true,
  };
}

function anthropicPassthroughHeaders(request: CanonicalRequest): Record<string, string> {
  return request.protocolPassthrough?.protocol === "anthropic_messages"
    ? request.protocolPassthrough.headers
    : {};
}

export function toAnthropicRequest(
  model: string,
  request: CanonicalRequest,
): Record<string, unknown> {
  const system: Array<{ type: "text"; text: string }> = [];
  const messages: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];

  for (const message of request.messages) {
    if (message.role === "system") {
      for (const block of message.content) {
        if (block.type === "text") {
          system.push({ type: "text", text: block.text });
        }
      }
      continue;
    }

    const content = message.content.flatMap(toAnthropicContent);
    if (content.length === 0) {
      continue;
    }
    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content,
    });
  }

  return {
    model,
    max_tokens: request.maxOutputTokens,
    messages,
    stream: true,
    ...(system.length ? { system } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.stopSequences ? { stop_sequences: request.stopSequences } : {}),
    ...(request.tools.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            input_schema: tool.inputSchema,
          })),
        }
      : {}),
    ...(request.toolChoice ? { tool_choice: toAnthropicToolChoice(request.toolChoice) } : {}),
    ...toAnthropicResponseFormat(request),
  };
}

function toAnthropicResponseFormat(request: CanonicalRequest): Record<string, unknown> {
  if (!request.responseFormat || request.responseFormat.type === "text") {
    return {};
  }
  if (request.responseFormat.type === "json_object") {
    throw new ProviderError(
      "Anthropic requires a JSON schema for structured output; json_object is not portable.",
      "invalid_request",
      false,
    );
  }
  return {
    output_config: {
      format: {
        type: "json_schema",
        schema: request.responseFormat.schema,
      },
    },
  };
}

function toAnthropicContent(block: CanonicalContent): unknown[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text }];
    case "image":
      return block.source.type === "url"
        ? [{ type: "image", source: { type: "url", url: block.source.url } }]
        : [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: block.source.mediaType,
                data: block.source.data,
              },
            },
          ];
    case "tool_call":
      return [
        {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.arguments,
        },
      ];
    case "tool_result":
      return [
        {
          type: "tool_result",
          tool_use_id: block.toolCallId,
          content:
            typeof block.content === "string"
              ? block.content
              : block.content.flatMap(toAnthropicToolResultContent),
          is_error: block.isError,
        },
      ];
    case "reasoning":
      // Hidden reasoning is intentionally not replayed between providers.
      return [];
  }
}

function toAnthropicToolResultContent(block: CanonicalContent): unknown[] {
  if (block.type === "text") {
    return [{ type: "text", text: block.text }];
  }
  if (block.type === "image") {
    return toAnthropicContent(block);
  }
  return [];
}

function toAnthropicToolChoice(choice: NonNullable<CanonicalRequest["toolChoice"]>): unknown {
  switch (choice.type) {
    case "auto":
    case "any":
    case "none":
      return { type: choice.type };
    case "tool":
      return { type: "tool", name: choice.name };
  }
}

function translateAnthropicEvent(
  event: Record<string, unknown>,
  state: AnthropicStreamState,
  provider: string,
): CanonicalEvent[] {
  const type = readString(event, "type", provider);
  switch (type) {
    case "message_start":
      return onAnthropicMessageStart(event, state, provider);
    case "content_block_start":
      return onAnthropicContentStart(event, state, provider);
    case "content_block_delta":
      return onAnthropicContentDelta(event, state, provider);
    case "content_block_stop":
      return onAnthropicContentStop(event, state, provider);
    case "message_delta":
      return onAnthropicMessageDelta(event, state, provider);
    case "message_stop": {
      if (!state.started) {
        throw providerProtocolError(provider, "message_stop received before message_start.");
      }
      state.started = false;
      state.terminal = true;
      return [
        { type: "usage.updated", usage: { ...state.usage } },
        {
          type: "response.completed",
          finishReason: state.finishReason,
          usage: { ...state.usage },
        },
      ];
    }
    case "error": {
      const error = isRecord(event["error"]) ? event["error"] : {};
      const upstreamType =
        typeof error["type"] === "string" ? error["type"] : "upstream_stream_error";
      const message =
        typeof error["message"] === "string"
          ? error["message"]
          : `${provider} returned an in-stream error.`;
      state.failed = true;
      return [
        {
          type: "response.failed",
          errorType: upstreamType,
          message,
          retryable: upstreamType === "overloaded_error" || upstreamType === "rate_limit_error",
        },
      ];
    }
    case "ping":
      return [];
    default:
      // Anthropic may add new SSE event types; unknown events are ignored for forward compatibility.
      return [];
  }
}

function onAnthropicMessageStart(
  event: Record<string, unknown>,
  state: AnthropicStreamState,
  provider: string,
): CanonicalEvent[] {
  if (state.started) {
    throw providerProtocolError(provider, "duplicate message_start.");
  }
  const message = requireRecord(event["message"], provider, "message");
  const usage = isRecord(message["usage"]) ? message["usage"] : {};
  const inputTokens =
    optionalNumber(usage["input_tokens"]) + optionalNumber(usage["cache_creation_input_tokens"]);
  state.started = true;
  state.responseId = readString(message, "id", provider);
  state.model = readString(message, "model", provider);
  state.usage = {
    inputTokens,
    cachedInputTokens: optionalNumber(usage["cache_read_input_tokens"]),
    outputTokens: optionalNumber(usage["output_tokens"]),
    reasoningTokens: 0,
  };
  return [
    {
      type: "response.started",
      responseId: state.responseId,
      provider,
      model: state.model,
      inputTokens,
    },
  ];
}

function onAnthropicContentStart(
  event: Record<string, unknown>,
  state: AnthropicStreamState,
  provider: string,
): CanonicalEvent[] {
  requireStarted(state, provider);
  const index = readNumber(event, "index", provider);
  const block = requireRecord(event["content_block"], provider, "content_block");
  const blockType = readString(block, "type", provider);

  if (blockType === "text") {
    state.blocks.set(index, "text");
    return [{ type: "content.started", index, contentType: "text" }];
  }
  if (blockType === "thinking") {
    state.blocks.set(index, "reasoning");
    return [
      {
        type: "content.started",
        index,
        contentType: "reasoning",
        reasoningKind: "signed_thinking",
      },
    ];
  }
  if (blockType === "tool_use") {
    state.blocks.set(index, "tool_call");
    const toolCallId = readString(block, "id", provider);
    state.toolCallIds.set(index, toolCallId);
    return [
      {
        type: "tool_call.started",
        index,
        toolCallId,
        name: readString(block, "name", provider),
      },
    ];
  }
  return [];
}

function onAnthropicContentDelta(
  event: Record<string, unknown>,
  state: AnthropicStreamState,
  provider: string,
): CanonicalEvent[] {
  requireStarted(state, provider);
  const index = readNumber(event, "index", provider);
  const delta = requireRecord(event["delta"], provider, "delta");
  const deltaType = readString(delta, "type", provider);
  const blockType = state.blocks.get(index);
  if (!blockType) {
    throw providerProtocolError(provider, `delta received before content block ${index} started.`);
  }

  if (deltaType === "text_delta" && blockType === "text") {
    return [{ type: "text.delta", index, text: readString(delta, "text", provider) }];
  }
  if (deltaType === "thinking_delta" && blockType === "reasoning") {
    return [{ type: "reasoning.delta", index, text: readString(delta, "thinking", provider) }];
  }
  if (deltaType === "input_json_delta" && blockType === "tool_call") {
    const partialJson = readString(delta, "partial_json", provider);
    return [
      {
        type: "tool_call.arguments.delta",
        index,
        toolCallId: requireToolCallId(index, state, provider),
        partialJson,
      },
    ];
  }
  if (deltaType === "signature_delta" && blockType === "reasoning") {
    return [
      {
        type: "reasoning.signature.delta",
        index,
        signature: readString(delta, "signature", provider),
      },
    ];
  }
  throw providerProtocolError(
    provider,
    `delta type "${deltaType}" does not match content block ${index}.`,
  );
}

function onAnthropicContentStop(
  event: Record<string, unknown>,
  state: AnthropicStreamState,
  provider: string,
): CanonicalEvent[] {
  requireStarted(state, provider);
  const index = readNumber(event, "index", provider);
  const blockType = state.blocks.get(index);
  if (!blockType) {
    throw providerProtocolError(provider, `content block ${index} stopped before it started.`);
  }
  state.blocks.delete(index);
  if (blockType === "tool_call") {
    const toolCallId = requireToolCallId(index, state, provider);
    state.toolCallIds.delete(index);
    return [{ type: "tool_call.completed", index, toolCallId }];
  }
  return [{ type: "content.completed", index }];
}

function onAnthropicMessageDelta(
  event: Record<string, unknown>,
  state: AnthropicStreamState,
  provider: string,
): CanonicalEvent[] {
  requireStarted(state, provider);
  const delta = requireRecord(event["delta"], provider, "delta");
  if (typeof delta["stop_reason"] === "string") {
    state.finishReason = anthropicFinishReason(delta["stop_reason"]);
  }
  if (isRecord(event["usage"])) {
    const usage = event["usage"];
    state.usage.outputTokens = optionalNumber(usage["output_tokens"], state.usage.outputTokens);
    state.usage.inputTokens = optionalNumber(usage["input_tokens"], state.usage.inputTokens);
    state.usage.cachedInputTokens = optionalNumber(
      usage["cache_read_input_tokens"],
      state.usage.cachedInputTokens,
    );
  }
  return [{ type: "usage.updated", usage: { ...state.usage } }];
}

function requireRecord(value: unknown, provider: string, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw providerProtocolError(provider, `"${field}" must be an object.`);
  }
  return value;
}

function requireStarted(state: AnthropicStreamState, provider: string): void {
  if (!state.started) {
    throw providerProtocolError(provider, "content event received before message_start.");
  }
}

function optionalNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function anthropicFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "pause_turn":
    default:
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

function requireToolCallId(index: number, state: AnthropicStreamState, provider: string): string {
  const id = state.toolCallIds.get(index);
  if (!id) {
    throw providerProtocolError(provider, `tool call ${index} is missing its ID.`);
  }
  return id;
}
