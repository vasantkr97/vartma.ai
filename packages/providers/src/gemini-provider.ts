import { randomUUID } from "node:crypto";

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

export interface GeminiProviderOptions extends Omit<HttpProviderOptions, "baseUrl"> {
  baseUrl?: string;
}

interface GeminiStreamState {
  started: boolean;
  responseId: string;
  model: string;
  nextBlockIndex: number;
  textIndex?: number;
  reasoningIndex?: number;
  toolCalls: number;
  finishReason?: FinishReason;
  usage: TokenUsage;
}

export class GeminiProvider implements ProviderAdapter {
  public readonly name: string;
  private readonly options: ResolvedHttpProviderOptions;

  public constructor(options: GeminiProviderOptions) {
    this.options = resolveHttpProviderOptions({
      ...options,
      baseUrl: options.baseUrl ?? "https://generativelanguage.googleapis.com",
    });
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
      const modelPath = model.replace(/^models\//, "");
      const response = await requestSse({
        provider: this.name,
        url: `${this.options.baseUrl}/v1beta/models/${encodeURIComponent(modelPath)}:streamGenerateContent?alt=sse`,
        apiKey: this.options.apiKey,
        headers: { "x-goog-api-key": this.options.apiKey },
        body: toGeminiRequest(request, model),
        signal: execution.signal,
        maxRetries: this.options.maxRetries,
        fetchImplementation: this.options.fetchImplementation,
        sleepImplementation: this.options.sleepImplementation,
      });
      const state: GeminiStreamState = {
        started: false,
        responseId: `gemini_${randomUUID()}`,
        model,
        nextBlockIndex: 0,
        toolCalls: 0,
        usage: emptyUsage(),
      };
      for await (const message of parseSse(response.body!)) {
        execution.signal.throwIfAborted();
        if (message.data === "[DONE]") {
          continue;
        }
        const chunk = parseJsonEvent(message.data, this.name);
        for (const event of translateGeminiChunk(chunk, state, this.name)) {
          yield event;
        }
      }
      if (!state.started) {
        throw providerProtocolError(this.name, "stream ended before a response chunk.");
      }
      if (state.finishReason === undefined) {
        throw providerProtocolError(this.name, "stream ended without a candidate finish reason.");
      }
      yield* completeGeminiStream(state);
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

export function toGeminiRequest(
  request: CanonicalRequest,
  model?: string,
): Record<string, unknown> {
  const systemParts: Array<{ text: string }> = [];
  const contents: unknown[] = [];
  const toolNames = new Map<string, string>();
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === "tool_call") {
        toolNames.set(block.id, block.name);
      }
    }
  }

