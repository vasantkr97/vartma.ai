# Session Routing and Resilience

## Session lifecycle

Clients opt into stateful routing with `x-vartma-session-id`. The default store is in-memory for
tests or an explicitly database-free app; the production server uses PostgreSQL through Prisma.
Routing metadata includes:

- Current provider/model and routing mode.
- Turn count and last task class.
- Escalation level and failure/success counters.
- Cooldown timestamps.
- SHA-256 progress fingerprints and the expiry of automatic stuck verdicts.
- Accumulated cost and token counts.

The router separately owns the canonical session transcript. With PostgreSQL and
`VARTMA_MASTER_KEY` configured, that transcript is encrypted at rest with AES-256-GCM using a
scrypt-derived key and authenticated against its session ID. Without both prerequisites, canonical
history is process-local and does not survive a restart. The next request can be either a complete
history or a delta: Vartma merges it into the canonical transcript before classification and
provider translation. Only content returned by provider APIs is portable; hidden reasoning that a
provider never returns cannot be transferred.

## Automatic progress detection

Before routing a turn, the gateway analyzes the portable transcript for repeated identical failure
output, repeated tool calls with unchanged arguments, accumulated tool errors, and failing test
results. Only counters, reasons, confidence, and SHA-256 fingerprints leave the analyzer. Raw tool
arguments and terminal output are not persisted as routing telemetry.

Strong repeated evidence records a `stuck` outcome and raises the quality floor automatically. The
same fingerprint cannot escalate a session twice. A new stuck pattern may escalate again, up to the
configured maximum. Automatic levels expire after `automaticStuckVerdictTtlMs`; explicit outcome
levels continue to follow the normal success/cooldown policy.

## Long-context compression

When the canonical transcript crosses `routing.context.triggerCharacters`, Vartma creates an
extractive provider-bound copy. The canonical request used for progress analysis remains intact.
Compression never rewrites retained content and preserves system instructions, the initial user
requirement, requirement/decision-bearing messages, failure evidence, file-changing tool calls and
their results, and the configured recent tail. Older low-value operational messages are replaced by
a compact inventory of omitted tool activity.

Responses expose `x-vartma-context-compressed` and, when applicable,
`x-vartma-context-omitted-messages`. If mandatory retained content alone exceeds the target, the
report marks that condition rather than silently discarding it.

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

Every completed assistant stream is reconstructed from canonical text, returned reasoning,
signatures, and tool calls before it is appended to canonical history. Tool results from the next
agent turn remain paired with those calls when the destination model changes. Production operators
must keep the transcript master key in a deployment secret manager; losing it makes persisted
transcripts intentionally unreadable.

## Operational metrics

`GET /metrics` reports total fallback attempts and session escalation/de-escalation transitions in
addition to request and response counters. Circuit state is process-local. Multi-replica
deployments therefore need sticky routing or an external shared circuit-state implementation;
PostgreSQL still preserves session metadata, transcripts, decisions, attempts, usage, and
evaluations across replicas.
