# Initial Threat Model

## Protected assets

- Provider API keys.
- Router API keys.
- Customer prompts and source code.
- Tool inputs and outputs.
- Usage and cost records.
- Routing policies.

## Initial threats and controls

| Threat                               | Initial control                                         |
| ------------------------------------ | ------------------------------------------------------- |
| Provider keys exposed in logs        | Pino path redaction; environment/secret storage         |
| Unauthorized gateway use             | API-key middleware with timing-safe comparison          |
| Oversized JSON request               | Configured Express body limit                           |
| Malicious configurable provider URL  | Provider endpoint allowlist before live custom adapters |
| Cross-request data leak              | Stateless request normalization; no global prompt cache |
| Prompt content exported to telemetry | Content export disabled by default                      |
| Hanging upstream stream              | AbortSignal propagation and later provider deadlines    |
| Duplicate side effects after retry   | No automatic replay after completed tool calls          |
| Dependency compromise                | Lockfile, CI audit/scanning, signed releases later      |

## Deferred security work

- KMS-backed provider credentials.
- Tenant-aware authorization.
- SSO and SCIM.
- Regional data controls.
- Customer-managed keys.
- Formal penetration test.
