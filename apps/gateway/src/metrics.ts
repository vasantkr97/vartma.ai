export class GatewayMetrics {
  private requestsTotal = 0;
  private requestsInFlight = 0;
  private responsesByStatus = new Map<string, number>();
  private fallbackAttemptsTotal = 0;
  private sessionEscalationsTotal = 0;
  private sessionDeescalationsTotal = 0;

  public requestStarted(): void {
    this.requestsTotal += 1;
    this.requestsInFlight += 1;
  }

  public requestCompleted(status: string): void {
    this.requestsInFlight = Math.max(0, this.requestsInFlight - 1);
    this.responsesByStatus.set(status, (this.responsesByStatus.get(status) ?? 0) + 1);
  }

  public fallbackUsed(attempts: number): void {
    this.fallbackAttemptsTotal += Math.max(0, attempts);
  }

  public sessionOutcome(escalated: boolean, deescalated: boolean): void {
    if (escalated) {
      this.sessionEscalationsTotal += 1;
    }
    if (deescalated) {
      this.sessionDeescalationsTotal += 1;
    }
  }

  public render(): string {
    const lines = [
      "# HELP vartma_requests_total Total routed requests.",
      "# TYPE vartma_requests_total counter",
      `vartma_requests_total ${this.requestsTotal}`,
      "# HELP vartma_requests_in_flight Requests currently being processed.",
      "# TYPE vartma_requests_in_flight gauge",
      `vartma_requests_in_flight ${this.requestsInFlight}`,
      "# HELP vartma_responses_total Routed responses by outcome.",
      "# TYPE vartma_responses_total counter",
    ];

    for (const [status, value] of [...this.responsesByStatus.entries()].sort()) {
      lines.push(`vartma_responses_total{status="${status}"} ${value}`);
    }
    lines.push(
      "# HELP vartma_fallback_attempts_total Cross-model fallback attempts.",
      "# TYPE vartma_fallback_attempts_total counter",
      `vartma_fallback_attempts_total ${this.fallbackAttemptsTotal}`,
      "# HELP vartma_session_escalations_total Session escalation transitions.",
      "# TYPE vartma_session_escalations_total counter",
      `vartma_session_escalations_total ${this.sessionEscalationsTotal}`,
      "# HELP vartma_session_deescalations_total Session de-escalation transitions.",
      "# TYPE vartma_session_deescalations_total counter",
      `vartma_session_deescalations_total ${this.sessionDeescalationsTotal}`,
    );
    return `${lines.join("\n")}\n`;
  }
}
