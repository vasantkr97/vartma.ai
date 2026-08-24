import { createHash } from "node:crypto";

import type { CanonicalContent, CanonicalRequest } from "@vartma/canonical";

export type ProgressStatus = "progressing" | "uncertain" | "stuck";

export interface ProgressAssessment {
  status: ProgressStatus;
  confidence: number;
  toolCalls: number;
  toolErrors: number;
  testFailures: number;
  repeatedToolCalls: number;
  repeatedFailureOutputs: number;
  reasons: string[];
  fingerprint?: string;
}

const FAILURE_PATTERN =
  /(?:\b(?:fail|failed|failure|assertionerror|test(?:s)? failed|failed test|npm err!|traceback|exception|command failed|compilation failed|typecheck failed)\b|\berror\s+ts\d+\b|\b\d+\s+(?:tests?\s+)?failed\b)/iu;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

/**
 * Derives progress telemetry from the portable transcript. Only counts and SHA-256
 * fingerprints leave this function; raw prompts, tool arguments, and tool output do not.
 */
export function analyzeProgress(request: CanonicalRequest): ProgressAssessment {
  const toolCallFingerprints: string[] = [];
  const failureFingerprints: string[] = [];
  let toolCalls = 0;
  let toolErrors = 0;
  let testFailures = 0;

  for (const message of request.messages) {
    for (const content of message.content) {
      if (content.type === "tool_call") {
        toolCalls += 1;
        toolCallFingerprints.push(
          fingerprint(`tool:${content.name}:${stableSerialize(content.arguments)}`),
        );
        continue;
      }
      if (content.type !== "tool_result") {
        continue;
      }
      const output = textFromToolResult(content);
      const failureLike = content.isError || FAILURE_PATTERN.test(output);
      if (content.isError) {
        toolErrors += 1;
      }
      if (FAILURE_PATTERN.test(output)) {
        testFailures += 1;
      }
      if (failureLike && output.trim()) {
        failureFingerprints.push(fingerprint(normalizeFailure(output)));
      }
    }
  }

  const repeatedToolCalls = maximumDuplicateCount(toolCallFingerprints);
  const repeatedFailureOutputs = maximumDuplicateCount(failureFingerprints);
  const reasons: string[] = [];

  if (repeatedFailureOutputs >= 2) {
    reasons.push("the same failure output appeared repeatedly");
  }
  if (repeatedToolCalls >= 3) {
    reasons.push("the same tool call and arguments were repeated without visible progress");
  }
  if (toolErrors >= 3) {
    reasons.push("the transcript contains at least three tool errors");
  }
  if (testFailures >= 3) {
    reasons.push("the transcript contains at least three failing test results");
  }

  const stuck = reasons.length > 0;
  const hasFailureEvidence = toolErrors > 0 || testFailures > 0 || failureFingerprints.length > 0;
  const status: ProgressStatus = stuck ? "stuck" : hasFailureEvidence ? "uncertain" : "progressing";
  const evidenceFingerprint = stuck
    ? fingerprint(
        [
          ...new Set(toolCallFingerprints),
          ...new Set(failureFingerprints),
          String(toolErrors),
          String(testFailures),
        ].join(":"),
      )
    : undefined;

  return {
    status,
    confidence: stuck
      ? Math.min(0.98, 0.72 + reasons.length * 0.07)
      : hasFailureEvidence
        ? 0.64
        : 0.6,
    toolCalls,
    toolErrors,
    testFailures,
    repeatedToolCalls,
    repeatedFailureOutputs,
    reasons,
    ...(evidenceFingerprint ? { fingerprint: evidenceFingerprint } : {}),
  };
}

function textFromToolResult(content: Extract<CanonicalContent, { type: "tool_result" }>): string {
  if (typeof content.content === "string") {
    return content.content;
  }
  return content.content.map(textFromContent).join("\n");
}

function textFromContent(content: CanonicalContent): string {
  switch (content.type) {
    case "text":
    case "reasoning":
      return content.text;
    case "tool_result":
      return textFromToolResult(content);
    case "tool_call":
      return `${content.name}:${stableSerialize(content.arguments)}`;
    case "image":
      return "";
  }
}

function normalizeFailure(value: string): string {
  return value
    .toLowerCase()
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(/[a-z]:\\[^\s:'"]+|\/(?:[^\s/:]+\/)+[^\s:]+/giu, "<path>")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/gu, "<number>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-4_000);
}

function maximumDuplicateCount(values: string[]): number {
  const counts = new Map<string, number>();
  let maximum = 0;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    maximum = Math.max(maximum, count);
  }
  return maximum;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
    .join(",")}}`;
}
