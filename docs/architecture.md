# Vartma.ai Architecture

## Request path

```text
HTTP request
  -> Express request ID and redacted logging
  -> API-key authentication
  -> Anthropic / OpenAI Responses / Chat request validation
  -> Protocol-specific normalization into one canonical request
  -> Deterministic task classification
  -> Model registry filters and health checks
  -> Mode-specific candidate scoring
  -> Session hysteresis and escalation quality floor
  -> Explainable route decision
  -> Circuit-aware, bounded pre-output fallback
  -> Provider adapter attempt
  -> Canonical event stream
  -> Anthropic / Responses / Chat JSON or SSE translation
  -> HTTP response
```

Claude Code also uses the authenticated `/v1/models` and `/v1/messages/count_tokens` endpoints.
Its unauthenticated `HEAD /` startup probe does not enter the inference path.

`executeCanonical` is the single execution boundary for all three ingress protocols. It owns
session loading, circuit exclusions, route decisions, bounded fallback, route persistence, and
terminal session updates. Protocol handlers only normalize inputs, apply shared routing headers,
and translate the canonical event stream back to the caller's contract.

The fake provider remains for deterministic tests. Native Anthropic Messages, OpenAI Responses,
Gemini GenerateContent, and generic OpenAI-compatible Chat Completions use the same
provider-neutral request and event contracts. The gateway records all provider attempts, fallback
switches, upstream request IDs, first-token times, terminal usage, calculated cost, route decisions,
session state, and outcome signals through Prisma.

## Boundaries

### Gateway

Owns HTTP, authentication, protocol validation, streaming, request cancellation, safe fallback
orchestration, and errors.

### Canonical package

Owns provider-neutral messages, tools, model capabilities, usage, and streaming events.

### Provider package

Owns the provider adapter contract, registry, and provider-specific execution.

### Configuration package

Owns YAML parsing, environment overrides, and strict runtime validation.

### Database package

Owns Prisma client construction, the provider-attempt/usage ledger, session state/outcomes, and
route-switch persistence. The production server injects these repositories into the gateway;
protocol tests can inject in-memory stores.

The Claude Code CLI configuration manager owns only the router-related environment keys in
Claude's settings. It keeps baseline and routed backups, detects drift, merges unrelated settings
during bypass/undo, and gitignores project-local credential artifacts.

### Routing package

Owns deterministic classification/scoring, session hysteresis, escalation policy, and circuit
state machines. It does not own HTTP or provider protocol translation.

## Availability boundary

PostgreSQL makes redacted configuration snapshots, session state, encrypted canonical transcripts,
outcomes, switches, usage, cost, and evaluation runs durable. The YAML file remains the operator's
authoritative startup input; every activated version is content-addressed in PostgreSQL without
gateway keys or the database URL. Circuit state is process-local. A multi-replica deployment needs
sticky routing or a shared circuit-state implementation; neither changes the provider-neutral
protocol or durable ledger.

## AI framework policy

- Direct provider APIs remain authoritative in the proxy path.
- LangChain may be used for internal experiments or evaluators.
- LangGraph implements the long-running evaluation agent workflow.
- LangSmith may receive redacted, sampled development/evaluation traces when explicitly enabled.
- None of these tools may become required for gateway availability.
