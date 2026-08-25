import type {
  CanonicalContent,
  CanonicalRequest,
  CapabilitySet,
  HealthStatus,
  ModelDefinition,
  TokenEstimate,
} from "@vartma/canonical";

import { ProviderError, type ProviderErrorCode } from "./provider.js";

export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

export interface HttpProviderOptions {
  name: string;
  apiKey?: string;
  authentication?: "bearer" | "none";
  models: ModelDefinition[];
  baseUrl: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
  fetchImplementation?: typeof fetch;
  sleepImplementation?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface ResolvedHttpProviderOptions {
  name: string;
  apiKey: string;
  authentication: "bearer" | "none";
  models: ModelDefinition[];
  baseUrl: string;
  requestTimeoutMs: number;
  maxRetries: number;
  fetchImplementation: typeof fetch;
  sleepImplementation: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface RequestSseOptions {
  provider: string;
  url: string;
  apiKey: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  maxRetries: number;
  fetchImplementation: typeof fetch;
  sleepImplementation: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface ErrorBody {
  message?: string;
  code?: string;
  type?: string;
}

const retryableStatuses = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const defaultMaximumSseEventCharacters = 16 * 1024 * 1024;

export function resolveHttpProviderOptions(
  options: HttpProviderOptions,
): ResolvedHttpProviderOptions {
  if (!options.name.trim()) {
    throw new Error("Provider name must not be empty.");
  }
  const authentication = options.authentication ?? "bearer";
  if (authentication === "bearer" && !options.apiKey?.trim()) {
    throw new Error(`Provider "${options.name}" requires a non-empty API key.`);
  }
  if (options.models.length === 0) {
    throw new Error(`Provider "${options.name}" requires at least one configured model.`);
  }

  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(`Provider "${options.name}" requires a base URL.`);
  }

  return {
    name: options.name,
    apiKey: options.apiKey?.trim() ?? "",
    authentication,
    models: options.models.map((model) => ({ ...model })),
    baseUrl,
    requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
    maxRetries: options.maxRetries ?? 2,
    fetchImplementation: options.fetchImplementation ?? fetch,
    sleepImplementation: options.sleepImplementation ?? abortableSleep,
  };
}

export function configuredModels(options: ResolvedHttpProviderOptions): Promise<ModelDefinition[]> {
  return Promise.resolve(options.models.map((model) => ({ ...model })));
}

export function modelCapabilities(
  options: ResolvedHttpProviderOptions,
  model: string,
): CapabilitySet {
  return requireConfiguredModel(options, model).capabilities;
}

export function configuredHealth(
  options: ResolvedHttpProviderOptions,
  model: string,
  signal?: AbortSignal,
): Promise<HealthStatus> {
  signal?.throwIfAborted();
  requireConfiguredModel(options, model);
  return Promise.resolve({
    healthy: true,
    observedAt: new Date().toISOString(),
    latencyMs: 0,
    reason: "Provider credentials and model configuration are present; active probes are deferred.",
  });
}

export function estimateCanonicalTokens(request: CanonicalRequest): TokenEstimate {
  const messageCharacters = request.messages.reduce(
    (sum, message) =>
      sum + message.content.reduce((contentSum, block) => contentSum + contentCharacters(block), 0),
    0,
  );
  const toolCharacters = request.tools.reduce(
    (sum, tool) =>
      sum +
      tool.name.length +
      (tool.description?.length ?? 0) +
      JSON.stringify(tool.inputSchema).length,
    0,
  );

  return {
    inputTokens: Math.max(1, Math.ceil((messageCharacters + toolCharacters) / 4)),
    expectedOutputTokens: Math.min(request.maxOutputTokens, 512),
  };
}

export function createExecutionSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const timeoutController = new AbortController();
  let timeoutTriggered = false;
  const timeout = setTimeout(() => {
    timeoutTriggered = true;
    timeoutController.abort(new DOMException("Provider request timed out.", "TimeoutError"));
  }, timeoutMs);
  timeout.unref?.();

  const signals = callerSignal
    ? [callerSignal, timeoutController.signal]
    : [timeoutController.signal];
  return {
    signal: AbortSignal.any(signals),
    timedOut: () => timeoutTriggered,
    dispose: () => clearTimeout(timeout),
  };
}

export async function requestSse(options: RequestSseOptions): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    options.signal.throwIfAborted();
    let response: Response;

