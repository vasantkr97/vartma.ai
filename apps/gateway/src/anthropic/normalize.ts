import { randomUUID } from "node:crypto";

import type {
  CanonicalContent,
  CanonicalMessage,
  CanonicalRequest,
  ModelCapability,
  RoutingMode,
  ToolChoice,
} from "@vartma/canonical";

import type { AnthropicContentBlock, AnthropicMessagesRequest } from "./schema.js";

export interface NormalizeOptions {
  requestId?: string;
  routingMode: RoutingMode;
  sessionId?: string;
}

export function normalizeAnthropicRequest(
  request: AnthropicMessagesRequest,
  options: NormalizeOptions,
): CanonicalRequest {
  const messages: CanonicalMessage[] = [];

  if (request.system) {
    const content =
      typeof request.system === "string"
        ? [{ type: "text" as const, text: request.system }]
        : request.system.map((block) => ({ type: "text" as const, text: block.text }));
    messages.push({ role: "system", content });
  }

  for (const message of request.messages) {
    messages.push({
      role: message.role,
      content:
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content.map(normalizeContentBlock),
    });
  }

  const metadata = Object.fromEntries(
    Object.entries(request.metadata ?? {}).flatMap(([key, value]) => {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return [[key, String(value)]];
      }
      return [];
    }),
  );
  const requiredCapabilities: ModelCapability[] = [];
  if (request.tools?.length) {
    requiredCapabilities.push("tools");
  }
  if (request.stream) {
    requiredCapabilities.push("streaming");
  }
  if (messages.some((message) => message.content.some(containsImage))) {
    requiredCapabilities.push("vision");
  }
  if (request.thinking && request.thinking.type !== "disabled") {
    requiredCapabilities.push("reasoning");
  }

  return {
    requestId: options.requestId ?? randomUUID(),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    messages,
    tools:
      request.tools?.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.input_schema,
      })) ?? [],
    ...(request.tool_choice ? { toolChoice: normalizeToolChoice(request.tool_choice) } : {}),
    requestedModel: request.model,
    maxOutputTokens: request.max_tokens,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { topP: request.top_p }),
    ...(request.stop_sequences ? { stopSequences: request.stop_sequences } : {}),
    routingMode: options.routingMode,
    constraints: {
      requiredCapabilities,
    },
    metadata,
    protocolPassthrough: {
      protocol: "anthropic_messages",
      headers: {},
      body: request,
    },
  };
}

function containsImage(content: CanonicalContent): boolean {
  if (content.type === "image") {
    return true;
  }
  return (
    content.type === "tool_result" &&
    Array.isArray(content.content) &&
    content.content.some(containsImage)
  );
}

function normalizeContentBlock(block: AnthropicContentBlock): CanonicalContent {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return block.source.type === "url"
        ? { type: "image", source: { type: "url", url: block.source.url } }
        : {
            type: "image",
            source: {
              type: "base64",
              mediaType: block.source.media_type,
              data: block.source.data,
            },
          };
    case "tool_use":
      return {
        type: "tool_call",
        id: block.id,
        name: block.name,
        arguments: block.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolCallId: block.tool_use_id,
        content:
          typeof block.content === "string"
            ? block.content
            : block.content.map((content) =>
                content.type === "text"
                  ? { type: "text" as const, text: content.text }
                  : content.source.type === "url"
                    ? {
                        type: "image" as const,
                        source: { type: "url" as const, url: content.source.url },
                      }
                    : {
                        type: "image" as const,
                        source: {
                          type: "base64" as const,
                          mediaType: content.source.media_type,
                          data: content.source.data,
                        },
                      },
              ),
        isError: block.is_error ?? false,
      };
    case "thinking":
      return {
        type: "reasoning",
        text: block.thinking,
        providerOpaqueData: JSON.stringify(block),
      };
    case "redacted_thinking":
      return {
        type: "reasoning",
        text: "",
        providerOpaqueData: JSON.stringify(block),
      };
  }
}

function normalizeToolChoice(
  choice: NonNullable<AnthropicMessagesRequest["tool_choice"]>,
): ToolChoice {
  if (choice.type === "tool") {
    return { type: "tool", name: choice.name };
  }
  return { type: choice.type };
}