  for (const message of request.messages) {
    if (message.role === "system") {
      for (const block of message.content) {
        if (block.type === "text") {
          systemParts.push({ text: block.text });
        }
      }
      continue;
    }
    const parts: unknown[] = [];
    let pendingThoughtSignature: string | undefined;
    for (const block of message.content) {
      if (block.type === "reasoning") {
        const signature = reasoningSignature(block.providerOpaqueData);
        if (signature) {
          pendingThoughtSignature = signature;
        }
        if (block.text) {
          parts.push({
            text: block.text,
            thought: true,
            ...(signature ? { thoughtSignature: signature } : {}),
          });
        }
      } else if (block.type === "tool_call") {
        parts.push({
          functionCall: {
            id: block.id,
            name: block.name,
            args: block.arguments,
          },
          ...(pendingThoughtSignature ? { thoughtSignature: pendingThoughtSignature } : {}),
        });
        pendingThoughtSignature = undefined;
      } else if (block.type === "tool_result") {
        parts.push({
          functionResponse: {
            id: block.toolCallId,
            name: toolNames.get(block.toolCallId) ?? "tool",
            response: {
              output: geminiToolOutput(block.content),
              isError: block.isError,
            },
          },
        });
      } else {
        const part = geminiContent(block);
        if (part) {
          parts.push(part);
        }
      }
    }
    if (parts.length) {
      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts,
      });
    }
  }

  return {
    contents,
    ...(systemParts.length ? { systemInstruction: { role: "user", parts: systemParts } } : {}),
    generationConfig: {
      maxOutputTokens: request.maxOutputTokens,
      ...(request.temperature === undefined || /^models\/gemini-3|^gemini-3/.test(model ?? "")
        ? {}
        : { temperature: request.temperature }),
      ...(request.topP === undefined || /^models\/gemini-3|^gemini-3/.test(model ?? "")
        ? {}
        : { topP: request.topP }),
      ...(request.stopSequences ? { stopSequences: request.stopSequences } : {}),
      ...(request.responseFormat?.type === "json_object"
        ? { responseMimeType: "application/json" }
        : request.responseFormat?.type === "json_schema"
          ? {
              responseMimeType: "application/json",
              responseJsonSchema: request.responseFormat.schema,
            }
          : {}),
    },
    ...(request.tools.length
      ? {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                ...(tool.description ? { description: tool.description } : {}),
                parameters: tool.inputSchema,
              })),
            },
          ],
        }
      : {}),
    ...(request.toolChoice
      ? { toolConfig: { functionCallingConfig: geminiToolChoice(request.toolChoice) } }
      : {}),
  };
}

function translateGeminiChunk(
  chunk: Record<string, unknown>,
  state: GeminiStreamState,
  provider: string,
): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  if (!state.started) {
    state.started = true;
    const responseId =
      typeof chunk["responseId"] === "string" ? chunk["responseId"] : state.responseId;
    const model = typeof chunk["modelVersion"] === "string" ? chunk["modelVersion"] : state.model;
    state.responseId = responseId;
    state.model = model;
    const usage = readGeminiUsage(chunk["usageMetadata"]);
    if (usage) {
      state.usage = usage;
    }
    events.push({
      type: "response.started",
      responseId,
      provider,
      model,
      inputTokens: state.usage.inputTokens,
    });
  }
  const usage = readGeminiUsage(chunk["usageMetadata"]);
  if (usage) {
    state.usage = usage;
  }
  const candidates = Array.isArray(chunk["candidates"]) ? chunk["candidates"] : [];
  for (const candidateValue of candidates) {
    if (!isRecord(candidateValue)) {
      continue;
    }
    const content = isRecord(candidateValue["content"]) ? candidateValue["content"] : {};
    const parts = Array.isArray(content["parts"]) ? content["parts"] : [];
    for (const partValue of parts) {
      if (!isRecord(partValue)) {
        continue;
      }
      const text = partValue["text"];
      const isThought = partValue["thought"] === true;
      const thoughtSignature =
        typeof partValue["thoughtSignature"] === "string"
          ? partValue["thoughtSignature"]
          : undefined;
      if ((typeof text === "string" && text) || thoughtSignature) {
        if (isThought || thoughtSignature) {
          if (state.reasoningIndex === undefined) {
            state.reasoningIndex = state.nextBlockIndex++;
            events.push({
              type: "content.started",
              index: state.reasoningIndex,
              contentType: "reasoning",
              reasoningKind: thoughtSignature ? "signed_thinking" : "summary",
            });
          }
          if (typeof text === "string" && text) {
            events.push({
              type: "reasoning.delta",
              index: state.reasoningIndex,
              text,
            });
          }
          if (thoughtSignature) {
            events.push({
              type: "reasoning.signature.delta",
              index: state.reasoningIndex,
              signature: thoughtSignature,
            });
          }
        } else if (typeof text === "string") {
          if (state.textIndex === undefined) {
            state.textIndex = state.nextBlockIndex++;
            events.push({
              type: "content.started",
              index: state.textIndex,
              contentType: "text",
            });
          }
          events.push({ type: "text.delta", index: state.textIndex, text });
        }
      }
      const functionCall = isRecord(partValue["functionCall"])
        ? partValue["functionCall"]
        : undefined;
      if (functionCall) {
        const callId =
          typeof functionCall["id"] === "string"
            ? functionCall["id"]
            : `gemini_call_${state.toolCalls}`;
        const name = functionCall["name"];
        if (typeof name !== "string") {
          throw providerProtocolError(provider, "functionCall.name must be a string.");
        }
        const index = state.nextBlockIndex++;
        state.toolCalls += 1;
        events.push(
          {
            type: "tool_call.started",
            index,
            toolCallId: callId,
            name,
          },
          {
            type: "tool_call.arguments.delta",
            index,
            toolCallId: callId,
            partialJson: JSON.stringify(functionCall["args"] ?? {}),
          },
          {
            type: "tool_call.completed",
            index,
            toolCallId: callId,
          },
        );
      }
    }
    if (typeof candidateValue["finishReason"] === "string") {
      state.finishReason = geminiFinishReason(candidateValue["finishReason"]);
    }
  }
  if (
    candidates.length === 0 &&
    isRecord(chunk["promptFeedback"]) &&
    typeof chunk["promptFeedback"]["blockReason"] === "string"
  ) {
    state.finishReason = "content_filter";
  }
  return events;
}

