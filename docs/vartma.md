# Vartma.ai CLI

The CLI covers safe configuration initialization/mutation, managed gateway lifecycle, Claude Code
configuration/rollback, model discovery, provider connectivity, evaluation calibration, complete
diagnostics, and persisted trace/session inspection.

Run it from the workspace with:

```sh
npm run vartma -- --help
```

Unless `--config` or `VARTMA_CONFIG_PATH` is supplied, commands use `./vartma.yaml`.

## Managed gateway lifecycle

`vartma start` launches the gateway as a hidden detached process on Windows, macOS, and Linux and
waits for its public health endpoint. A random instance token is returned only as a response header
and recorded with the process ID. `vartma stop` verifies that token before sending `SIGTERM`, so a
stale PID file cannot terminate an unrelated reused process ID.

```sh
vartma start --config ./vartma.yaml
vartma status --config ./vartma.yaml
vartma stop --config ./vartma.yaml
```

State is stored beside the configuration as `<config>.vartma-server.json` and excluded from Git.
Foreground `vartma serve` remains available for containers and service managers.

## Router configuration

Create a local configuration:

```sh
npm run vartma -- init
```

`init` refuses to overwrite any existing file. It creates a localhost development configuration
with the deterministic fake provider, optional database readiness, and gateway authentication
disabled. Enable authentication before exposing the gateway beyond localhost.

Persist an automatic routing mode or a fixed model:

```sh
npm run vartma -- mode balanced
npm run vartma -- mode eco
npm run vartma -- mode quality
npm run vartma -- use fake/default
npm run vartma -- baseline fake/default
```

`use` fixes the live route; `baseline` independently declares the model used for cost/savings
comparison. Analytics do not invent a baseline when none is configured.

Add a provider from a YAML or JSON definition, toggle it, or remove it:

```sh
npm run vartma -- provider add
npm run vartma -- provider add ./provider.yaml
npm run vartma -- provider disable provider-id
npm run vartma -- provider enable provider-id
npm run vartma -- provider remove provider-id
```

With no definition path, `provider add` starts a terminal wizard. It asks for provider type,
credential environment-variable name, every model capability, context/output limits, quality and
latency tiers, regions, and versioned pricing. It does not request or persist an API-key value.
Current provider and model IDs are checked during the wizard so duplicate IDs can be corrected
before the final write. The operator must supply pricing values and their source; the wizard does
not guess current provider prices.

Provider definitions use the same provider object shape as `providers` in
`configs/vartma.example.yaml`. The CLI validates the definition and the complete resulting
configuration, including unique provider/model IDs, model ownership, and availability of the
default model.

Every successful mutation stores an exact restricted-permission backup. Changes form an undo stack:

```sh
npm run vartma -- config undo
```

The write path uses an exclusive lock and atomic rename. Undo verifies SHA-256 hashes of both the
current file and backup. If an external edit occurred after the CLI change, undo stops without
writing so it cannot silently erase that edit. State files, backups, and locks are gitignored.

## Diagnostics

The complete diagnostic command is:

```sh
npm run vartma -- doctor --config ./configs/vartma.example.yaml
```

It reports these independently:

- parsed configuration and default model;
- required provider credential environment variables;
- every enabled provider/model endpoint;
- the configured gateway `/readyz` endpoint;
- a real PostgreSQL `SELECT 1`.

Every network check has a bounded timeout:

```sh
npm run vartma -- doctor --timeout 10000
```

Use `--json` for automation. A failed required check sets a nonzero exit code. Credential values and
the database connection string are never included in the report.

## Operator status

`status` combines local router configuration, bounded gateway readiness, Claude Code integration,
and OpenAI-compatible client state:

```sh
npm run vartma -- status
npm run vartma -- status --json
npm run vartma -- status --offline
```

The report includes the active routing mode/model, enabled provider/model counts, encrypted or
environment credential presence, authentication/database-readiness flags, gateway reachability,
and Claude Code/OpenAI client active/bypassed/drifted state. It omits gateway key values, database
URLs, provider secret values, and credential-bearing backup paths. Missing or invalid
configuration, gateway unavailability, and client drift produce explicit states and a nonzero
result. `--offline` skips the network probe for scripting or configuration-only checks.

## Models and providers

List enabled models and declared capabilities:

```sh
npm run vartma -- models
npm run vartma -- models --json
```

Probe every enabled provider or one provider:

```sh
npm run vartma -- provider test
npm run vartma -- provider test gemini --json
npm run vartma -- provider conformance deepseek --timeout 120000 --json
```

The probe verifies each configured upstream model endpoint. Fake providers are checked in-process.
Missing credentials are reported explicitly and their network probes are skipped. API keys are sent
only in provider-specific headers and are never put in output or URLs.

`provider conformance` is deliberately different: it makes a small real generation request to each
selected model and validates health, token estimation, stream lifecycle, balanced content blocks,
and tool-call JSON. It can incur provider cost and should be run only when intended. Failures expose
stable error categories rather than raw provider messages or credentials.

## Trace inspection

Inspect a persisted request:

```sh
npm run vartma -- trace <request-id>
npm run vartma -- trace <request-id> --json
```

The trace contains:

- status, timing, selected route, mode, and task classification;
- route candidates/explanation;
- provider attempts and first-token timing;
- fallback switches and triggers;
- token usage, price-book version, and estimated cost.

Prompt content is not stored or returned by this command. Raw request metadata values are omitted;
only metadata key names are shown. Sensitive-looking fields inside diagnostic JSON and provider
error text are redacted before serialization.

## Session inspection

List recent sessions:

```sh
npm run vartma -- sessions
npm run vartma -- sessions --limit 50 --json
```

Inspect one session and its recent requests/outcomes:

```sh
npm run vartma -- sessions <session-id>
```

Token counters and Prisma decimal values are emitted as strings where needed so JSON output is
lossless and does not fail on JavaScript `bigint`.

## Claude Code configuration

The existing safe workflow remains:

```sh
npm run vartma -- configure claude-code
npm run vartma -- status --offline
npm run vartma -- bypass on
npm run vartma -- bypass off
npm run vartma -- configure claude-code --undo
```

See [claude-code.md](./claude-code.md) for scopes, backups, drift detection, and exact rollback.

## OpenAI-compatible client configuration

Manage standard OpenAI client dotenv values without overwriting unrelated entries:

```sh
vartma configure openai --env-path ./.env --mode balanced
vartma status --openai-env-path ./.env --offline
vartma configure openai --undo --env-path ./.env
```

`vartma uninstall` stops only the Vartma-owned managed gateway and restores both managed client
integrations while preserving router configuration, encrypted credentials, and baseline backups.

## Credentials and distribution

`vartma login <provider-id>` stores BYOK credentials in the authenticated encrypted vault. The
master key stays in `VARTMA_MASTER_KEY` (or the configured environment-variable name), not in the
vault or YAML. The globally installable npm package is assembled as a self-contained tarball and
exercised by `npm run smoke:clean-install` in a temporary global prefix.

The checked-in CI workflow runs the build, full tests, lint, formatting, Prisma validation, and CLI
configuration validation on Windows, Linux, and macOS. Those jobs become authoritative
cross-platform evidence when the repository is connected to CI; local Windows success alone is not
reported as proof of the other operating systems.

Publishing the npm package and signed standalone binaries remains a release operation requiring
registry/signing credentials; the source package and clean-install lifecycle are implemented.
