# OpenAI-Compatible Ingress and Broader Providers

Section 6 adds two OpenAI-compatible client APIs and two additional upstream families without
creating a second routing path.

## Client endpoints

Both endpoints use the same authentication, canonical request, task classifier, model registry,
session state, route explanation, fallback budget, circuit breakers, attempt ledger, and response
headers as `/v1/messages`.

### Configure an OpenAI-compatible coding client

Vartma can safely manage the three standard dotenv values used by OpenAI-compatible clients:

```sh
vartma configure openai --config ./vartma.yaml --env-path ./.env --mode balanced
```

This writes `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`, while preserving unrelated
dotenv entries. Before the first change it creates a permission-restricted baseline backup and a
secret-free ownership record. `vartma status --openai-env-path ./.env` reports whether the managed
values are active or were changed outside Vartma. Restore only Vartma-managed values with:

```sh
vartma configure openai --undo --env-path ./.env
```

`vartma uninstall --openai-env-path ./.env` performs the same restoration as part of a complete
local client disconnect. Backups are retained deliberately. The backup can contain the original
dotenv secrets and must remain private.

### Responses API

```sh
curl http://127.0.0.1:8080/v1/responses \
  -H "authorization: Bearer local-development-key" \
  -H "content-type: application/json" \
  -d '{
    "model": "vartma-balanced",
    "input": "Explain this repository",
    "max_output_tokens": 1024
  }'
```

Set `"stream": true` for OpenAI Responses SSE events. Text, reasoning summaries, function calls,
function-call outputs, images, JSON-object/schema output constraints, usage, cancellation, and
router headers are supported.

The virtual model aliases are `vartma-quality`, `vartma-balanced`, and `vartma-eco`. A configured
model can still be forced with `x-vartma-model`, or selected exactly with `x-vartma-mode: fixed`.

The router requires explicit input history. `previous_response_id` and `conversation` are rejected
because server-managed state belongs to one provider and cannot be moved safely when the next turn
routes elsewhere.

The portable router endpoint is stateless: `store` and `background` must remain `false`.
Provider-owned `include` expansions and `max_tool_calls` are rejected because the router cannot
guarantee equivalent behavior after a provider switch.

Function tools are portable. OpenAI-hosted built-in tools such as web search, file search, computer
use, hosted MCP, and code interpreter are not yet portable and are rejected by request validation.
When the selected upstream is native OpenAI, unknown current/future Responses fields are preserved,
while router-controlled `model`, `input`, streaming, and storage fields remain authoritative.

### Chat Completions

```sh
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "x-api-key: local-development-key" \
  -H "content-type: application/json" \
  -d '{
    "model": "vartma-eco",
    "messages": [{"role": "user", "content": "Summarize this function"}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

The compatibility layer supports system/developer/user/assistant/tool messages, text and URL/data
images, function tools and tool results, structured output, standard streamed deltas, final usage,
and `[DONE]`. It returns OpenAI-shaped errors.

Only one choice is generated. Legacy `functions`/`function_call`, audio generation, logprobs,
provider-hosted tools, and service-tier guarantees are outside the portable contract.

## Generic OpenAI-compatible upstream

Provider type `openai-compatible` targets `/v1/chat/completions`, which is the most broadly
implemented local/hosted compatibility surface:

```yaml
- id: local
  type: openai-compatible
  enabled: true
  baseUrl: http://127.0.0.1:8000
  apiKeyEnv: LOCAL_MODEL_API_KEY
  models:
    - id: local/default
      provider: local
      upstreamModel: the-model-name-served-by-your-endpoint
      # Capabilities, limits, quality tier, latency tier, and pricing follow.
```

The adapter sends a bearer token. For a local server that ignores authentication, set
`LOCAL_MODEL_API_KEY` to a non-secret placeholder. Do not copy the example model capabilities or
zero cost into production unless they describe the actual deployment. GPU depreciation, power,
hosting, and operations are real local-inference costs.

The adapter translates:

- canonical system/user/assistant and tool history to chat messages;
- text and URL/base64 images;
- function definitions, forced/required/automatic tool choice, and partial argument streams;
- JSON-object and JSON-schema constraints;
- compatible reasoning-summary extensions;
- finish reasons and detailed usage where the server provides them.

Compatibility servers vary. Run conformance checks against every exact server/model version before
enabling it in routing.

### Named compatible provider profiles

For APIs that implement the OpenAI Chat Completions protocol, set `type: openai-compatible` and one
of the built-in profiles. The profile supplies the official endpoint dialect; the operator still
declares exact model IDs, measured capabilities, limits, and current prices:

| Family              | Profile    | Default API root                     | Chat path              |
| ------------------- | ---------- | ------------------------------------ | ---------------------- |
| Kimi / Moonshot     | `kimi`     | `https://api.moonshot.ai`            | `/v1/chat/completions` |
| DeepSeek            | `deepseek` | `https://api.deepseek.com`           | `/chat/completions`    |
| GLM / Z.ai          | `zai`      | `https://api.z.ai/api/paas/v4`       | `/chat/completions`    |
| Grok / xAI          | `xai`      | `https://api.x.ai`                   | `/v1/chat/completions` |
| Ollama              | `ollama`   | `http://127.0.0.1:11434`             | `/v1/chat/completions` |
| vLLM / other server | `generic`  | required operator-supplied `baseUrl` | configurable           |

