import { randomUUID } from "node:crypto";

import type {
  CanonicalContent,
  CanonicalMessage,
  CanonicalRequest,
  RoutingMode,
} from "@vartma/canonical";

import type { OpenAIChatRequest } from "./chat-schema.js";

export function normalizeOpenAIChatRequest(
  input: OpenAIChatRequest,
  options: { requestId?: string; routingMode: RoutingMode; sessionId?: string },
): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  for (const message of input.messages) {
    if (message.role === "tool") {
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: message.tool_call_id,
            content: message.content,
            isError: false,
          },
        ],
      });
      continue;
    }
    const content: CanonicalContent[] =
      message.content == null
        ? []
        : typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content.map(normalizeContent);
    if (message.role === "assistant") {
      for (const toolCall of message.tool_calls ?? []) {
        content.push({
          type: "tool_call",
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments) as unknown,
        });
      }
    }
    messages.push({
      role: message.role === "developer" ? "system" : message.role,
      content,
    });
  }

  const requiredCapabilities: CanonicalRequest["constraints"]["requiredCapabilities"] = [];
  if (input.stream) {
    requiredCapabilities.push("streaming");
  }
  if (input.tools?.length) {
    requiredCapabilities.push("tools");
  }
  if (input.response_format && input.response_format.type !== "text") {
    requiredCapabilities.push("structuredOutput");
  }
  if (input.reasoning_effort) {
    requiredCapabilities.push("reasoning");
  }
  if (messages.some((message) => message.content.some(containsImage))) {
    requiredCapabilities.push("vision");
  }

  return {
    requestId: options.requestId ?? randomUUID(),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    messages,
    tools:
      input.tools?.map((tool) => ({
        name: tool.function.name,
        ...(tool.function.description ? { description: tool.function.description } : {}),
        inputSchema: tool.function.parameters,
      })) ?? [],
    ...(input.tool_choice
      ? {
          toolChoice:
            typeof input.tool_choice === "string"
              ? {
                  type: input.tool_choice === "required" ? ("any" as const) : input.tool_choice,
                }
              : { type: "tool" as const, name: input.tool_choice.function.name },
        }
      : {}),
    ...(input.response_format
      ? {
          responseFormat:
            input.response_format.type === "json_schema"
              ? {
                  type: "json_schema" as const,
                  name: input.response_format.json_schema.name,
                  schema: input.response_format.json_schema.schema,
                }
              : { type: input.response_format.type },
        }
      : {}),
    requestedModel: input.model,
    maxOutputTokens: input.max_completion_tokens ?? input.max_tokens ?? 4096,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.top_p === undefined ? {} : { topP: input.top_p }),
    ...(input.stop
      ? { stopSequences: typeof input.stop === "string" ? [input.stop] : input.stop }
      : {}),
    routingMode: options.routingMode,
    constraints: { requiredCapabilities },
    metadata: primitiveMetadata(input.metadata),
    protocolPassthrough: {
      protocol: "openai_chat_completions",
      headers: {},
      body: input,
    },
  };
}

function normalizeContent(
  block: { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } },
): CanonicalContent {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  const data = parseDataUrl(block.image_url.url);
  return data
    ? { type: "image", source: { type: "base64", mediaType: data.mediaType, data: data.data } }
    : { type: "image", source: { type: "url", url: block.image_url.url } };
}

function containsImage(block: CanonicalContent): boolean {
  return block.type === "image";
}

function primitiveMetadata(metadata: Record<string, unknown> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).flatMap(([key, value]) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? [[key, String(value)]]
        : [],
    ),
  );
}

function parseDataUrl(value: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  return match?.[1] && match[2] ? { mediaType: match[1], data: match[2] } : undefined;
}
