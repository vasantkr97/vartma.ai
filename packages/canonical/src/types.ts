export const ROUTING_MODES = ["quality", "balanced", "eco", "fixed"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export type ModelCapability =
  "text" | "vision" | "streaming" | "tools" | "structuredOutput" | "reasoning";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: { type: "url"; url: string } | { type: "base64"; mediaType: string; data: string };
}

export interface ToolCallContent {
  type: "tool_call";
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResultContent {
  type: "tool_result";
  toolCallId: string;
  content: string | CanonicalContent[];
  isError: boolean;
}

export interface ReasoningContent {
  type: "reasoning";
  text: string;
  providerOpaqueData?: string;
}

export type CanonicalContent =
  TextContent | ImageContent | ToolCallContent | ToolResultContent | ReasoningContent;

export interface CanonicalMessage {
  role: MessageRole;
  content: CanonicalContent[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type ToolChoice =
  { type: "auto" } | { type: "any" } | { type: "none" } | { type: "tool"; name: string };

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name: string; schema: Record<string, unknown> };

export interface RoutingConstraints {
  requiredCapabilities: ModelCapability[];
  forcedProvider?: string;
  forcedModel?: string;
  allowedProviders?: string[];
  deniedProviders?: string[];
  allowedModels?: string[];
  deniedModels?: string[];
  maxEstimatedCostUsd?: number;
  maxLatencyMs?: number;
  requiredRegion?: string;
}

export interface CanonicalRequest {
  requestId: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  turnId?: string;
  messages: CanonicalMessage[];
  tools: ToolDefinition[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  requestedModel?: string;
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  routingMode: RoutingMode;
  constraints: RoutingConstraints;
  metadata: Record<string, string>;
  protocolPassthrough?: {
    protocol: "anthropic_messages" | "openai_responses" | "openai_chat_completions";
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export type FinishReason =
  | "end_turn"
  | "max_tokens"
  | "tool_use"
  | "stop_sequence"
  | "content_filter"
  | "cancelled"
  | "error";

export interface ResponseStartedEvent {
  type: "response.started";
  responseId: string;
  provider: string;
  model: string;
  inputTokens: number;
}

export interface ContentStartedEvent {
  type: "content.started";
  index: number;
  contentType: "text" | "reasoning";
  reasoningKind?: "signed_thinking" | "summary";
}

export interface TextDeltaEvent {
  type: "text.delta";
  index: number;
  text: string;
}

export interface ReasoningDeltaEvent {
  type: "reasoning.delta";
  index: number;
  text: string;
}

export interface ReasoningSignatureDeltaEvent {
  type: "reasoning.signature.delta";
  index: number;
  signature: string;
}

export interface ToolCallStartedEvent {
  type: "tool_call.started";
  index: number;
  toolCallId: string;
  name: string;
}

export interface ToolCallArgumentsDeltaEvent {
  type: "tool_call.arguments.delta";
  index: number;
  toolCallId: string;
  partialJson: string;
}

export interface ToolCallCompletedEvent {
  type: "tool_call.completed";
  index: number;
  toolCallId: string;
}

export interface ContentCompletedEvent {
  type: "content.completed";
  index: number;
}

export interface UsageUpdatedEvent {
  type: "usage.updated";
  usage: TokenUsage;
}

export interface ResponseCompletedEvent {
  type: "response.completed";
  finishReason: FinishReason;
  usage: TokenUsage;
}

export interface ResponseFailedEvent {
  type: "response.failed";
  errorType: string;
  message: string;
  retryable: boolean;
}

export type CanonicalEvent =
  | ResponseStartedEvent
  | ContentStartedEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ReasoningSignatureDeltaEvent
  | ToolCallStartedEvent
  | ToolCallArgumentsDeltaEvent
  | ToolCallCompletedEvent
  | ContentCompletedEvent
  | UsageUpdatedEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent;

export interface CapabilitySet {
  text: boolean;
  vision: boolean;
  streaming: boolean;
  tools: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
}

export interface ModelPricing {
  currency: "USD";
  effectiveFrom: string;
  verifiedAt: string;
  source: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  reasoningPerMillion?: number | undefined;
}

export interface ModelDefinition {
  id: string;
  provider: string;
  upstreamModel: string;
  enabled: boolean;
  capabilities: CapabilitySet;
  contextWindow: number;
  maxOutputTokens: number;
  qualityTier: number;
  expectedLatencyTier: number;
  expectedLatencyMs?: number | undefined;
  regions?: string[] | undefined;
  pricing: ModelPricing;
}

export interface TokenEstimate {
  inputTokens: number;
  expectedOutputTokens: number;
}

export interface HealthStatus {
  healthy: boolean;
  observedAt: string;
  latencyMs?: number;
  reason?: string;
}
