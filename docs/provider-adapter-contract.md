# Provider Adapter Contract

Every adapter implements `ProviderAdapter`.

## Responsibilities

- Authenticate with the upstream provider.
- Map canonical messages and tools to the upstream request.
- Produce canonical streaming events.
- Preserve provider request IDs and usage when available.
- Classify provider errors and retryability.
- Honor cancellation.
- Report model capabilities and health.
- Retry only transient failures that occur before the first stream event, with a strict bound.

## Non-responsibilities

Adapters do not:

- Select a model.
- Apply routing modes.
- Retry indefinitely.
- Persist billing events.
- Modify user policy.
- Log prompt content by default.

## Completion gate

An adapter is incomplete until it has fixtures and tests for:

- Non-streaming text.
- Streaming text.
- Tool calls.
- Tool results.
- Cancellation.
- Authentication failure.
- Rate limiting.
- Provider overload.
- Malformed events.
- Usage extraction.

The gateway, rather than an adapter, persists the final provider-reported usage. This keeps database
concerns out of provider translation while ensuring each completed attempt has one ledger entry.
