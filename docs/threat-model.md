# Initial Threat Model

## Protected assets

- Provider API keys.
- Router API keys.
- Customer prompts and source code.
- Tool inputs and outputs.
- Usage and cost records.
- Routing policies.

## Initial threats and controls

| Threat                               | Initial control                                          |
| ------------------------------------ | -------------------------------------------------------- |
| Provider keys exposed in logs        | Pino redaction; AES-GCM BYOK vault or environment keys   |
| Unauthorized gateway use             | API-key middleware with timing-safe comparison           |
| Oversized JSON request               | Configured Express body limit                            |
| Malicious configurable provider URL  | Provider endpoint allowlist before live custom adapters  |
| Cross-request data leak              | Session-keyed encrypted canonical transcript store       |
| Prompt content exported to telemetry | Content export disabled by default                       |
| Hanging upstream stream              | AbortSignal propagation and bounded provider deadlines   |
| Unbounded or fragmented upstream SSE | 16 MiB event cap and deterministic fragmentation fuzzing |
| Duplicate side effects after retry   | No automatic replay after completed tool calls           |
| Dependency compromise                | Lockfile and high-severity production audit in CI        |

## Deferred security work

- KMS-backed provider credentials.
- Tenant-aware authorization.
- SSO and SCIM.
- Regional data controls.
- Customer-managed keys.
- Formal penetration test.
