import type {
  SessionInspection,
  SessionInspectionSummary,
  TraceInspection,
} from "@vartma/database";

export function formatTraceInspection(trace: TraceInspection): string {
  const lines = [
    `Trace ${trace.id}`,
    `Status: ${trace.status}`,
    `Session: ${trace.sessionId ?? "-"}`,
    `Mode: ${trace.routingMode}`,
    `Selected: ${qualifiedModel(trace.selectedProvider, trace.selectedModel)}`,
    `Started: ${trace.startedAt}`,
    `Completed: ${trace.completedAt ?? "-"}`,
    `Error: ${trace.errorType ?? "-"}${trace.errorMessage ? ` — ${trace.errorMessage}` : ""}`,
    `Metadata keys: ${trace.metadataKeys.join(", ") || "-"}`,
  ];
  if (trace.routeDecision) {
    lines.push(
      "",
      `Decision: ${trace.routeDecision.taskClass} via ${qualifiedModel(
        trace.routeDecision.selectedProvider,
        trace.routeDecision.selectedModel,
      )}`,
      `Router version: ${trace.routeDecision.routerVersion}`,
    );
  }
  lines.push("", `Attempts (${String(trace.attempts.length)}):`);
  lines.push(
    ...trace.attempts.map(
      (attempt) =>
        `  ${String(attempt.sequence)}. ${attempt.provider}/${attempt.model} ${attempt.status} ` +
        `${attempt.startedAt}${attempt.errorType ? ` error=${attempt.errorType}` : ""}`,
    ),
  );
  lines.push("", `Switches (${String(trace.switches.length)}):`);
  lines.push(
    ...trace.switches.map(
      (routeSwitch) =>
        `  ${String(routeSwitch.sequence)}. ${qualifiedModel(
          routeSwitch.fromProvider,
          routeSwitch.fromModel,
        )} -> ${qualifiedModel(routeSwitch.toProvider, routeSwitch.toModel)} ` +
        `[${routeSwitch.trigger}] ${routeSwitch.reason}`,
    ),
  );
  lines.push("", `Usage events (${String(trace.usage.length)}):`);
  lines.push(
    ...trace.usage.map(
      (usage) =>
        `  ${usage.provider}/${usage.model} input=${String(usage.inputTokens)} ` +
        `cached=${String(usage.cachedInputTokens)} output=${String(usage.outputTokens)} ` +
        `reasoning=${String(usage.reasoningTokens)} cost=${usage.currency} ${usage.estimatedCostUsd}`,
    ),
  );
  return `${lines.join("\n")}\n`;
}

export function formatSessionList(sessions: SessionInspectionSummary[]): string {
  if (sessions.length === 0) {
    return "No sessions found.\n";
  }
  return `${sessions
    .map(
      (session) =>
        `${session.id} mode=${session.routingMode} model=${qualifiedModel(
          session.currentProvider,
          session.currentModel,
        )} turns=${String(session.turnCount)} escalation=${String(
          session.escalationLevel,
        )} cost=USD ${session.accumulatedCostUsd} last=${session.lastActivityAt}`,
    )
    .join("\n")}\n`;
}

export function formatSessionInspection(session: SessionInspection): string {
  const lines = [
    `Session ${session.id}`,
    `Client: ${session.clientType ?? "-"}`,
    `Mode: ${session.routingMode}`,
    `Current model: ${qualifiedModel(session.currentProvider, session.currentModel)}`,
    `Escalation: ${String(session.escalationLevel)}`,
    `Turns: ${String(session.turnCount)}`,
    `Outcomes: ${String(session.successfulOutcomes)} successful, ${String(
      session.consecutiveFailures,
    )} consecutive failures`,
    `Tokens: input=${session.inputTokens} cached=${session.cachedInputTokens} output=${session.outputTokens} reasoning=${session.reasoningTokens}`,
    `Cost: USD ${session.accumulatedCostUsd}`,
    `Last activity: ${session.lastActivityAt}`,
    "",
    `Recent requests (${String(session.recentRequests.length)}):`,
    ...session.recentRequests.map(
      (request) =>
        `  ${request.id} ${request.status} ${qualifiedModel(
          request.selectedProvider,
          request.selectedModel,
        )} ${request.startedAt}${request.errorType ? ` error=${request.errorType}` : ""}`,
    ),
    "",
    `Recent outcomes (${String(session.recentOutcomes.length)}):`,
    ...session.recentOutcomes.map(
      (outcome) =>
        `  ${outcome.createdAt} ${outcome.kind} escalation=${String(
          outcome.escalationLevelBefore,
        )}->${String(outcome.escalationLevelAfter)} source=${outcome.source ?? "-"}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function qualifiedModel(provider: string | null, model: string | null): string {
  if (!provider && !model) {
    return "-";
  }
  if (!provider) {
    return model ?? "-";
  }
  if (!model || model.startsWith(`${provider}/`)) {
    return model ?? provider;
  }
  return `${provider}/${model}`;
}
