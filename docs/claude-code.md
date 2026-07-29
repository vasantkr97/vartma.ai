# Claude Code Integration

Phase 5 connects Claude Code to the router through the Anthropic Messages protocol. The integration
uses Claude Code's documented gateway settings; it does not patch or wrap the Claude executable.

## What is supported

- Authenticated `POST /v1/messages` requests, including `?beta=true`.
- Streaming text, signed thinking, and tool-use events.
- Current and future `anthropic-*` headers.
- Open-ended Anthropic request fields such as `context_management`, `output_config`, prompt-cache
  controls, and future beta fields.
- Claude Code's `x-claude-code-session-id` for routing stickiness and escalation.
- `HEAD /` connectivity probes.
- Optional `GET /v1/models` gateway model discovery.
- Approximate `POST /v1/messages/count_tokens`.
- Quality, Balanced, and Eco virtual model aliases.
- Backup, drift detection, bypass, re-enable, and undo through `vartma`.

The virtual models are:

| Claude Code model        | Router behavior |
| ------------------------ | --------------- |
| `claude-vartma-quality`  | Quality mode    |
| `claude-vartma-balanced` | Balanced mode   |
| `claude-vartma-eco`      | Eco mode        |

These aliases select a routing policy, not a provider. Any eligible configured model can serve the
turn.

## Prerequisites

1. Install Claude Code 2.1.129 or newer if gateway model discovery is required.
2. Configure at least one enabled router model with tools, streaming, context window, and maximum
   output size sufficient for Claude Code. Claude Code currently requests large output budgets, so
   a model with a 4,096-token maximum may be rejected before execution.
3. Set each enabled live provider's API key in the environment named by `apiKeyEnv`.
4. Configure a static router API key under `auth.apiKeys`, or set `VARTMA_API_KEY` while running
   the configuration command.
5. Start the gateway and confirm `GET /readyz` is healthy.

## Configure a project

Project-local configuration is the default and is the safest scope:

```sh
npm run vartma -- configure claude-code \
  --config ./configs/vartma.example.yaml \
  --gateway-url http://127.0.0.1:8080 \
  --mode balanced
```

On PowerShell, write the command on one line or use PowerShell's backtick continuation character.

The command updates `.claude/settings.local.json` and adds these files to `.gitignore`:

```text
.claude/settings.local.json
.claude/.vartma-state.json
.claude/.vartma-backups/
```

It preserves unrelated Claude Code settings and writes a recoverable baseline backup before making
changes. The managed environment is equivalent to:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8080",
    "ANTHROPIC_AUTH_TOKEN": "<router-api-key>",
    "ANTHROPIC_MODEL": "claude-vartma-balanced",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1",
    "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1"
  }
}
```

`ANTHROPIC_AUTH_TOKEN` is sent as a bearer token. The command removes a managed
`ANTHROPIC_API_KEY` while routing is active so Claude Code does not select conflicting
credentials. Subprocess credential scrubbing keeps the router token out of Bash tools, hooks, and
stdio MCP server environments.

To configure the user-wide settings file instead:

```sh
npm run vartma -- configure claude-code --scope user
```

An explicit `--settings-path` is available for automation and tests. When it is used, the caller
owns ignore rules and secret handling for that path.

## Operate and recover

Inspect state without printing credentials:

```sh
npm run vartma -- status
```

Temporarily restore the pre-router Claude settings:

```sh
npm run vartma -- bypass on
```

Re-enable the saved router settings:

```sh
npm run vartma -- bypass off
```

Remove router-managed values and restore their original values:

```sh
npm run vartma -- configure claude-code --undo
```

Add `--scope user` or the same `--settings-path` used during configuration when applicable.
Bypass and undo preserve unrelated settings added after configuration. The baseline backup remains
after undo for manual disaster recovery. Start a new Claude Code process after changing
configuration because an already-running process may retain its startup environment.

If `status` reports `drifted`, a router-managed environment value was edited outside `vartma`.
Review the settings and then either run the configure command again or undo it. The status output
never includes the credential.

## How context survives model switching

Claude Code sends the conversation history on every model request. The gateway normalizes that
history into provider-neutral messages containing:

- user and assistant text;
- tool calls and tool results with stable IDs;
- images;
- signed or redacted thinking blocks as provider-opaque data;
- system instructions and relevant metadata.

The selected adapter rebuilds the target provider's request from this canonical history. The
session ID separately preserves routing state—previous model, escalation level, usage, cost, and
switch hysteresis—but it is not the source of conversational memory.

Provider-private hidden reasoning is not portable. When a turn switches provider families, the
router preserves visible text and the full tool transcript but does not expose or replay hidden
reasoning into another provider. Provider-specific prompt caches also do not transfer, so a switch
can cost more tokens even though conversational context remains intact.

## Protocol behavior

The gateway forwards open-ended `anthropic-*` headers because Claude Code adds beta capabilities
over time. When the selected upstream is Anthropic, the raw validated Anthropic body is retained
and the router only replaces the selected model and enforced execution fields. When another
provider family is selected, supported content is translated through the canonical protocol.

Model discovery returns only IDs beginning with `claude` or `anthropic`, matching Claude Code's
gateway filter. Token counting is currently an estimate from the router's default adapter, not an
exact provider tokenizer result.

Do not set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` if model discovery is required; Claude Code
does not perform discovery when nonessential traffic is disabled.

## Verification

Run the automated compatibility tests:

```sh
npm test
```

Run the real installed Claude Code smoke test:

```sh
npm run smoke:claude-code
```

The smoke test is offline and does not use paid provider credentials. It starts an ephemeral
gateway, asks the real Claude Code executable to call its built-in `Read` tool on a temporary
repository file, receives the tool result in a second routed turn, verifies streamed events, and
removes all temporary files.

Set `CLAUDE_CODE_EXECUTABLE` when `claude` is not on `PATH`. Set
`CLAUDE_SMOKE_LOG_LEVEL=info` only when request diagnostics are needed.

## Current boundaries

- Claude Desktop and remote Claude sessions do not use terminal CLI API-key environment variables.
- Exact token counting awaits provider tokenizer endpoints.
- Anthropic-only beta features may not have an equivalent on non-Anthropic providers. Capability
  filters reject known unsupported requirements; unknown future fields are preserved for
  Anthropic and ignored by adapters that cannot represent them.
- Changing settings does not rewrite the environment of an already-running Claude Code process.
- Dynamic/rotating local gateway credentials and operating-system keychain storage are later CLI
  work. Static tokens are currently stored in Claude's settings and protected by file permissions
  where the operating system supports them.

## Official references

- <https://code.claude.com/docs/en/llm-gateway>
- <https://code.claude.com/docs/en/llm-gateway-protocol>
- <https://code.claude.com/docs/en/env-vars>
- <https://code.claude.com/docs/en/settings>
- <https://code.claude.com/docs/en/authentication>
