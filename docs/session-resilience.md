# Session Routing and Resilience

## Session lifecycle

Clients opt into stateful routing with `x-vartma-session-id`. The default store is in-memory for
tests or an explicitly database-free app; the production server uses PostgreSQL through Prisma.
Only routing metadata is retained by default:

- Current provider/model and routing mode.
- Turn count and last task class.
- Escalation level and failure/success counters.
- Cooldown timestamps.
- Accumulated cost and token counts.

Prompt and response content are not part of session state.

## Outcome API

`POST /internal/v1/sessions/{sessionId}/outcomes` uses the same API-key authentication as model
requests. Its body accepts:

```json
{
  "kind": "test_failure",
  "request_id": "optional-client-request-id",
  "source": "test-runner",
  "metadata": {
    "suite": "unit"
  }
}
```

Two configured consecutive failures escalate by default. `user_escalation` escalates immediately.
Three configured successful outcomes can de-escalate after the cooldown. All thresholds are under
`routing.session`.

`GET /internal/v1/sessions/{sessionId}` returns the metadata-only state for diagnostics.

## Safe fallback invariant

Cross-model fallback is permitted only before meaningful output. The gateway prepares an attempt
by buffering protocol-start events. It commits to the attempt as soon as it sees text, reasoning,
or any tool-call event. A failure after that point is returned to the client and is never replayed.

Fallback candidates must already have passed routing eligibility. Equivalent or stronger models
are preferred, a different provider is preferred, and optional weaker candidates are last. Fixed
mode and `x-vartma-model` remain exact. `maxAttempts` and `maxTotalDurationMs` bound the sequence.

## Circuit state

Retryable infrastructure failures affect both model and provider circuits:

```text
closed --failure threshold--> open --cooldown--> half_open
half_open --successful probes--> closed
half_open --failure--> open
```

Open provider circuits remove every model from that provider before scoring. A half-open circuit
allows a single probe so concurrent traffic cannot stampede a recovering upstream.

## Persistence

The initial request, decision, and provider attempt are created together. Every fallback creates a
new ordered `ProviderAttempt` and `RouteSwitch` with the source/destination and triggering error.
Outcomes are append-only `SessionOutcome` rows. Successful usage increments session cost and token
totals.

## Operational metrics

`GET /metrics` reports total fallback attempts and session escalation/de-escalation transitions in
addition to request and response counters. Circuit state remains process-local in this phase;
Redis-backed shared circuit state is a later multi-replica scaling step.
