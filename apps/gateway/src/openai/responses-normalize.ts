import { randomUUID } from "node:crypto";

import type {
  CanonicalContent,
  CanonicalMessage,
  CanonicalRequest,
  RoutingMode,
} from "@vartma/canonical";

import type { OpenAIResponsesRequest } from "./responses-schema.js";

export interface NormalizeOpenAIOptions {
  requestId?: string;
  routingMode: RoutingMode;
  sessionId?: string;
}

export function normalizeOpenAIResponseRequest(
  input: OpenAIResponsesRequest,
  options: NormalizeOpenAIOptions,
): CanonicalRequest {
  const messages: CanonicalMessage[] = [];
  if (input.instructions) {
    messages.push({
      role: "system",
      content: [{ type: "text", text: input.instructions }],
    });
  }
  if (typeof input.input === "string") {
    messages.push({ role: "user", content: [{ type: "text", text: input.input }] });
  } else {
    for (const item of input.input) {
      if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: item.call_id,
              name: item.name,
              arguments: JSON.parse(item.arguments) as unknown,
            },
          ],
        });
      } else if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: item.call_id,
              content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
              isError: false,
            },
          ],
        });
      } else if (item.type === "reasoning") {
        continue;
      } else {
        messages.push({
          role: item.role === "developer" ? "system" : item.role,
          content:
            typeof item.content === "string"
              ? [{ type: "text", text: item.content }]
              : item.content.map(normalizeInputContent),
        });
      }
    }
  }

  const requiredCapabilities: CanonicalRequest["constraints"]["requiredCapabilities"] = [];
  if (input.stream) {
    requiredCapabilities.push("streaming");
  }
  if (input.tools?.length) {
    requiredCapabilities.push("tools");
  }
  if (input.text?.format && input.text.format.type !== "text") {
    requiredCapabilities.push("structuredOutput");
  }
  if (input.reasoning) {
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
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.parameters,
      })) ?? [],
    ...(input.tool_choice
      ? {
          toolChoice:
            typeof input.tool_choice === "string"
              ? {
                  type: input.tool_choice === "required" ? ("any" as const) : input.tool_choice,
                }
              : { type: "tool" as const, name: input.tool_choice.name },
        }
      : {}),
    ...(input.text?.format
      ? {
          responseFormat:
            input.text.format.type === "json_schema"
              ? {
                  type: "json_schema" as const,
                  name: input.text.format.name,
                  schema: input.text.format.schema,
                }
              : { type: input.text.format.type },
        }
      : {}),
    requestedModel: input.model,
    maxOutputTokens: input.max_output_tokens,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.top_p === undefined ? {} : { topP: input.top_p }),
    routingMode: options.routingMode,
    constraints: { requiredCapabilities },
    metadata: primitiveMetadata(input.metadata),
    protocolPassthrough: {
      protocol: "openai_responses",
      headers: {},
      body: input,
    },
  };
}

function normalizeInputContent(
  block:
    | { type: "input_text" | "output_text" | "text"; text: string }
    | { type: "input_image"; image_url: string },
): CanonicalContent {
  if (block.type !== "input_image") {
    return { type: "text", text: block.text };
  }
  const data = parseDataUrl(block.image_url);
  return data
    ? { type: "image", source: { type: "base64", mediaType: data.mediaType, data: data.data } }
    : { type: "image", source: { type: "url", url: block.image_url } };
}

function containsImage(block: CanonicalContent): boolean {
  return (
    block.type === "image" ||
    (block.type === "tool_result" &&
      Array.isArray(block.content) &&
      block.content.some(containsImage))
  );
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
