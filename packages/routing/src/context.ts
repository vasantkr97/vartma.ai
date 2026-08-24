import type { CanonicalContent, CanonicalMessage, CanonicalRequest } from "@vartma/canonical";
import { z } from "zod";

export interface ContextCompressionPolicy {
  enabled: boolean;
  triggerCharacters: number;
  targetCharacters: number;
  preserveRecentMessages: number;
}

export const defaultContextCompressionPolicy: ContextCompressionPolicy = {
  enabled: true,
  triggerCharacters: 240_000,
  targetCharacters: 160_000,
  preserveRecentMessages: 16,
};

export const contextCompressionPolicySchema = z
  .object({
    enabled: z.boolean().default(defaultContextCompressionPolicy.enabled),
    triggerCharacters: z
      .number()
      .int()
      .positive()
      .default(defaultContextCompressionPolicy.triggerCharacters),
    targetCharacters: z
      .number()
      .int()
      .positive()
      .default(defaultContextCompressionPolicy.targetCharacters),
    preserveRecentMessages: z
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(defaultContextCompressionPolicy.preserveRecentMessages),
  })
  .strict()
  .refine(
    (policy) => policy.targetCharacters < policy.triggerCharacters,
    "Context compression targetCharacters must be below triggerCharacters.",
  )
  .default(defaultContextCompressionPolicy);

export interface ContextCompressionReport {
  applied: boolean;
  originalCharacters: number;
  compressedCharacters: number;
  originalMessages: number;
  retainedMessages: number;
  omittedMessages: number;
  withinTarget: boolean;
  preservedReasons: Record<string, number>;
}

export interface ContextCompressionResult {
  request: CanonicalRequest;
  report: ContextCompressionReport;
}

const REQUIREMENT_PATTERN =
  /\b(?:must|requirement|acceptance criteria|do not|never|always|goal|constraint|approved|remaining|unresolved|todo|next step|decision|decided)\b/iu;
const FAILURE_PATTERN =
  /\b(?:fail|failed|failure|error|exception|traceback|assertion|timeout|rejected|cannot|unable)\b/iu;
const MUTATING_TOOL_PATTERN =
  /(?:write|edit|patch|create|delete|remove|move|rename|replace|commit|apply)/iu;

/**
 * Performs deterministic extractive compression. It never rewrites preserved content and never
 * removes system instructions, user requirements, known decisions/failures, file mutations, or
 * the configured recent tail.
 */
export function compressCanonicalContext(
  request: CanonicalRequest,
  policy: ContextCompressionPolicy,
): ContextCompressionResult {
  const originalCharacters = requestCharacters(request);
  if (!policy.enabled || originalCharacters < policy.triggerCharacters) {
    return unchanged(request, originalCharacters, policy.targetCharacters);
  }

  const retained = new Set<number>();
  const preservedReasons: Record<string, number> = {};
  const mutatingToolCalls = new Set<string>();
  const recentStart = Math.max(0, request.messages.length - policy.preserveRecentMessages);

  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") {
      preserve(retained, preservedReasons, index, "system");
    }
    if (message.role === "user" && index === firstMessageIndex(request.messages, "user")) {
      preserve(retained, preservedReasons, index, "initial_user_requirement");
    }
    if (index >= recentStart) {
      preserve(retained, preservedReasons, index, "recent_tail");
    }
    if (messageContainsPattern(message, REQUIREMENT_PATTERN)) {
      preserve(retained, preservedReasons, index, "requirement_or_decision");
    }
    if (messageContainsFailure(message)) {
      preserve(retained, preservedReasons, index, "failure_evidence");
    }
    for (const content of message.content) {
      if (content.type === "tool_call" && MUTATING_TOOL_PATTERN.test(content.name)) {
        mutatingToolCalls.add(content.id);
        preserve(retained, preservedReasons, index, "file_mutation");
      }
    }
  }

  for (const [index, message] of request.messages.entries()) {
    if (
      message.content.some(
        (content) => content.type === "tool_result" && mutatingToolCalls.has(content.toolCallId),
      )
    ) {
      preserve(retained, preservedReasons, index, "file_mutation_result");
    }
  }

  const omitted = request.messages
    .map((message, index) => ({ message, index }))
    .filter(({ index }) => !retained.has(index));
  if (omitted.length === 0) {
    return unchanged(request, originalCharacters, policy.targetCharacters);
  }

  const summary = omittedSummary(omitted.map(({ message }) => message));
  const firstOmitted = omitted[0]!.index;
  const messages: CanonicalMessage[] = [];
  for (const [index, message] of request.messages.entries()) {
    if (index === firstOmitted) {
      messages.push({ role: "system", content: [{ type: "text", text: summary }] });
    }
    if (retained.has(index)) {
      messages.push(message);
    }
  }

  const compressedRequest: CanonicalRequest = {
    ...request,
    messages,
    metadata: {
      ...request.metadata,
      context_compressed: "true",
      context_original_messages: String(request.messages.length),
      context_omitted_messages: String(omitted.length),
    },
  };
  const compressedCharacters = requestCharacters(compressedRequest);
  return {
    request: compressedRequest,
    report: {
      applied: true,
      originalCharacters,
      compressedCharacters,
      originalMessages: request.messages.length,
      retainedMessages: messages.length,
      omittedMessages: omitted.length,
      withinTarget: compressedCharacters <= policy.targetCharacters,
      preservedReasons,
    },
  };
}