    try {
      response = await options.fetchImplementation(options.url, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          ...options.headers,
        },
        body: JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal.aborted) {
        throw error;
      }
      if (attempt < options.maxRetries) {
        await options.sleepImplementation(retryDelay(attempt), options.signal);
        continue;
      }
      throw new ProviderError(`${options.provider} could not be reached.`, "network", true, {
        cause: error,
      });
    }

    if (response.ok) {
      if (!response.body) {
        const requestId = providerRequestId(response);
        throw new ProviderError(
          `${options.provider} returned an empty streaming response.`,
          "protocol",
          false,
          {
            statusCode: response.status,
            ...(requestId ? { providerRequestId: requestId } : {}),
          },
        );
      }
      return response;
    }

    const providerError = await providerHttpError(options.provider, response, options.apiKey);
    if (
      providerError.retryable &&
      retryableStatuses.has(response.status) &&
      attempt < options.maxRetries
    ) {
      await options.sleepImplementation(
        providerError.retryAfterMs ?? retryDelay(attempt),
        options.signal,
      );
      continue;
    }
    throw providerError;
  }
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  maximumEventCharacters = defaultMaximumSseEventCharacters,
): AsyncIterable<SseMessage> {
  if (!Number.isSafeInteger(maximumEventCharacters) || maximumEventCharacters <= 0) {
    throw new Error("Maximum SSE event characters must be a positive safe integer.");
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let boundary = findEventBoundary(buffer);
      while (boundary) {
        assertSseEventSize(boundary.index, maximumEventCharacters);
        const rawEvent = buffer.slice(0, boundary.index).replace(/\r\n?/g, "\n");
        buffer = buffer.slice(boundary.index + boundary.length);
        const message = parseSseMessage(rawEvent);
        if (message) {
          yield message;
        }
        boundary = findEventBoundary(buffer);
      }

      assertSseEventSize(buffer.length, maximumEventCharacters);

      if (done) {
        if (buffer.trim()) {
          const message = parseSseMessage(buffer.replace(/\r\n?/g, "\n"));
          if (message) {
            yield message;
          }
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function assertSseEventSize(characters: number, maximumEventCharacters: number): void {
  if (characters > maximumEventCharacters) {
    throw new ProviderError(
      `Provider event stream exceeded the ${String(maximumEventCharacters)} character event limit.`,
      "protocol",
      false,
    );
  }
}

export function parseJsonEvent(data: string, provider: string): Record<string, unknown> {
  try {
    const value = JSON.parse(data) as unknown;
    if (!isRecord(value)) {
      throw new Error("Event payload is not an object.");
    }
    return value;
  } catch (error) {
    throw new ProviderError(
      `${provider} returned malformed JSON in its event stream.`,
      "protocol",
      false,
      { cause: error },
    );
  }
}

export function providerProtocolError(provider: string, message: string): ProviderError {
  return new ProviderError(`${provider} protocol error: ${message}`, "protocol", false);
}

export function providerAbortError(
  provider: string,
  callerSignal: AbortSignal | undefined,
  timedOut: boolean,
  error: unknown,
): ProviderError {
  if (timedOut) {
    return new ProviderError(`${provider} request timed out.`, "timeout", true, { cause: error });
  }
  if (callerSignal?.aborted) {
    return new ProviderError(`${provider} request was cancelled.`, "cancelled", false, {
      cause: error,
    });
  }
  if (error instanceof ProviderError) {
    return error;
  }
  return new ProviderError(`${provider} stream failed.`, "network", true, { cause: error });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(record: Record<string, unknown>, key: string, provider: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw providerProtocolError(provider, `"${key}" must be a string.`);
  }
  return value;
}

export function readNumber(
  record: Record<string, unknown>,
  key: string,
  provider: string,
  fallback?: number,
): number {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (fallback !== undefined && value === undefined) {
    return fallback;
  }
  throw providerProtocolError(provider, `"${key}" must be a number.`);
}

function requireConfiguredModel(
  options: ResolvedHttpProviderOptions,
  model: string,
): ModelDefinition {
  const definition = options.models.find(
    (candidate) => candidate.upstreamModel === model || candidate.id === model,
  );
  if (!definition) {
    throw new ProviderError(
      `Model "${model}" is not configured for provider "${options.name}".`,
      "invalid_request",
      false,
    );
  }
  return definition;
}

function contentCharacters(content: CanonicalContent): number {
  switch (content.type) {
    case "text":
    case "reasoning":
      return content.text.length;
    case "image":
      return content.source.type === "url" ? content.source.url.length : content.source.data.length;
    case "tool_call":
      return content.name.length + JSON.stringify(content.arguments).length;
    case "tool_result":
      return typeof content.content === "string"
        ? content.content.length
        : content.content.reduce((sum, block) => sum + contentCharacters(block), 0);
  }
}

function parseSseMessage(rawEvent: string): SseMessage | undefined {
  let event: string | undefined;
  let id: string | undefined;
  const data: string[] = [];

  for (const line of rawEvent.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    } else if (field === "id") {
      id = value;
    }
  }

  if (data.length === 0) {
    return undefined;
  }
  return {
    ...(event ? { event } : {}),
    data: data.join("\n"),
    ...(id ? { id } : {}),
  };
}

async function providerHttpError(
  provider: string,
  response: Response,
  apiKey: string,
): Promise<ProviderError> {
  let errorBody: ErrorBody = {};
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      const nested = isRecord(body["error"]) ? body["error"] : body;
      errorBody = {
        ...(typeof nested["message"] === "string" ? { message: nested["message"] } : {}),
        ...(typeof nested["code"] === "string" ? { code: nested["code"] } : {}),
        ...(typeof nested["type"] === "string" ? { type: nested["type"] } : {}),
      };
    }
  } catch {
    // An upstream proxy may return HTML or an empty body. Status remains authoritative.
  }

  const code = statusErrorCode(response.status);
  const requestId = providerRequestId(response);
  const rawMessage =
    errorBody.message ?? `${provider} request failed with HTTP ${response.status}.`;
  const message = redactSecret(rawMessage, apiKey).slice(0, 1000);
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

  return new ProviderError(message, code, retryableStatuses.has(response.status), {
    statusCode: response.status,
    ...(requestId ? { providerRequestId: requestId } : {}),
    ...(errorBody.code || errorBody.type ? { upstreamCode: errorBody.code ?? errorBody.type } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function statusErrorCode(status: number): ProviderErrorCode {
  switch (status) {
    case 400:
    case 422:
      return "invalid_request";
    case 401:
      return "authentication";
    case 402:
      return "billing";
    case 403:
      return "permission";
    case 404:
      return "not_found";
    case 408:
      return "timeout";
    case 409:
      return "conflict";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limit";
    case 529:
      return "overloaded";
    default:
      return status >= 500 ? "upstream" : "invalid_request";
  }
}

function providerRequestId(response: Response): string | undefined {
  return (
    response.headers.get("request-id") ??
    response.headers.get("x-request-id") ??
    response.headers.get("openai-request-id") ??
    undefined
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function retryDelay(attempt: number): number {
  return Math.min(5000, 250 * 2 ** attempt);
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(
        signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timeout.unref?.();
  });
}

function redactSecret(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join("[REDACTED]") : message;
}

function findEventBoundary(buffer: string): { index: number; length: number } | undefined {
  const candidates = [
    { index: buffer.indexOf("\r\n\r\n"), length: 4 },
    { index: buffer.indexOf("\n\n"), length: 2 },
    { index: buffer.indexOf("\r\r"), length: 2 },
  ].filter((candidate) => candidate.index >= 0);
  return candidates.sort((left, right) => left.index - right.index)[0];
}
