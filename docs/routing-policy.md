# Deterministic Routing Policy

## Instruction precedence

The engine resolves routing instructions in this order:

1. An explicit `forcedModel` constraint.
2. Fixed mode's requested model.
3. An explicit forced provider.
4. Provider and model allowlists/denylists.
5. Capability, size, region, latency, quality, health, and cost filters.
6. Mode-specific candidate scoring.

The `model` field required by Anthropic-compatible clients is a hint in Quality, Balanced, and Eco
modes. Treating it as forced would disable automatic routing. It is exact in Fixed mode.

## Eligibility filters

A candidate is rejected when any of these are true:

- It is disabled.
- It conflicts with forced-provider/model or allow/deny policy.
- It lacks a required capability.
- The requested output exceeds its output limit.
- Estimated input plus requested output exceeds its context window.
- It does not declare the required region.
- It lacks or exceeds a requested millisecond latency limit.
- It falls below the task/mode quality floor.
- Token estimation fails.
- Its provider/model health check is unhealthy.
- Its model or provider circuit breaker is open.
- It already failed earlier in the same bounded fallback sequence.
- Its estimated request cost exceeds the configured request limit.

No unsupported requirement is silently discarded.

## Classification

The first classifier is deterministic. It uses prompt length, message count, estimated input
tokens, tools, images, file count, turn count, prior tool errors, prior test failures, and explicit
intent keywords. It returns one of the task classes defined in the product plan, a difficulty from
1–5, confidence, and non-content signals. Prompt text is not stored in the route decision.

## Scoring

Eligible candidates receive:

```text
score =
    qualityWeight * expectedSuccess
  - costWeight * normalizedEstimatedCost
  - latencyWeight * normalizedLatencyTier
  - failureWeight * providerFailureRisk
  - sessionSwitchPenalty
```

Weights and quality floors are validated configuration under `routing.policies`; they are not
hardcoded into selection logic. Model capability, price, context, output limit, region, and latency
data also come from configuration. Repricing a model therefore changes decisions without changing
router code.

Ties are deterministic: mode score, then Quality-mode tier, estimated cost, latency tier, and
finally lexical model ID.

## Explainability and persistence

Every decision contains:

- Router version and decision ID.
- Mode and task classification.
- Selected model/provider.
- Every candidate.
- Filter reasons.
- Token and cost estimates.
- Health result.
- Score components.
- Human-readable selected and rejected reasons.

The production gateway creates the request, route decision, and first provider attempt together.
The decision stores metadata and computed signals only; it does not store prompt content.

## Session hysteresis

For a request with `x-vartma-session-id`, the router keeps the current model when it is still
eligible, the task remains in the same task family, and another candidate does not exceed the
configured switch threshold. It switches when compatibility/health changes, the task family
changes materially, escalation raises the quality floor, an explicit instruction overrides the
session, or the score improvement is large enough. The route decision stores the prior model,
escalation level, sticky-selection flag, and switch reason.

## Escalation and de-escalation

Authenticated clients report outcomes to
`POST /internal/v1/sessions/{sessionId}/outcomes`. Consecutive negative outcomes raise the
escalation level; an explicit `user_escalation` raises it immediately. Each level raises the
candidate quality floor. Successful outcomes can lower the level only after the configured
cooldown and success threshold. Outcome records contain metadata and level changes, never prompt
or response content.

## Infrastructure fallback

The selected model is tried first. A retryable failure may move to an eligible equivalent/stronger
candidate, preferring a different provider; weaker fallback is configurable. The sequence is
bounded by both attempt count and total wall-clock time. Fixed/forced models do not move.

Provider events are buffered only until the first user-visible text, reasoning, or tool event. Once
any such event is visible, the attempt is committed and can never be replayed on another model.
Every fallback attempt and switch trigger is persisted.

## Circuit breakers

Retryable failures count against both model and provider circuits. Reaching the configured
threshold opens the circuit, routing filters every affected model, and the circuit permits only a
single half-open probe after its cooldown. Configured successful probes close it.
