# Canonical Protocol

The canonical protocol prevents any provider API from becoming the router's internal architecture.

## Request invariants

- Every request has a router-generated or trusted request ID.
- Messages contain typed content blocks.
- Tool calls and results retain stable logical IDs.
- Required capabilities are explicit.
- Requested model and selected model are separate concepts.
- Provider-specific data may be retained only in an explicitly opaque field.

## Routing invariants

- Client constraints and explicit operator overrides are applied before automatic policy.
- `forcedModel` means exact-model routing in every mode.
- `forcedProvider` restricts routing to that provider in every mode.
- `requestedModel` is exact in Fixed mode and only a compatibility hint in Quality, Balanced, and
  Eco modes.
- Capability, context-window, output-token, region, health, latency, and cost filters run before
  candidate scoring.
- A route decision contains the selected provider/model, classifier result, eligible and rejected
  candidates, filter reasons, policy version, and price-book version.
- Identical requests, configuration, health inputs, and failure signals produce identical
  decisions.
- Prompt and response content are not stored in route-decision explanations.

## Event invariants

Provider adapters emit ordered events:

1. Exactly one `response.started`.
2. Zero or more content/tool blocks.
3. Optional `usage.updated` events.
4. Exactly one terminal `response.completed` or `response.failed`.

A text block starts before text deltas and completes after them. A tool-call block starts before
argument deltas and completes after them.

## Translation policy

- Unsupported required features fail before provider execution.
- Translation never silently drops a tool call or tool result.
- Malformed provider tool JSON is a provider protocol error.
- Usage is copied from provider-reported data when available.
- `inputTokens` means uncached/billable input tokens; `cachedInputTokens` is tracked separately,
  even when an upstream provider reports cached tokens as a subset of total input tokens.
- Hidden chain-of-thought is not transferred between providers.
- Request cancellation propagates through `AbortSignal`.
