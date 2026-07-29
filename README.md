# Vartma.ai

Vartma.ai is an intelligent, provider-neutral model router for coding agents and AI applications.
It accepts a client protocol, normalizes it into canonical internal events, selects the best
eligible model, and translates the provider response back to the protocol expected by the client.

Phases 1 through 6 currently provide:

- Strict TypeScript npm workspace.
- Express gateway.
- Anthropic-compatible `POST /v1/messages`.
- Non-streaming and Server-Sent Event responses.
- Text and tool-call translation.
- Request cancellation and stream backpressure.
- API-key authentication.
- Provider registry and fake provider for deterministic testing.
- Native Anthropic Messages and OpenAI Responses provider adapters.
- Text, reasoning-summary, tool-call, and tool-result streaming across both providers.
- Stable provider error classes, cancellation, request deadlines, and bounded pre-stream retries.
- Provider usage/cost persistence through Prisma provider-attempt and usage-event records.
- Deterministic Quality, Balanced, Eco, and Fixed routing modes.
- Capability, policy, health, context, output-size, region, latency, and cost filters.
- Explainable route decisions persisted with every provider attempt.
- Session model stickiness with configurable switch hysteresis.
- Outcome-driven escalation and cooldown-based de-escalation.
- Bounded, deadline-aware cross-provider fallback before visible output.
- Per-model and per-provider circuit breakers with half-open recovery.
- Persisted fallback attempts, route-switch reasons, session outcomes, and accumulated session cost
  and usage.
- Validated YAML configuration.
- Prisma/PostgreSQL schema.
- Liveness, readiness, and Prometheus-format metrics.
- Initial `vartma` CLI.
- Claude Code gateway compatibility for current beta request shapes and native session headers.
- Claude Code connectivity probes, model discovery, token counting, and routing-mode aliases.
- Project-local/user-wide configuration with backups, drift detection, bypass, and undo.
- A real installed-Claude-Code smoke test that completes a streamed `Read` tool loop offline.
- OpenAI-compatible `/v1/responses` and `/v1/chat/completions` ingress on the same router path.
- Native Gemini streaming with text, tools, structured JSON, usage, and thought signatures.
- Generic Chat-Completions-compatible upstreams for vLLM and other hosted/local servers.
- A reusable provider conformance runner.
- Secret-safe `vartma doctor` checks for credentials, providers/models, gateway readiness, and
  PostgreSQL connectivity.
- `vartma models`, bounded `provider test`, and Prisma-backed `trace`/`sessions` inspection with
  machine-readable JSON.
- Safe `vartma init`, provider add/enable/disable/remove, persistent `mode`/`use`, exact
  backup/undo, file locking, and external-drift detection.
- Interactive provider setup that collects declared capabilities and operator-verified pricing but
  never asks for or stores provider secret values.
- Combined human/JSON operator status for configuration, routing defaults, credential presence,
  bounded gateway readiness, and Claude Code state without secret-bearing fields.
- Retry-inclusive immutable usage events, declared fixed baselines, versioned price evidence, and
  authenticated aggregate/per-request cost and savings APIs.

The complete product plan is in
[VARTMA_PRODUCT_BUILD_PLAN.md](./VARTMA_PRODUCT_BUILD_PLAN.md).
Operator CLI details are in [docs/vartma.md](./docs/vartma.md).
Usage and savings semantics are in [docs/usage-analytics.md](./docs/usage-analytics.md).

## Requirements

- Node.js 22 or newer.
- npm 10 or newer.
- Docker Desktop for the local PostgreSQL service.

## Setup

```sh
copy .env.example .env
npm install
docker compose up -d postgres
npm run prisma:generate
npm run build
npm test
```

On macOS or Linux, replace `copy` with `cp`.

## Run the gateway

```sh
npm run dev:gateway
```

The example configuration listens on `127.0.0.1:8080`, uses the development API key
`local-development-key`, and keeps the live providers disabled until their keys are configured.

Test a non-streaming request:

```sh
curl http://127.0.0.1:8080/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: local-development-key" \
  -d '{
    "model": "fake/default",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "hello router"}]
  }'
```

Test a streaming request:

```sh
curl -N http://127.0.0.1:8080/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: local-development-key" \
  -d '{
    "model": "fake/default",
    "max_tokens": 256,
    "stream": true,
    "messages": [{"role": "user", "content": "hello router"}]
  }'
```