function unchanged(
  request: CanonicalRequest,
  characters: number,
  targetCharacters: number,
): ContextCompressionResult {
  return {
    request,
    report: {
      applied: false,
      originalCharacters: characters,
      compressedCharacters: characters,
      originalMessages: request.messages.length,
      retainedMessages: request.messages.length,
      omittedMessages: 0,
      withinTarget: characters <= targetCharacters,
      preservedReasons: {},
    },
  };
}

function preserve(
  retained: Set<number>,
  reasons: Record<string, number>,
  index: number,
  reason: string,
): void {
  if (!retained.has(index)) {
    retained.add(index);
  }
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

function firstMessageIndex(messages: CanonicalMessage[], role: CanonicalMessage["role"]): number {
  return messages.findIndex((message) => message.role === role);
}

function messageContainsPattern(message: CanonicalMessage, pattern: RegExp): boolean {
  return message.content.some((content) =>
    textFromContent(content).some((text) => pattern.test(text)),
  );
}

function messageContainsFailure(message: CanonicalMessage): boolean {
  return message.content.some(
    (content) =>
      content.type === "tool_result" &&
      (content.isError || textFromContent(content).some((text) => FAILURE_PATTERN.test(text))),
  );
}

function textFromContent(content: CanonicalContent): string[] {
  switch (content.type) {
    case "text":
    case "reasoning":
      return [content.text];
    case "tool_result":
      return typeof content.content === "string"
        ? [content.content]
        : content.content.flatMap(textFromContent);
    case "tool_call":
      return [content.name];
    case "image":
      return [];
  }
}

function omittedSummary(messages: CanonicalMessage[]): string {
  const toolCalls = new Map<string, number>();
  let toolResults = 0;
  for (const message of messages) {
    for (const content of message.content) {
      if (content.type === "tool_call") {
        toolCalls.set(content.name, (toolCalls.get(content.name) ?? 0) + 1);
      } else if (content.type === "tool_result") {
        toolResults += 1;
      }
    }
  }
  const calls = [...toolCalls.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}:${String(count)}`)
    .join(", ");
  return (
    "[Vartma context compression]\n" +
    `${String(messages.length)} older low-value operational messages were omitted. ` +
    `Omitted tool results: ${String(toolResults)}. ` +
    `Omitted tool calls: ${calls || "none"}. ` +
    "System instructions, user requirements, decisions, failure evidence, file-changing operations, and recent messages remain verbatim."
  );
}

function requestCharacters(request: CanonicalRequest): number {
  return JSON.stringify({
    messages: request.messages,
    tools: request.tools,
    responseFormat: request.responseFormat,
  }).length;
}