function* completeGeminiStream(state: GeminiStreamState): Iterable<CanonicalEvent> {
  if (state.reasoningIndex !== undefined) {
    yield { type: "content.completed", index: state.reasoningIndex };
  }
  if (state.textIndex !== undefined) {
    yield { type: "content.completed", index: state.textIndex };
  }
  yield { type: "usage.updated", usage: state.usage };
  yield {
    type: "response.completed",
    finishReason:
      state.toolCalls > 0 && state.finishReason === "end_turn"
        ? "tool_use"
        : (state.finishReason ?? "end_turn"),
    usage: state.usage,
  };
}

function geminiContent(block: CanonicalContent): unknown {
  switch (block.type) {
    case "text":
      return { text: block.text };
    case "image":
      return block.source.type === "base64"
        ? {
            inlineData: {
              mimeType: block.source.mediaType,
              data: block.source.data,
            },
          }
        : { fileData: { fileUri: block.source.url } };
    case "reasoning":
    case "tool_call":
    case "tool_result":
      return undefined;
  }
}

function geminiToolOutput(content: string | CanonicalContent[]): unknown {
  if (typeof content === "string") {
    return content;
  }
  return content.flatMap((block) => {
    const converted = geminiContent(block);
    return converted ? [converted] : [];
  });
}

function geminiToolChoice(
  choice: NonNullable<CanonicalRequest["toolChoice"]>,
): Record<string, unknown> {
  switch (choice.type) {
    case "auto":
      return { mode: "AUTO" };
    case "none":
      return { mode: "NONE" };
    case "any":
      return { mode: "ANY" };
    case "tool":
      return { mode: "ANY", allowedFunctionNames: [choice.name] };
  }
}

function readGeminiUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const prompt = numberOrZero(value["promptTokenCount"]);
  const cached = numberOrZero(value["cachedContentTokenCount"]);
  return {
    inputTokens: Math.max(0, prompt - cached),
    cachedInputTokens: cached,
    outputTokens: numberOrZero(value["candidatesTokenCount"]),
    reasoningTokens: numberOrZero(value["thoughtsTokenCount"]),
  };
}

function geminiFinishReason(value: string): FinishReason {
  switch (value) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    case "MALFORMED_FUNCTION_CALL":
    case "UNEXPECTED_TOOL_CALL":
      return "error";
    case "STOP":
    default:
      return "end_turn";
  }
}

function reasoningSignature(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) && typeof parsed["signature"] === "string"
      ? parsed["signature"]
      : undefined;
  } catch {
    return undefined;
  }
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
