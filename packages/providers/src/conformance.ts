import type { CanonicalEvent, CanonicalRequest } from "@vartma/canonical";

import type { ProviderAdapter } from "./provider.js";

export interface ProviderConformanceReport {
  provider: string;
  model: string;
  passed: boolean;
  checks: {
    health: boolean;
    tokenEstimate: boolean;
    lifecycle: boolean;
    contentBlocks: boolean;
    toolJson: boolean;
  };
  issues: string[];
  eventsObserved: number;
}

export async function runProviderConformance(
  provider: ProviderAdapter,
  model: string,
  request: CanonicalRequest,
  signal?: AbortSignal,
): Promise<ProviderConformanceReport> {
  const issues: string[] = [];
  const checks = {
    health: false,
    tokenEstimate: false,
    lifecycle: false,
    contentBlocks: false,
    toolJson: false,
  };

  const health = await provider.health(model, signal);
  checks.health = health.healthy;
  if (!health.healthy) {
    issues.push(`Health check failed${health.reason ? `: ${health.reason}` : "."}`);
  }

  const estimate = await provider.estimateTokens(request, signal);
  checks.tokenEstimate =
    Number.isFinite(estimate.inputTokens) &&
    estimate.inputTokens >= 0 &&
    Number.isFinite(estimate.expectedOutputTokens) &&
    estimate.expectedOutputTokens >= 0;
  if (!checks.tokenEstimate) {
    issues.push("Token estimate contains a negative or non-finite value.");
  }

  const events: CanonicalEvent[] = [];
  for await (const event of provider.execute(model, request, signal)) {
    events.push(event);
  }
  const started = events.filter((event) => event.type === "response.started");
  const terminal = events.filter(
    (event) => event.type === "response.completed" || event.type === "response.failed",
  );
  checks.lifecycle = started.length === 1 && terminal.length === 1;
  if (!checks.lifecycle) {
    issues.push(
      `Expected one response.started and one terminal event; observed ${started.length} and ${terminal.length}.`,
    );
  }

  const openBlocks = new Set<number>();
  for (const event of events) {
    if (event.type === "content.started" || event.type === "tool_call.started") {
      if (openBlocks.has(event.index)) {
        issues.push(`Output block ${event.index} started more than once.`);
      }
      openBlocks.add(event.index);
    } else if (event.type === "content.completed" || event.type === "tool_call.completed") {
      if (!openBlocks.delete(event.index)) {
        issues.push(`Output block ${event.index} completed before it started.`);
      }
    }
  }
  checks.contentBlocks = openBlocks.size === 0 && !issues.some((issue) => issue.includes("block"));
  if (openBlocks.size > 0) {
    issues.push(`Output blocks remained open: ${[...openBlocks].join(", ")}.`);
  }

  const toolArguments = new Map<number, string>();
  for (const event of events) {
    if (event.type === "tool_call.arguments.delta") {
      toolArguments.set(event.index, (toolArguments.get(event.index) ?? "") + event.partialJson);
    }
  }
  checks.toolJson = true;
  for (const [index, value] of toolArguments) {
    try {
      JSON.parse(value);
    } catch {
      checks.toolJson = false;
      issues.push(`Tool-call block ${index} produced invalid JSON arguments.`);
    }
  }

  return {
    provider: provider.name,
    model,
    passed: Object.values(checks).every(Boolean) && issues.length === 0,
    checks,
    issues,
    eventsObserved: events.length,
  };
}
