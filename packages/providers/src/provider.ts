import type {
  CanonicalEvent,
  CanonicalRequest,
  CapabilitySet,
  HealthStatus,
  ModelDefinition,
  TokenEstimate,
} from "@vartma/canonical";

export interface ProviderAdapter {
  readonly name: string;

  models(signal?: AbortSignal): Promise<ModelDefinition[]>;

  capabilities(model: string): CapabilitySet;

  estimateTokens(request: CanonicalRequest, signal?: AbortSignal): Promise<TokenEstimate>;

  execute(
    model: string,
    request: CanonicalRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CanonicalEvent>;

  health(model: string, signal?: AbortSignal): Promise<HealthStatus>;
}

export const PROVIDER_ERROR_CODES = [
  "invalid_request",
  "authentication",
  "billing",
  "permission",
  "not_found",
  "conflict",
  "request_too_large",
  "rate_limit",
  "timeout",
  "cancelled",
  "overloaded",
  "upstream",
  "network",
  "protocol",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface ProviderErrorOptions extends ErrorOptions {
  statusCode?: number;
  providerRequestId?: string;
  upstreamCode?: string;
  retryAfterMs?: number;
}

export class ProviderError extends Error {
  public constructor(
    message: string,
    public readonly code: ProviderErrorCode,
    public readonly retryable: boolean,
    options: ProviderErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ProviderError";
    this.statusCode = options.statusCode;
    this.providerRequestId = options.providerRequestId;
    this.upstreamCode = options.upstreamCode;
    this.retryAfterMs = options.retryAfterMs;
  }

  public readonly statusCode: number | undefined;
  public readonly providerRequestId: string | undefined;
  public readonly upstreamCode: string | undefined;
  public readonly retryAfterMs: number | undefined;
}
