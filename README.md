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
- Loss-controlled long-transcript compression that retains requirements, decisions, failures,
  mutations, and the recent working set.
- Outcome-driven escalation and cooldown-based de-escalation.
- Transcript-derived stuck detection with content-safe fingerprints, deduplication, and expiring
  automatic escalation.
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
- Versioned task/model evaluation calibration and expected cost-per-success routing that includes
  retries and model-switch cold-context cost.
- A same-origin React operator console for provider/model health, sessions, routing distribution,
  spend, failures, savings, and evaluation coverage.

The complete product plan is in
[VARTMA_PRODUCT_BUILD_PLAN.md](./VARTMA_PRODUCT_BUILD_PLAN.md).
Operator CLI details are in [docs/vartma.md](./docs/vartma.md).
Usage and savings semantics are in [docs/usage-analytics.md](./docs/usage-analytics.md).
Evaluation and calibration are in
[docs/evaluation-and-calibration.md](./docs/evaluation-and-calibration.md).

## Requirements

- Node.js 22 or newer.
- npm 10 or newer.
- Docker Desktop for the local PostgreSQL service.

## Install the CLI

The publishable package is self-contained and bundles Vartma's internal gateway, router, provider,
evaluation, database, and React console workspaces:

```sh
npm install --global @vartma/cli
vartma --help
```

Until an npm release is published, create and install the identical release artifact locally:

```sh
npm pack ./apps/cli
npm install --global ./vartma-cli-0.1.0.tgz
```

`npm run smoke:clean-install` packs the CLI, installs it into an isolated prefix, and verifies the
installed executable without relying on monorepo workspace links.

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

Open `http://127.0.0.1:8080/console/` for the operator console. Enter the configured router API key
in the session-only credential field. Static console assets are public, while every operational API
remains protected by normal router authentication and returns metadata only.

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
npm run vartma -- provider conformance <provider-id> --json
npm run vartma -- start
npm run vartma -- stop
npm run vartma -- trace <request-id>
npm run vartma -- sessions --limit 20
npm run vartma -- eval summarize ./results.jsonl
npm run vartma -- eval calibrate ./results.jsonl --calibration-version eval-v1 --output ./calibration.json --apply
npm run vartma -- serve
npm run vartma -- configure claude-code --mode balanced
npm run vartma -- configure openai --env-path ./.env --mode balanced
npm run vartma -- status
npm run vartma -- bypass on
npm run vartma -- bypass off
npm run vartma -- uninstall
```

For a zero-provider-cost local test, install an Ollama model and use the included configuration.
Ollama defaults to unauthenticated local access, so no dummy API key is required:

```sh
npm run config:validate -- --config ./configs/vartma.ollama.example.yaml
npm run vartma -- provider conformance ollama --config ./configs/vartma.ollama.example.yaml --timeout 300000 --json
npm run vartma -- serve --config ./configs/vartma.ollama.example.yaml
```

The example names `qwen2.5:7b`; update its model ID and `upstreamModel` if `ollama list` shows a
different installed model. Generic OpenAI-compatible/vLLM definitions may set
`authentication: none`; hosted compatible services remain bearer-authenticated by default.

Commands use `./vartma.yaml` by default; `--config` and `VARTMA_CONFIG_PATH` override it.
Claude Code project settings are the default scope. See
[docs/claude-code.md](./docs/claude-code.md) for setup, recovery, model aliases, context switching,
and protocol limitations.

See [docs/openai-and-gemini.md](./docs/openai-and-gemini.md) for OpenAI client examples, Gemini
configuration, local/vLLM setup, and compatibility boundaries.

See the [completion audit](./docs/completion-audit.md) for requirement-by-requirement evidence and
the external provider/benchmark proof that is still required before declaring parity complete.

## Quality commands

```sh
npm run build
npm run typecheck
npm test
npm run lint
npm run format:check
npm run prisma:validate
npm run smoke:claude-code
npm run smoke:load
npm run smoke:clean-install
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
```

For a containerized local gateway with PostgreSQL and migrations:

```sh
export POSTGRES_PASSWORD='replace-with-a-generated-database-secret'
export VARTMA_DATABASE_URL='postgresql://vartma:replace-with-a-url-encoded-secret@postgres:5432/vartma?schema=public'
export VARTMA_MASTER_KEY='replace-with-a-long-random-master-key'
export VARTMA_API_KEYS='replace-with-a-generated-gateway-key'
docker compose up --build --wait
```

PowerShell uses `$env:NAME = "value"` for the same variables. Compose fails closed when any
required deployment secret is absent; the repository does not contain a working production
password or gateway key.

Compose waits for PostgreSQL, applies checked-in Prisma migrations in a one-shot service, then
starts the production-dependency-only gateway image on port 8080. Provider keys and
`VARTMA_MASTER_KEY` should be supplied through your deployment secret mechanism when live providers
or encrypted transcripts are enabled.

## Configuration rules

- Provider API keys must be supplied through environment or secret storage.
- For encrypted BYOK storage, set a master passphrase of at least 20 characters outside the
  repository and run `vartma login <provider-id>`:

  ```powershell
  $env:VARTMA_MASTER_KEY = "use-a-long-random-master-passphrase"
  $env:OPENAI_API_KEY = "your-provider-key"
  vartma login openai --from-env OPENAI_API_KEY --config ./vartma.yaml
  ```

  Vartma derives an AES-256-GCM key with scrypt, authenticates the encrypted store on every read,
  keeps the master key outside configuration, and gives an encrypted credential reference
  precedence over the provider's environment-variable fallback. The `.vartma/` store is ignored by
  Git; back it up as sensitive encrypted data and supply the master key through your deployment
  secret manager.

- Run the checked-in LangGraph coding-agent evaluation harness against fixed and routed targets:

  ```sh
  vartma eval run ./evals/suites/smoke.yaml --target fixed:<model-id> --output fixed.jsonl
  vartma eval run ./evals/suites/smoke.yaml --target router:balanced --output balanced.jsonl
  ```

  The harness operates on disposable fixture copies, restricts agent commands to the suite's
  allowlist, runs verifier commands without a shell, and records actual retry-inclusive gateway
  usage. Runs are also persisted transactionally in configured PostgreSQL unless `--no-persist` is
  supplied. See [evaluation and calibration](./docs/evaluation-and-calibration.md).

- Prompt content is not logged by default.
- LangSmith export is disabled by default.
- A configured model ID is distinct from the provider's upstream model name.
- Model capabilities and prices are configuration, never routing-code constants.
- Cross-model fallback occurs only before user-visible text, reasoning, or tool output; an
  interrupted visible stream is never replayed.
- Forced/Fixed models are never replaced by fallback.
- The gateway stores one usage ledger event for every successfully completed provider attempt.

## Current boundary

The router covers Claude Code and OpenAI-compatible coding clients; native Anthropic, OpenAI, and
Gemini upstreams; and Kimi, DeepSeek, Z.ai/GLM, xAI/Grok, Ollama, vLLM, and other compatible
Chat-Completions upstreams. Provider-specific model IDs, prices, limits, and capabilities remain
operator configuration and must be validated against the exact account and endpoint in use.

LangChain is not in the critical provider path because it would obscure protocol details the router
must preserve. LangGraph powers the repeatable evaluation agent workflow, where explicit
model/tool/verification states are useful. The streaming gateway hot path remains deterministic
TypeScript. LangSmith is optional and is not required to run the router.
