# Completion audit

Audited against the active Vartma.ai goal on 2026-08-25. "Implemented" means current source and
local tests directly exercise the requirement. "Unproven" means the required external evidence
does not exist yet; it is not treated as complete merely because an adapter or command exists.

| Requirement                                                                                     | Status                                               | Current evidence or missing proof                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider-neutral Anthropic, Responses, and Chat ingress with streaming/tools                    | Implemented                                          | Gateway normalization/translation suites and official OpenAI SDK integration tests                                                                                                                                                                        |
| Task/capability/context classification and eligibility filtering                                | Implemented                                          | Routing classifier, model registry, context, constraint, and preflight tests                                                                                                                                                                              |
| Quality/cost/latency/retry/cache/switch-aware selection                                         | Implemented                                          | Calibrated expected-success and expected-cost-per-success scoring with explicit cold-switch cost                                                                                                                                                          |
| Quality, Balanced, Eco, and exact Fixed policies                                                | Implemented                                          | Policy and routing-engine tests; forced models are never replaced                                                                                                                                                                                         |
| Session stickiness, progress detection, escalation, and safe fallback                           | Implemented                                          | Session/progress/circuit/fallback tests, including no replay after visible output                                                                                                                                                                         |
| Router-owned context across model changes                                                       | Implemented                                          | Canonical history coordinator and cross-provider delta-history/tool-pairing tests                                                                                                                                                                         |
| Durable encrypted canonical transcripts                                                         | Implemented                                          | AES-256-GCM with startup scrypt hardening, per-transcript HKDF keys, authenticated session binding, and backward-compatible version-one reads; requires PostgreSQL plus master key                                                                        |
| Anthropic, OpenAI, Gemini, Kimi, DeepSeek, Z.ai/GLM, xAI/Grok, Ollama, vLLM/generic adapters    | Protocol implementation complete; partial live proof | Native and compatible mocked HTTP/conformance tests pass. Installed Ollama `qwen2.5:7b` passes real conformance and a managed-gateway generation without a dummy key; authenticated results for the other named families do not exist yet                 |
| Encrypted BYOK without secret logging                                                           | Implemented                                          | Authenticated encrypted vault, CLI login, key precedence, redaction, wrong-key, rotation, and no-leak tests                                                                                                                                               |
| CLI setup/lifecycle/status/doctor/bypass/uninstall/restore                                      | Implemented                                          | Focused command tests, managed-process test, and isolated global tarball installation                                                                                                                                                                     |
| Real coding-agent clean-install routing                                                         | Implemented locally                                  | Claude Code 2.1.212 completes a streamed `Read` tool loop through the router                                                                                                                                                                              |
| React operator console for providers/models/routing/sessions/spend/evaluations/failures/savings | Implemented                                          | Same-origin React build plus authenticated redacted metadata APIs and API tests                                                                                                                                                                           |
| PostgreSQL configuration/routing/usage/evaluation persistence                                   | Implemented and locally proven                       | All nine migrations applied to disposable PostgreSQL 17; live router/evaluation data persisted and read back; a fresh-instance dump/restore drill authenticates the restored encrypted transcript and migration history                                   |
| Repeatable evaluation and calibration platform                                                  | Implemented                                          | Versioned YAML suites, LangGraph tool agent, disposable workspaces, verifier, actual usage collection, output-limit comparability, deadline propagation, honest failure recording, JSONL and PostgreSQL persistence                                       |
| Balanced frontier quality with meaningful measured savings                                      | Unproven                                             | Requires real identical-task fixed-baseline and Balanced benchmark results across a substantial coding corpus                                                                                                                                             |
| Eco additional savings with documented quality trade-off                                        | Unproven                                             | Requires the same real benchmark and an explicit accepted quality threshold                                                                                                                                                                               |
| Costs from actual provider usage, including retries                                             | Implemented for gateway accounting                   | Provider-reported token usage drives the immutable retry-inclusive ledger; billing-export reconciliation still needs provider accounts                                                                                                                    |
| Outage/rate-limit/timeout/malformed-stream recovery                                             | Implemented locally                                  | Provider error, retry, bounded fallback, circuit breaker, cancellation, bounded SSE events, and 200-pattern arbitrary UTF-8 fragmentation tests                                                                                                           |
| Security verification                                                                           | Partially proven                                     | Secret/redaction/path-confinement tests, dependency audits, hardened Compose, live log redaction, and a private-reporting/owned-remediation policy pass; independent penetration review is not available                                                  |
| Load and endurance verification                                                                 | Implemented locally                                  | Concurrent load gate plus a PostgreSQL-backed 15-minute mixed JSON/SSE soak at 20 target RPS, enforced throughput/latency/event-loop/RSS/readiness limits, and zero failures                                                                              |
| Cross-platform and container verification                                                       | Implemented and remotely proven                      | Local production image/Compose path passes; [GitHub Actions run 32816599375](https://github.com/vasantkr97/vartma.ai/actions/runs/32816599375) passes Ubuntu, macOS, Windows, and live PostgreSQL migration/start/doctor/routing/soak/recovery/image jobs |

## Latest local gate

- Formatting, strict type checking, build, lint, Prisma validation, and example configuration
  validation pass.
- 49 test files and 250 tests pass.
- Full-tree and production-only `npm audit --audit-level=high` report zero vulnerabilities.
- Load smoke: 400 requests, concurrency 40, 0 failures, 236.3 requests/second, 339.5 ms p95 on
  this machine.
- Production-path soak: 17,504 measured requests in 901.7 seconds, 19.4 requests/second, 1,598.3 ms
  p95, 51.8 ms event-loop p99, 392.7 MiB peak RSS, 152.6 MiB PostgreSQL growth, and 0 failures.
- The soak exposed and regression-fixed concurrent immutable price-book initialization; its clean
  rerun used PostgreSQL session/attempt/usage stores and encrypted canonical transcripts.
- Isolated global CLI tarball installation passes.
- Claude Code 2.1.212 completes a streamed tool-using router session.
- Ollama `qwen2.5:7b` passes deliberate conformance and a real managed-gateway request with actual
  provider usage. Its coding-evaluation attempt failed honestly at the configured request budget;
  the failed result, usage, model attribution, and retained workspace were persisted.
- Disposable PostgreSQL 17 and the hardened production Compose stack apply all migrations, become
  healthy, persist a routed request, redact the gateway key in logs, and tear down cleanly. The
  recovery drill restores all nine migrations, a Vartma session, and its authenticated encrypted
  canonical transcript into a fresh instance.
- GitHub Actions run `32816599375` passes the full validation matrix on Ubuntu, macOS, and Windows,
  plus the PostgreSQL migration/diagnostics/endurance/recovery/container-build job.

## Completion blockers

The product cannot honestly be declared complete until operators provide usable provider keys and
authorize the real benchmark spend, then the remaining named-provider conformance runs and the
fixed/Balanced/Eco evaluation matrix succeed on a substantial corpus. Independent security review,
release signing, and provider billing-export reconciliation remain external production-release
evidence, not claims that can be generated from source tests.