The Ollama profile defaults to `authentication: none`. A generic local vLLM-compatible server can
also opt out of bearer authentication explicitly. Hosted compatible providers default to bearer
authentication and still require `apiKeyEnv` or an encrypted `credentialRef`.

```yaml
authentication: none
```

Example provider definition:

```yaml
id: deepseek
type: openai-compatible
profile: deepseek
enabled: true
apiKeyEnv: DEEPSEEK_API_KEY
models:
  - id: deepseek/v4-flash
    provider: deepseek
    upstreamModel: deepseek-v4-flash
    enabled: true
    capabilities:
      text: true
      vision: false
      streaming: true
      tools: true
      structuredOutput: true
      reasoning: true
    contextWindow: 1000000
    maxOutputTokens: 384000
    qualityTier: 3
    expectedLatencyTier: 2
    pricing:
      currency: USD
      effectiveFrom: 2026-04-24
      verifiedAt: 2026-08-24
      source: https://api-docs.deepseek.com/quick_start/pricing
      inputPerMillion: 0.14
      cachedInputPerMillion: 0.0028
      outputPerMillion: 0.28
```

Add it with `vartma provider add ./deepseek.yaml`, then store its key with
`vartma login deepseek --from-env DEEPSEEK_API_KEY`. Current official references confirm
DeepSeek's `/chat/completions`, Z.ai's `/chat/completions`, xAI's `/v1/chat/completions`, and
Ollama's compatible `/v1/chat/completions` surfaces. Recheck provider documentation before every
price-book update because aliases, limits, and prices can change independently of Vartma.

The automated participation test starts a real local HTTP compatibility endpoint, routes a request
through the gateway, and verifies that a tools-required request is rejected before the
tools-disabled upstream is contacted.

## Native Gemini upstream

Provider type `gemini` uses the Gemini Developer API's SSE
`models.streamGenerateContent` endpoint:

```yaml
- id: gemini
  type: gemini
  enabled: true
  apiKeyEnv: GEMINI_API_KEY
  models:
    - id: gemini/gemini-3.6-flash
      provider: gemini
      upstreamModel: gemini-3.6-flash
      # Capabilities, limits, quality tier, latency tier, and current prices follow.
```

The API key is sent through `x-goog-api-key`, never in the URL. The adapter supports system
instructions, explicit multi-turn history, text, inline/URI images, function declarations/calls/
responses, tool IDs, structured JSON, streamed text, thinking summaries/signatures, safety finish
reasons, and Gemini usage metadata.

Gemini thought signatures are returned as opaque signed reasoning. When a tool loop comes back
through an Anthropic-format client, the signature is reattached to the following Gemini function
call. Hidden reasoning text is never made portable across providers.

Gemini 3.x deprecates sampling parameters such as `temperature`; the adapter omits temperature for
configured Gemini 3 models even when a portable client supplied it.

The example uses `gemini-3.6-flash`, a stable model documented on 2026-07-21 with a one-million-token
context window and 64k maximum output. Prices and model lifecycle data are configuration and must be
re-verified before production.

## Provider conformance

`runProviderConformance` in `@vartma/providers` executes a canonical request and checks:

- configured health;
- nonnegative finite token estimates;
- exactly one start and one terminal event;
- balanced content/tool block lifecycles;
- valid accumulated JSON for every tool call.

It performs a real model request when used with a live adapter, so operators should run it
deliberately against a low-cost fixture. The automated suite runs it against the deterministic fake
provider and uses mocked native streams for Anthropic, OpenAI, Gemini, and generic-compatible
adapters. The ingress suite also exercises Responses JSON/SSE and Chat Completions through the
official OpenAI Node SDK.

## Remaining boundaries

- Exact provider tokenizers are not yet used for preflight estimates.
- Gemini's newer stateful Interactions API is not used because the router needs explicit portable
  history. The adapter uses the documented stateless streaming content endpoint.
- Provider-hosted tools are not translated; function tools owned by the calling agent are.
- A remote URL supplied as Gemini `fileData` must be accessible and accepted by Gemini. Base64 is
  the deterministic portable image option.
- Some OpenAI-compatible servers do not implement tools, JSON schema, usage chunks, multimodal
  input, or `max_completion_tokens`. Declare only measured capabilities.

## Official references

- <https://platform.openai.com/docs/api-reference/responses>
- <https://platform.openai.com/docs/api-reference/responses-streaming>
- <https://platform.openai.com/docs/api-reference/chat/create>
- <https://ai.google.dev/api/generate-content>
- <https://ai.google.dev/gemini-api/docs/latest-model>
- <https://ai.google.dev/gemini-api/docs/pricing>
- <https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/>
- <https://api-docs.deepseek.com/guides/function_calling/>
- <https://docs.z.ai/api-reference/llm/chat-completion>
- <https://docs.x.ai/developers/rest-api-reference/inference/chat>
- <https://docs.ollama.com/api/openai-compatibility>