## Routing controls

An Anthropic-compatible request always contains a `model` field. In Quality, Balanced, and Eco
modes that field is treated as a client hint so the router remains free to select any eligible
configured model. In Fixed mode it is exact.

Routing can be controlled with these headers:

| Header                       | Meaning                                       |
| ---------------------------- | --------------------------------------------- |
| `x-vartma-mode`              | `quality`, `balanced`, `eco`, or `fixed`      |
| `x-vartma-model`             | Force one configured router model in any mode |
| `x-vartma-provider`          | Restrict selection to one provider            |
| `x-vartma-allowed-models`    | Comma-separated router-model allowlist        |
| `x-vartma-denied-models`     | Comma-separated router-model denylist         |
| `x-vartma-allowed-providers` | Comma-separated provider allowlist            |
| `x-vartma-denied-providers`  | Comma-separated provider denylist             |
| `x-vartma-max-cost-usd`      | Maximum estimated request cost                |
| `x-vartma-max-latency-ms`    | Maximum configured expected latency           |
| `x-vartma-region`            | Required configured model region              |
| `x-vartma-session-id`        | Stable session ID for stickiness/escalation   |

Responses identify the decision through `x-vartma-model`, `x-vartma-provider`,
`x-vartma-task-class`, `x-vartma-decision-id`, `x-vartma-fallback-count`, and
`x-vartma-escalation-level`.

Outcome integrations can report verifier/tool/test results without sending prompt content:

```sh
curl http://127.0.0.1:8080/internal/v1/sessions/my-session/outcomes \
  -H "content-type: application/json" \
  -H "x-api-key: local-development-key" \
  -d '{"kind":"test_failure","source":"test-runner"}'
```

Supported outcome kinds are `success`, `task_completed`, `test_failure`, `tool_error`,
`structured_output_failure`, `stuck`, `verifier_failure`, and `user_escalation`.
Authenticated `GET /internal/v1/sessions/{sessionId}` returns metadata-only state.

## CLI

```sh
npm run vartma -- init
npm run vartma -- config validate --config ./vartma.yaml
npm run vartma -- mode balanced
npm run vartma -- use fake/default
npm run vartma -- provider add
npm run vartma -- provider add ./provider.yaml
npm run vartma -- config undo
npm run vartma -- doctor --config ./vartma.yaml
npm run vartma -- models --json
npm run vartma -- provider test
npm run vartma -- trace <request-id>
npm run vartma -- sessions --limit 20
npm run vartma -- serve
npm run vartma -- configure claude-code --mode balanced
npm run vartma -- status
npm run vartma -- bypass on
npm run vartma -- bypass off
```

Commands use `./vartma.yaml` by default; `--config` and `VARTMA_CONFIG_PATH` override it.
Claude Code project settings are the default scope. See
[docs/claude-code.md](./docs/claude-code.md) for setup, recovery, model aliases, context switching,
and protocol limitations.

See [docs/openai-and-gemini.md](./docs/openai-and-gemini.md) for OpenAI client examples, Gemini
configuration, local/vLLM setup, and compatibility boundaries.

## Quality commands

```sh
npm run build
npm run typecheck
npm test
npm run lint
npm run format:check
npm run prisma:validate
npm run smoke:claude-code
```

## Configuration rules

- Provider API keys must be supplied through environment or secret storage.
- Prompt content is not logged by default.
- LangSmith export is disabled by default.
- A configured model ID is distinct from the provider's upstream model name.
- Model capabilities and prices are configuration, never routing-code constants.
- Cross-model fallback occurs only before user-visible text, reasoning, or tool output; an
  interrupted visible stream is never replayed.
- Forced/Fixed models are never replaced by fallback.
- The gateway stores one usage ledger event for every successfully completed provider attempt.

## Current boundary

The working router milestone now covers Claude Code, OpenAI Responses/Chat clients, Anthropic,
OpenAI, Gemini, and generic/local Chat-Completions-compatible upstreams. Phase 7 completes the
operator CLI with provider tests, model/mode management, trace/session inspection, and
cross-platform packaging.

LangChain is not in the critical provider path because it would obscure protocol details the router
must preserve. LangGraph and LangSmith remain available for later evaluation workflows and optional
redacted trace export, where they add value without becoming gateway dependencies.
