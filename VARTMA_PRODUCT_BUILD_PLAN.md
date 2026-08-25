# Vartma.ai Product Build Plan

**Status:** Living implementation plan — goal-scope platform implemented; external parity evidence pending
**Primary objective:** Build the working multi-model router first, then add the surrounding product  
**Target:** At least 98% of the externally observable routing functionality demonstrated by Entelligence
**Planning assumption:** We are reproducing the demonstrated behavior, not any private implementation or unpublished routing algorithm

---

## 1. Executive decision

The product is feasible.

The first product milestone will not include subscriptions, a payment gateway, enterprise SSO, sales tooling, or complex multi-region infrastructure. It will deliver the part that creates the actual value:

> A coding agent sends a request to our gateway, and our router selects the least expensive eligible model that can complete the task at the required quality, preserves the agent's streaming and tool-calling behavior, escalates when necessary, and records the reason and cost of every decision.

The router will not be Claude-only or OpenAI-only. It will be model-agnostic and provider-agnostic.

It will ultimately route between:

- Anthropic models.
- OpenAI models.
- Google Gemini models.
- Kimi/Moonshot models.
- DeepSeek models.
- GLM models through Z.ai.
- Grok models through xAI.
- Local Ollama models.
- Mistral models.
- Models exposed through AWS Bedrock, Google Vertex AI, or Azure.
- Any compatible hosted endpoint.
- Locally or privately hosted models through an OpenAI-compatible endpoint such as vLLM.

“Any model” means any model that:

- Has an accessible API or inference endpoint.
- Has an implemented provider adapter.
- Supports the capabilities required by the request.
- Is permitted by the active organization policy.

---

## Current implementation status

Updated: 2026-08-25

| Section                                                       | Status                                                   | Evidence                                                                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Section 0 — Foundation and specifications                     | Implemented and locally validated                        | npm workspace, strict TypeScript, Prisma schema/client, configuration, CI, Docker Compose, documentation                                                                                         |
| Section 1 — Gateway skeleton and Anthropic-compatible ingress | Implemented and locally validated                        | Express gateway, fake provider, `/v1/messages`, JSON/SSE translation, tools, auth, cancellation, readiness, metrics, golden tests                                                                |
| Section 2 — Anthropic and OpenAI provider adapters            | Implemented and locally validated                        | Native Messages/Responses adapters, text/tools, usage ledger, stable errors, cancellation, deadlines, bounded retries                                                                            |
| Section 3 — Working routing engine                            | Implemented and locally validated                        | Registry, all filters, deterministic classifier, four modes, config-driven scoring/cost, explainable persisted decisions                                                                         |
| Section 4 — Session routing, fallback, and escalation         | Implemented and locally validated                        | Sticky sessions, hysteresis, bounded safe fallback, model/provider circuits, outcomes, persisted switches                                                                                        |
| Section 5 — Claude Code integration                           | Implemented and locally validated                        | Current beta protocol, setup/bypass/undo, 20-turn session test, two provider families, real Claude Code 2.1.212 `Read` tool loop                                                                 |
| Section 6 — Generic endpoints and broader models              | Implemented and locally validated                        | Responses and Chat ingress, official OpenAI SDK, Gemini and generic-compatible adapters, local HTTP participation, conformance                                                                   |
| Section 7 — CLI completion and operator experience            | Implemented and locally validated                        | Encrypted BYOK, safe setup/undo/uninstall, managed lifecycle, diagnostics, OpenAI/Claude client configuration, clean npm install                                                                 |
| Section 8 — Usage, cost, and savings analytics                | Implemented and locally validated                        | Retry-inclusive ledger, declared baseline, immutable price evidence, aggregate/request APIs, spend and savings console                                                                           |
| Section 9 — Evaluation platform and router calibration        | Platform and public corpus proven; live evidence pending | LangGraph agent/tool/hidden-verifier harness, digest-bound persistence, 20-task/all-class reference-verified corpus, fair matrix runner, and calibration; real multi-provider matrix not yet run |
| Section 10 — React operator console                           | Implemented and locally validated                        | Providers, models, routing decisions, sessions, spend, savings, evaluations, failures, health, and calibration                                                                                   |
| Section 11 — Production hardening                             | Self-contained gates proven; external review pending     | Encrypted transcripts, mixed-stream PostgreSQL soak, recovery drill, load/security gates, hardened Compose, incident runbook, and green remote OS/DB matrix; signing/review remain               |
| Section 12 — Commercial platform                              | Excluded from current goal                               | Payments, subscriptions, enterprise SSO/SCIM, and marketplace billing are intentionally out of scope                                                                                             |

Current verification: 50 test files and 254 tests pass. Build, strict type checking, lint,
formatting, Prisma generation/validation, full-tree and production dependency audits, router configuration
validation, concurrent load smoke, isolated global-package installation, and the offline
real-Claude-Code smoke test pass locally. The official OpenAI Node SDK passes both
Responses JSON/SSE and Chat Completions requests against the router. Native Gemini and a local
OpenAI-compatible server participate through real HTTP mock-provider boundaries, and unsupported
model capabilities are rejected before contacting the upstream.

The hardened Docker Compose definition, production image, one-shot migration service, and all ten
migrations pass locally against disposable PostgreSQL 17. The healthy containerized gateway routes
and persists a request, redacts its gateway key in logs, and tears down cleanly. CI provisions
PostgreSQL, applies migrations, starts the managed gateway, routes a database-backed request, and
builds the runtime image. [GitHub Actions run 32816599375](https://github.com/vasantkr97/vartma.ai/actions/runs/32816599375)
passes the complete Ubuntu, macOS, Windows, and PostgreSQL integration matrix.

The parity goal is not yet proven complete. It still requires real authenticated calls across the
named provider families, a sufficiently large identical-task fixed-versus-Balanced-versus-Eco
benchmark, and measured quality/cost results. No source-level or mock test can substitute for those
external results.

---

## 2. Product goals

### 2.1 Primary goals

1. Route coding-agent requests across multiple model providers.
2. Support Claude Code through an Anthropic-compatible gateway.
3. Support OpenAI-compatible agents and SDKs.
4. Preserve streaming, tools, images, structured outputs, errors, and usage information.
5. Select models using task requirements, expected quality, price, latency, and provider health.
6. Keep a session on one model when appropriate.
7. Escalate to a stronger model when the current model is demonstrably struggling.
8. Provide Quality, Balanced, Eco, and Fixed routing modes.
9. Record every route decision and make it explainable.
10. Measure real cost and compare it against a declared baseline model.
11. Evaluate routing quality using reproducible coding tasks.
12. Allow manual model selection and immediate router bypass.

### 2.2 Non-goals for the working-router milestone

The following are intentionally deferred until the core router is proven:

- Payment gateway.
- Subscription plans.
- Public self-service billing.
- Tax and invoicing automation.
- Sales CRM integrations.
- SAML SSO and SCIM.
- SOC 2 certification work.
- Multi-region active-active deployment.
- Customer-managed encryption keys.
- A managed GPU fleet.
- Fine-tuning foundation models.
- Training our own large language model.
- Mobile applications.

These items are deferred, not excluded from the eventual product.

---

## 3. What counts as 90% functional parity

The target is **at least 90% working-product parity with Entelligence Vartma.ai**.

It does not mean:

- 90% of our own roadmap is finished.
- 90% visual similarity.
- 90% of files or code have been written.
- A gateway that merely forwards requests to several models.

It means that, when the finished product is exercised like Entelligence's router, at least 90 of
the 100 weighted behavior points below must work and must be supported by tests, traces, benchmarks,
or operator evidence. We can reproduce public/observable behavior; we cannot claim their private
classifier, training data, internal thresholds, or source code.

The public comparison baseline is Entelligence's Vartma.ai page and launch material:

- <https://entelligence.ai/vartma-ai>
- <https://entelligence.ai/blogs/entelligence-vartma-ai-frontier-quality-coding-agents-at-half-the-cost>

### 3.1 Weighted Entelligence parity scorecard

| Entelligence working behavior                                                                  |  Weight | Evidence required in our product                                                                                 |
| ---------------------------------------------------------------------------------------------- | ------: | ---------------------------------------------------------------------------------------------------------------- |
| Existing coding agents work transparently through one endpoint; streaming/tools remain valid   |      14 | Real Claude Code plus OpenAI-client repository tasks, long tool loops, protocol and cancellation tests           |
| Per-turn local task/trace analysis completes in under 50 ms and recognizes subtask/turn intent |      10 | Latency benchmark plus classification corpus covering explore, edit, test, debug, design, and subagents          |
| Cheap, mid, and frontier lanes route to the least costly model that clears the quality floor   |       8 | Lane policy tests and route traces across at least six materially different candidates                           |
| Routing balances measured quality, latency, actual spend, capability, and availability         |       8 | Versioned model measurements, cost calculations, health inputs, and explainable decisions                        |
| Sessions remain pinned when useful and model switching accounts for warm/cold prompt caches    |      10 | Cache-aware hysteresis tests, per-model cache accounting, and long-session cost traces                           |
| Context survives provider switches, with valid tools/reasoning and compressed long transcripts |      10 | Cross-provider task tests, transcript compaction, tool-pair validation, and no hidden-reasoning leakage          |
| The router detects stalled progress/failure from the trace and escalates, then de-escalates    |      12 | Repeated-identical-failure/progress tests, expiring stuck verdicts, escalation and recovery benchmark            |
| Provider failure triggers bounded compatible failover without replaying completed side effects |       7 | Outage/rate-limit/timeout/circuit tests and side-effect safety tests                                             |
| Balanced matches the declared frontier baseline while reducing real provider cost              |       8 | Reproducible repository benchmark with pass counts, billed cost, cache cost, retry cost, and statistical caveats |
| Eco delivers a lower-cost/lower-quality operating point that remains useful                    |       5 | Same benchmark and cost-per-solved-task report                                                                   |
| BYOK self-hosting, local retention controls, auditability, and policy controls work            |       4 | Deployment test, secret/privacy checks, audit records, allow/deny/budget policy tests                            |
| Spend and routing insights work by request, model, agent/session, and team                     |       2 | Reconciled usage ledger APIs and dashboard reports                                                               |
| CLI install/auth/on/off/status/bypass/diagnostics provide the advertised operator journey      |       2 | Clean-machine Windows/Linux/macOS workflow tests and exact rollback                                              |
| **Total**                                                                                      | **100** | **Parity is achieved only at a verified score of at least 90**                                                   |

### 3.2 Current interpretation

Sections 0–6 implement important mechanics, but they do **not** by themselves establish 90%
Entelligence parity. Section 7 is in progress. The largest remaining parity gaps are:

- a measured sub-50-ms trace classifier rather than mostly heuristic keyword/rule classification;
- autonomous progress/stuck detection from repeated tool/test traces;
- transcript compression and explicit per-model warm/cold cache economics;
- an evaluation corpus proving Balanced quality and Eco cost-per-solved-task behavior;
- six-candidate production conformance with current prices and measured model quality;
- operator analytics, team/policy controls, and complete CLI packaging.

Until those are implemented and benchmarked, progress will be reported as completed sections and
verified behaviors—not as “90% parity achieved.”

### 3.3 Capability delivery map

| Capability                          | Required for 90% parity | First working router | Later product layer |
| ----------------------------------- | ----------------------: | -------------------: | ------------------: |
| Claude Code gateway integration     |                     Yes |                  Yes |                     |
| Anthropic-compatible `/v1/messages` |                     Yes |                  Yes |                     |
| OpenAI-compatible API               |                     Yes |                  Yes |                     |
| Multiple provider adapters          |                     Yes |          Initial set |        Expanded set |
| Streaming response translation      |                     Yes |                  Yes |                     |
| Tool-call translation               |                     Yes |                  Yes |                     |
| Task-aware routing                  |                     Yes |          Rules first |     Learned scoring |
| Session-aware routing               |                     Yes |                Basic |            Advanced |
| Automatic escalation                |                     Yes |                Basic |   Evaluated/learned |
| Provider fallbacks                  |                     Yes |                  Yes |                     |
| Balanced mode                       |                     Yes |                  Yes |  Improved with data |
| Eco mode                            |                     Yes |                  Yes |  Improved with data |
| Quality/performance mode            |                     Yes |                  Yes |                     |
| Fixed-model override                |                     Yes |                  Yes |                     |
| Cost and usage tracking             |                     Yes |                  Yes |                     |
| Explainable route decisions         |                     Yes |                  Yes |                     |
| Model health monitoring             |                     Yes |                  Yes |                     |
| Evaluation framework                |                     Yes |                  Yes |     Expanded corpus |
| CLI installation/configuration      |                     Yes |                  Yes |                     |
| Basic local/admin dashboard         |                     Yes |                   No |                 Yes |
| Team budgets and alerts             |                 Partial |                   No |                 Yes |
| Enterprise SSO/SCIM                 |                      No |                   No |               Later |
| Payment gateway                     |                      No |                   No |               Later |
| Managed open-source GPU hosting     |                      No |                   No |               Later |

The working router is complete when real clients can use it reliably. The 90% Entelligence parity
target is complete only when the weighted scorecard reaches at least 90 with evidence; completing
roadmap sections without that evidence does not count.

---

## 4. Core user journeys

### 4.1 Claude Code

1. The user installs `vartma`.
2. The user runs `vartma login` or configures a local gateway key.
3. The user adds provider credentials.
4. The user selects `balanced`, `eco`, `quality`, or `fixed`.
5. `vartma configure claude-code` updates the appropriate environment/configuration.
6. Claude Code sends its normal Anthropic-format request to our gateway.
7. The gateway normalizes the request.
8. The router chooses an eligible model.
9. The selected provider streams its response.
10. The gateway translates the response back to Anthropic-format events.
11. Claude Code continues its normal tool loop.
12. The user can inspect the route with `vartma trace`.

Anthropic officially documents using Claude Code with an external LLM gateway through
`ANTHROPIC_BASE_URL`:  
<https://code.claude.com/docs/en/llm-gateway>

### 4.2 OpenAI-compatible client

1. The client sends a request to `/v1/responses` or `/v1/chat/completions`.
2. The gateway converts it to the canonical internal protocol.
3. The router may choose OpenAI, Anthropic, Gemini, DeepSeek, or another compatible backend.
4. The response is translated back to the API contract expected by the caller.

### 4.3 Manual override

The user can force:

- A specific provider and model.
- A routing mode.
- A maximum cost.
- A maximum latency.
- A provider allowlist.
- Router bypass.

The automatic router must never prevent a user from selecting a model explicitly.

---

## 5. High-level architecture

```text
Claude Code / Codex-style agent / IDE / SDK / Custom client
                            |
                            v
                 HTTP ingress and authentication
                            |
                            v
              Protocol validation and normalization
                            |
                            v
                 Canonical internal request
                            |
                            v
         Capability filter -> Policy filter -> Health filter
                            |
                            v
               Task classification and estimation
                            |
                            v
            Quality/cost/latency routing decision
                            |
                            v
                 Provider adapter and execution
              /          |          |          \
        Anthropic      OpenAI     Gemini     Generic endpoint
              \          |          |          /
                            v
                Canonical streaming response
                            |
                            v
             Client-specific response translation
                            |
                            v
                     Original client

Every stage emits structured events to:

PostgreSQL usage ledger -> traces -> evaluations -> analytics/dashboard
```

### 5.1 Initial deployment shape

The first deployable router will use:

- One Node.js and TypeScript Express gateway service.
- One Node.js and TypeScript CLI.
- PostgreSQL through Prisma ORM.
- In-memory caches with interfaces that can later use Redis.
- Structured JSON logging.
- OpenTelemetry traces and metrics.
- Docker Compose for local development.
- A single cloud/container deployment for shared testing.

We will not introduce Kafka, Kubernetes, Redis, or separate microservices until traffic or reliability requirements justify them.

The code will still use interfaces and boundaries that allow those components to be added without rewriting routing logic.

---

## 6. Technology decisions

### 6.1 Core runtime

Use **Node.js with TypeScript** for:

- Express gateway.
- Routing engine.
- Provider adapters.
- CLI.
- Streaming proxy.
- Background evaluation workers.

Reasons:

- One language across the gateway, CLI, shared contracts, and dashboard ecosystem.
- Strong async streaming and cancellation primitives.
- Mature official SDK support across model providers.
- Fast product iteration while retaining strict static types.
- Direct access to raw HTTP and SSE behavior where protocol fidelity matters.

Use direct provider SDKs or HTTP clients in the critical request path. LangChain must not hide provider-specific streaming, tool-call, error, rate-limit, caching, usage, or billing information.

### 6.2 Product UI

Use later:

- React.
- Vite.
- TypeScript.

The UI will consume control and analytics APIs exposed by the Express backend.

### 6.3 Data

Use:

- PostgreSQL for configuration, sessions, decisions, usage, and evaluations.
- Prisma ORM for the schema, type-safe database access, and migrations.
- Prisma migrations checked into the repository.
- S3-compatible storage later for large trace/evaluation artifacts.
- Redis later for distributed session caches, quotas, and health state.
- ClickHouse later only if PostgreSQL analytics becomes a bottleneck.

### 6.4 Infrastructure

Initially:

- Docker Compose.
- Docker images.
- One hosted container environment.
- Managed PostgreSQL for shared environments.
- Terraform when the shared deployment begins.

Later:

- Kubernetes only when scaling, tenancy, or availability makes it valuable.

### 6.5 LangChain, LangGraph, and LangSmith

Use these tools only where they add measurable value:

- **LangChain:** Optional for internal evaluation judges, summarization experiments, and non-critical model experiments. Do not use it to hide the raw provider protocol in the gateway data path.
- **LangGraph:** Used for the implemented evaluation agent's model/tool/verification state machine. The synchronous router remains a deterministic TypeScript pipeline.
- **LangSmith:** Optional, disabled-by-default development/evaluation export. It is never the billing ledger or sole trace store, and prompt/code content must be redacted or explicitly authorized before export.

The router must run completely when all three tools are absent or unavailable.

---

## 7. Repository structure

The initial npm workspace should be organized as:

```text
/
├── apps/
│   ├── gateway/                 # Express gateway/server
│   ├── cli/                     # vartma CLI
│   └── console/                 # React + Vite operator console
├── packages/
│   ├── canonical/               # Provider-neutral request/event types
│   ├── config/                  # Zod configuration loading/validation
│   ├── providers/               # Provider contract and adapters
│   ├── routing/                 # Classification, policy, scoring, health
│   ├── observability/           # Logs, metrics, traces, optional LangSmith
│   └── database/                # Prisma client and repositories
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── configs/
│   ├── vartma.example.yaml
│   └── models.example.yaml
├── evals/
│   ├── tasks/
│   ├── fixtures/
│   ├── runners/
│   └── reports/
├── testdata/
│   ├── anthropic-streams/
│   ├── openai-streams/
│   └── tool-calls/
├── deploy/
│   ├── docker/
│   └── compose/
├── docs/
│   ├── canonical-protocol.md
│   ├── provider-adapter-contract.md
│   ├── routing-policy.md
│   ├── evaluation-method.md
│   └── threat-model.md
├── package.json
├── tsconfig.base.json
└── README.md
```

---

## 8. Canonical protocol

The router must not use one provider's schema as its internal truth. Every request must be converted into a provider-neutral representation.

### 8.1 Canonical request

```typescript
export interface CanonicalRequest {
  requestId: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  turnId?: string;
  messages: CanonicalMessage[];
  tools: ToolDefinition[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  requestedModel?: string;
  routingMode: RoutingMode;
  constraints: RoutingConstraints;
  metadata: Record<string, string>;
}
```

Messages must support:

- System instructions.
- User text.
- Assistant text.
- Images.
- Files or document references.
- Tool calls.
- Tool results.
- Provider reasoning/thinking blocks when legally and technically transferable.

### 8.2 Canonical response events

Streaming is represented as events:

```typescript
export type CanonicalEvent =
  | ResponseStartedEvent
  | ContentStartedEvent
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallStartedEvent
  | ToolCallArgumentsDeltaEvent
  | ToolCallCompletedEvent
  | UsageUpdatedEvent
  | ResponseCompletedEvent
  | ResponseFailedEvent;
```

### 8.3 Translation rules

Every adapter must explicitly document:

- Supported content block types.
- Supported tool semantics.
- Tool-call ID behavior.
- Structured-output support.
- Streaming mapping.
- Finish/stop reason mapping.
- Usage mapping.
- Error mapping.
- Unsupported features.

Unsupported features must fail during eligibility filtering or request validation. They must never disappear silently.

---

## 9. Provider adapter contract

```typescript
export interface ProviderAdapter {
  readonly name: string;
  models(signal?: AbortSignal): Promise<ModelDefinition[]>;
  capabilities(model: string): CapabilitySet;
  estimateTokens(request: CanonicalRequest, signal?: AbortSignal): Promise<TokenEstimate>;
  execute(
    model: string,
    request: CanonicalRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CanonicalEvent>;
  health(model: string, signal?: AbortSignal): Promise<HealthStatus>;
}
```

Each adapter is responsible for:

- Authentication.
- Request conversion.
- Response conversion.
- Streaming.
- Error classification.
- Provider request IDs.
- Rate-limit headers.
- Token usage.
- Cancellation.
- Timeouts.

Adapters must not contain routing policy.

### 9.1 Adapter implementation order

1. Anthropic.
2. OpenAI Responses API.
3. Generic OpenAI-compatible endpoint.
4. Google Gemini.
5. AWS Bedrock.
6. Google Vertex AI.
7. Azure OpenAI/Microsoft Foundry.
8. Provider-specific DeepSeek/GLM adapters only if the generic adapter is insufficient.

The generic OpenAI-compatible adapter unlocks many hosted and self-hosted models with one implementation.

---

## 10. Model registry

Model names, prices, and capabilities change. They must be configuration/data, not hardcoded routing logic.

Example:

```yaml
models:
  - id: anthropic-balanced
    provider: anthropic
    upstream_model: configured-model-name
    enabled: true
    capabilities:
      text: true
      vision: true
      streaming: true
      tools: true
      structured_output: true
      reasoning: true
    context_window: 200000
    quality_tier: 3
    expected_latency_tier: 2
    pricing:
      currency: USD
      effective_from: 2026-07-23
      verified_at: 2026-07-23
      source: provider-pricing-page
      input_per_million: 0
      cached_input_per_million: 0
      output_per_million: 0

  - id: local-economy
    provider: openai-compatible-local
    upstream_model: configured-local-model
    enabled: true
    capabilities:
      text: true
      vision: false
      streaming: true
      tools: true
      structured_output: true
      reasoning: false
    context_window: 131072
    quality_tier: 1
    expected_latency_tier: 1
```

Pricing entries require:

- Effective date.
- Provider.
- Model.
- Input price.
- Cached-input price.
- Output price.
- Reasoning/tool charges where relevant.
- Currency.
- Source or verification date.

Historical usage must retain the price-book version used at execution time.
The routing configuration must version routing policy and pricing independently so either can
change without losing decision reproducibility.

---

## 11. Routing modes

### 11.1 Quality

Prioritize expected task success.

- Prefer the highest evaluated model tier.
- Permit fallback only to equivalent or stronger candidates where possible.
- Use a small cost penalty.

### 11.2 Balanced

Maintain a configured quality floor while reducing cost.

- Default product mode.
- Prefer a mid-tier model for normal coding tasks.
- Use cheaper models for simple work.
- Escalate when failure signals accumulate.

### 11.3 Eco

Minimize expected cost while retaining required capabilities.

- Start with the cheapest eligible model.
- Use stronger models for tasks classified as difficult.
- Escalate more aggressively on clear failure signals.

### 11.4 Fixed

Use exactly the selected model.

- No quality-based switching.
- Infrastructure failover is optional and explicit.
- Required for debugging and customer control.

---

## 12. Routing pipeline

The routing engine follows these steps in order.

### 12.1 Resolve explicit instructions

Check:

- Forced model.
- Forced provider.
- Requested mode.
- Provider/model allowlist.
- Provider/model denylist.
- Maximum cost.
- Maximum latency.
- Data region.

### 12.2 Capability filter

Reject candidates that cannot satisfy:

- Tool calling.
- Structured output.
- Vision.
- Required context window.
- Streaming.
- Required output size.
- Allowed data region.
- Retention/privacy policy.

### 12.3 Health filter

Reject or penalize:

- Open circuit breakers.
- Recent provider overload.
- Exhausted rate limits.
- Excessive latency.
- Invalid credential state.

### 12.4 Task classification

Initial task categories:

- Explanation.
- Code generation.
- Small edit.
- Multi-file feature.
- Debugging.
- Refactoring.
- Test generation.
- Test repair.
- Documentation.
- Repository exploration.
- Architecture/design.
- Security review.
- Migration.
- Long autonomous task.
- Simple tool operation.

Initial classifier inputs:

- Prompt length.
- Message count.
- Estimated input tokens.
- Number of tools.
- Presence of images.
- Turn count.
- Previous model.
- Previous tool errors.
- Previous test failures.
- File count if provided by the client.
- Keywords and explicit task intent.

The first classifier will be deterministic and testable. A trained classifier is added only after enough labeled decisions exist.

### 12.5 Candidate scoring

For candidate model `m`:

```text
score(m) =
    quality_weight  * expected_success(m, task)
  - cost_weight     * expected_cost(m, request)
  - latency_weight  * expected_latency(m)
  - failure_weight  * provider_failure_risk(m)
  - switch_weight   * session_switch_penalty(m)
```

Weights are defined by routing mode and organization policy.

### 12.6 Session hysteresis

Keep the current session model unless:

- It becomes unhealthy.
- It becomes incompatible with the new request.
- The task changes category materially.
- A stronger model has a sufficiently higher score.
- Escalation policy activates.
- The user forces a different model.

This prevents unnecessary model switching and improves prompt-cache reuse.

### 12.7 Explainability

Every decision stores:

- Candidate models.
- Filtered models and reasons.
- Task classification.
- Scores.
- Selected model.
- Routing mode.
- Active policy.
- Previous session model.
- Escalation state.
- Router version.

Example explanation:

```text
Selected: provider-b/model-medium
Mode: balanced
Reason:
  - tools required
  - estimated task class: small_edit
  - passed configured quality floor
  - 61% lower estimated cost than quality baseline
  - session already using this model
Rejected:
  - local-small: tool schema unsupported
  - provider-a/frontier: eligible but unnecessarily expensive
```

---

## 13. Escalation design

Escalation is different from provider fallback.

### 13.1 Infrastructure fallback

Triggered by:

- Connection failure.
- Timeout before meaningful output.
- Provider overload.
- Rate limit.
- Service error.
- Model unavailable.

Action:

- Retry only when safe.
- Respect `Retry-After`.
- Use an equivalent eligible candidate.
- Apply retry budgets.
- Never duplicate completed tool actions.

### 13.2 Quality escalation

Triggered by accumulated evidence:

- Invalid tool arguments more than the allowed threshold.
- Repeated structured-output failure.
- Repeatedly failing the same test.
- Repeating substantially the same unsuccessful action.
- Explicit “stuck” feedback from an agent integration.
- Verifier failure.
- Task scope becomes more difficult.
- User requests escalation.

Action:

- Increase the session escalation level.
- Select the next eligible capability tier.
- Preserve the canonical conversation.
- Record the trigger and outcome.
- Apply cooldown/hysteresis before de-escalating.

### 13.3 Important limitation

A basic HTTP gateway cannot always know whether generated code passed tests. Rich escalation requires one of:

- Client-provided outcome metadata.
- CLI/agent hooks.
- Tool-result inspection.
- An SDK integration.
- An explicit feedback endpoint.

Therefore, the initial system will detect protocol/tool failures and accept feedback through:

```http
POST /internal/v1/sessions/{session_id}/outcomes
```

Later client integrations will send test and task outcomes automatically.

---

## 14. Session model

Store:

- Session ID.
- Client type.
- Current selected model.
- Current escalation level.
- Routing mode.
- Turn count.
- Last task classification.
- Recent failure signals.
- Cost accumulated.
- Token counts.
- Last activity.

Do not store full prompts by default.

Provide configurable trace levels:

- `metadata_only`.
- `redacted`.
- `full_content`.

The default is `metadata_only`.

---

## 15. Usage and cost accounting

For each provider attempt, record:

- Request ID.
- Session and turn.
- Provider.
- Model.
- Provider request ID.
- Start and end time.
- Time to first token.
- Input tokens.
- Cached-input tokens.
- Output tokens.
- Reasoning tokens if reported.
- Tool charges if reported.
- Estimated cost.
- Final status.
- Retry/fallback relationship.

For each routed request, record:

- Baseline model.
- Estimated baseline cost.
- Actual total attempt cost.
- Estimated savings.
- Whether the task succeeded when an outcome is available.

Savings must include retry costs. Failed cheap attempts are not free.

---

## 16. Storage schema

Initial PostgreSQL tables:

### Configuration

- `gateway_api_keys`
- `providers`
- `provider_credentials`
- `models`
- `model_capabilities`
- `price_books`
- `routing_policies`
- `policy_model_rules`

### Runtime

- `sessions`
- `turns`
- `requests`
- `provider_attempts`
- `route_decisions`
- `route_candidates`
- `usage_events`
- `session_outcomes`
- `model_health_samples`

### Evaluation

- `eval_suites`
- `eval_tasks`
- `eval_runs`
- `eval_attempts`
- `eval_results`
- `router_versions`

Secrets must be encrypted before storage. During the first local milestone, provider secrets may come only from environment variables, avoiding database secret storage until KMS support exists.

---

## 17. Public and internal APIs

### 17.1 Client-compatible APIs

```text
POST /v1/messages
POST /v1/responses
POST /v1/chat/completions
```

### 17.2 Router APIs

```text
GET  /vartma/v1/models
GET  /vartma/v1/providers
POST /vartma/v1/decide
GET  /vartma/v1/traces/{request_id}
GET  /vartma/v1/sessions/{session_id}
POST /vartma/v1/sessions/{session_id}/outcomes
POST /vartma/v1/sessions/{session_id}/override
GET  /vartma/v1/usage
GET  /vartma/v1/usage/requests/{request_id}
```

### 17.3 Operations APIs

```text
GET /healthz
GET /readyz
GET /metrics
```

Debug APIs must require an administrative key and must redact secrets and prompt content.

---

## 18. CLI plan

Executable: `vartma`

Required commands:

```text
vartma init
vartma serve
vartma login
vartma provider add
vartma provider test
vartma models
vartma mode quality
vartma mode balanced
vartma mode eco
vartma use <model>
vartma configure claude-code
vartma configure openai
vartma status
vartma doctor
vartma trace <request-id>
vartma sessions
vartma bypass on
vartma bypass off
```

CLI requirements:

- Windows, Linux, and macOS builds.
- Never print provider secrets.
- Store local gateway credentials using operating-system secure storage where possible.
- Back up client configuration before changing it.
- Provide an exact undo command.
- Include connection, authentication, provider, streaming, and database diagnostics.

---

## 19. Observability

### Logs

Every log line must include where applicable:

- Request ID.
- Trace ID.
- Session ID.
- Tenant ID.
- Provider.
- Model.
- Router version.
- Decision code.
- Error class.

Prompts and generated content are excluded by default.

### Metrics

Track:

- Requests per second.
- Active streams.
- Request success rate.
- Provider/model success rate.
- First-token latency.
- Total latency.
- Input/output tokens.
- Cost.
- Savings against baseline.
- Routing distribution.
- Escalation rate.
- Fallback rate.
- Rate-limit errors.
- Circuit-breaker state.
- Tool-call translation errors.

### Tracing

One distributed trace should cover:

```text
ingress
 -> authentication
 -> normalization
 -> classification
 -> routing decision
 -> provider attempt(s)
 -> stream translation
 -> usage persistence
```

---

## 20. Security requirements for the router milestone

Even before enterprise features, the router must include:

- Hashed gateway API keys.
- TLS in shared environments.
- Provider secrets supplied through environment/secret storage.
- Prompt logging disabled by default.
- Secret redaction in logs and errors.
- Request-size limits.
- Header allowlists.
- Timeouts.
- SSRF protections for configurable endpoints.
- Provider endpoint allowlists.
- SQL parameterization.
- Dependency scanning.
- Signed release checksums.
- Administrative APIs separated from client APIs.

No customer prompt should be used for model training or routing-model training without explicit consent.

---

## 21. Evaluation strategy

The router cannot be called intelligent until it is compared against fixed baselines.

### 21.1 Evaluation task format

Each task contains:

```text
task ID
repository fixture or context
prompt
available tools
required capabilities
timeout
success checks
quality rubric
baseline model
maximum attempts
```

### 21.2 Initial task suite

Create tasks for:

- Explain a function.
- Generate a small pure function.
- Fix a localized bug.
- Add unit tests.
- Repair a failing test.
- Refactor one file.
- Implement a multi-file feature.
- Perform repository exploration.
- Produce an architectural plan.
- Find a security defect.
- Use tools correctly.
- Recover from invalid tool output.
- Continue a multi-turn task.

### 21.3 Metrics

Measure:

- Task success.
- Test pass rate.
- Compile success.
- Tool-call validity.
- Human quality score.
- Total input/output tokens.
- Total cost including retries.
- Time to first token.
- Total task duration.
- Escalation count.
- Model switches.

### 21.4 Router acceptance rule

For Balanced mode, define a quality non-inferiority threshold before testing. A suggested starting product target is:

- No more than a small, explicitly chosen success-rate reduction compared with the fixed quality baseline.
- A statistically meaningful cost reduction after counting retries.
- No material increase in unrecoverable tool-call failures.

The exact percentage must be chosen from evaluation data, not marketing goals.

### 21.5 Deployment strategy for routing changes

Every router version moves through:

1. Offline evaluation.
2. Recorded-traffic replay with sensitive content removed.
3. Shadow decision mode.
4. Small canary.
5. Wider rollout.
6. Promotion to default.

Every decision must retain the router version so regressions can be traced and rolled back.

---

## 22. Section-by-section implementation programme

Each section ends with acceptance criteria. We do not move forward while required tests are failing.

### Section 0 — Foundation and specifications

**Estimated effort:** 3–5 working days

Build:

- Initialize Git.
- Create the npm workspace and strict TypeScript configuration.
- Add formatting, linting, testing, and CI.
- Create the repository layout.
- Define canonical request/event types.
- Write the provider adapter contract.
- Write the initial model registry schema.
- Create Docker Compose with PostgreSQL.
- Create the Prisma schema and client package.
- Add configuration validation.

Acceptance:

- `npm test` passes.
- CI runs on every change.
- Invalid configuration fails with actionable errors.
- The canonical protocol and adapter contract are documented.
- No provider-specific types leak into routing packages.

### Section 1 — Gateway skeleton and Anthropic-compatible ingress

**Estimated effort:** 1–2 weeks

Build:

- HTTP server.
- Authentication middleware.
- `/healthz`, `/readyz`, and `/metrics`.
- Initial `/v1/messages` request validation.
- Anthropic request to canonical conversion.
- Canonical event to Anthropic SSE conversion.
- Request IDs and cancellation.
- Recorded-stream fixtures.

Use a fake provider first so protocol behavior can be tested deterministically.

Acceptance:

- A test client can send a non-streaming request.
- A test client can receive a valid SSE stream.
- Cancellation stops upstream work.
- Malformed requests return compatible errors.
- Golden protocol tests pass.

### Section 2 — Anthropic and OpenAI provider adapters

**Estimated effort:** 2–3 weeks

Build:

- Anthropic provider adapter.
- OpenAI Responses API adapter.
- Text streaming.
- Tool-call streaming.
- Usage capture.
- Error classification.
- Timeouts and safe retries.
- Provider integration test harness.

Acceptance:

- The same canonical request can run on both providers.
- Text responses translate correctly.
- Tool calls and tool results round-trip correctly.
- Provider errors map to stable internal error classes.
- Usage is stored for every completed attempt.
- No secret appears in logs.

### Section 3 — Working routing engine

**Estimated effort:** 2 weeks

Build:

- Model registry.
- Capability filter.
- Health filter.
- Deterministic task classifier.
- Quality, Balanced, Eco, and Fixed modes.
- Cost estimator.
- Candidate scoring.
- Explainable route-decision record.

Acceptance:

- Unit tests cover every filter and routing mode.
- A request requiring tools never reaches a model without tools.
- Fixed mode always respects the explicit model.
- Every decision returns an explanation.
- Price changes require no routing-code changes.

At the end of this section, we have the first real multi-model router.

### Section 4 — Session routing, fallback, and escalation

**Estimated effort:** 2–3 weeks

Build:

- Session state.
- Model stickiness.
- Switch hysteresis.
- Provider circuit breakers.
- Retry budgets.
- Infrastructure fallback.
- Escalation levels.
- Outcome feedback endpoint.
- De-escalation cooldown.

Acceptance:

- Healthy sessions do not switch models unnecessarily.
- Provider outage triggers a compatible fallback.
- Retries cannot loop indefinitely.
- Repeated failure signals escalate capability.
- Every switch stores a reason.
- Completed tool calls are never automatically replayed.

### Section 5 — Claude Code integration

**Estimated effort:** 1–2 weeks

Build:

- Claude Code configuration command.
- Static gateway authentication.
- Dynamic local token support later if required.
- Compatibility tests for representative Claude Code request shapes.
- Tool loop tests.
- Long-session tests.
- Bypass and undo support.

Acceptance:

- Claude Code can complete a real repository task through the gateway.
- At least two different provider families can serve different turns.
- Claude Code tool calls remain valid.
- Streaming remains interactive.
- `vartma bypass on` immediately restores direct behavior.

This is the primary working-router milestone.

**Implemented and verified on 2026-07-28:**

- `vartma configure claude-code` safely manages project-local or user-wide Claude settings.
- Static bearer authentication, baseline/routed backups, drift detection, bypass, re-enable, and
  undo preserve unrelated settings.
- Project-local settings, state, and credential-bearing backups are automatically gitignored.
- The gateway accepts current Claude Code beta request shapes and forwards open-ended
  `anthropic-*` headers and Anthropic request fields.
- `HEAD /`, `/v1/models`, and `/v1/messages/count_tokens` cover Claude Code startup and optional
  discovery behavior.
- Claude's native session header drives router session continuity; a 20-turn tool-history test
  remains stable.
- Native Anthropic Messages and OpenAI Responses adapters can serve different turns in one Claude
  session.
- The locally installed Claude Code 2.1.212 completed a real streamed two-turn `Read` tool loop
  against an ephemeral repository file without contacting a paid provider.
- `vartma bypass on` atomically restores baseline managed settings. A new Claude process uses
  them immediately; an already-running process may require restart because Claude loads environment
  settings at startup.

Operational details and protocol boundaries are documented in `docs/claude-code.md`.

### Section 6 — Generic endpoints and broader models

**Status:** Implemented and locally validated on 2026-07-28

**Estimated effort:** 2–3 weeks

Build:

- `/v1/responses`.
- `/v1/chat/completions`.
- Generic OpenAI-compatible backend.
- Gemini adapter.
- Local vLLM-compatible integration.
- Capability conformance runner.

Acceptance:

- An OpenAI-compatible client can use the router.
- A local model can participate when eligible.
- Gemini participates in at least text and supported tool scenarios.
- Unsupported capabilities are rejected before provider execution.

Evidence:

- The official OpenAI Node SDK completes Responses JSON/SSE and Chat Completions calls through the
  shared router execution path.
- Integration tests route through real local HTTP boundaries to a generic-compatible model and the
  native Gemini adapter.
- Capability preflight tests prove an unsupported tool request does not reach the upstream.
- Provider fixtures cover text, reasoning summaries/signatures, tools, structured output, usage,
  stream lifecycle, errors, and conformance invariants.

### Section 7 — CLI completion and operator experience

**Status:** Implemented and locally validated on 2026-08-24

**Estimated effort:** 1–2 weeks

Build:

- All core CLI commands.
- Provider connectivity tests.
- Configuration backup and restoration.
- Trace inspection.
- Session inspection.
- Doctor command.
- Cross-platform builds.

Acceptance:

- A new developer can configure and run the router from the CLI.
- Diagnostics identify missing keys, unreachable providers, bad models, and database failures.
- Secrets are never printed.
- Configuration changes can be undone.

Implemented so far:

- `doctor` validates configuration, credential presence, exact provider models, gateway readiness,
  and PostgreSQL reachability with bounded timeouts.
- `models` and `provider test` provide human-readable and JSON automation output.
- `trace` and `sessions` inspect the existing Prisma records without returning prompts, raw metadata
  values, database credentials, or provider secrets.
- `init`, provider add/enable/disable/remove, persistent `mode`/`use`, and stacked `config undo`
  validate the complete YAML, preserve comments, lock concurrent writers, create exact backups, and
  stop safely on external drift.
- `provider add` supports both deterministic definition files and an interactive wizard that checks
  existing IDs, collects declared capabilities/limits/pricing, and never requests secret values.
- The CI definition has a fail-independent Windows/Linux/macOS matrix for the build, full suite,
  lint, formatting, Prisma validation, and CLI config validation. Remote results are still required
  before claiming all three operating systems are validated.
- `status` reports sanitized local configuration/routing/provider state, bounded gateway readiness,
  and Claude Code/OpenAI-compatible active/bypassed/drifted state in human or JSON form;
  missing/invalid configuration and network/client failures are represented without serializing
  caught errors.
- Claude Code configuration, status, bypass, and exact rollback are already implemented and tested.
- `login` stores provider keys in an authenticated AES-256-GCM vault whose master key remains
  external. Encrypted references take precedence over environment fallbacks.
- `start`, `stop`, `uninstall`, OpenAI dotenv setup/undo, global npm packaging, and isolated clean
  installation are implemented and tested.

Still required:

- Successful remote Windows, Linux, and macOS CI runs before claiming all three operating systems.
- npm registry publication and release signing credentials for a public release.

### Section 8 — Usage, cost, and savings analytics

**Status:** Implemented and locally validated on 2026-08-24

**Estimated effort:** 1–2 weeks

Build:

- Immutable usage events.
- Versioned price book.
- Baseline cost calculation.
- Retry-inclusive actual cost.
- Usage query APIs.
- Routing distribution reports.

Acceptance:

- Every request cost is traceable to provider usage.
- Savings calculations state their baseline.
- Retries are included.
- Historical costs do not change when the current price book changes.

Implemented so far:

- Every completed, failed, or cancelled provider attempt creates a unique immutable usage event;
  failed attempts increment session cost/token totals and remain included after fallback.
- Each event stores the exact rates, source, effective/verification dates, and price-book version
  used. Conflicting rates under an existing version fail instead of rewriting history.
- An optional, explicitly configured `routing.baselineModel` is estimated independently of the
  selected route and persisted per request. Requests without a baseline are counted but excluded
  from savings rather than compared against an implicit model.
- Authenticated aggregate and per-request APIs report terminal requests, lossless token/cost
  strings, failed-attempt cost, retry-inclusive actual attempt cost, baseline coverage, savings,
  price evidence, and provider/model/mode/day distributions.
- Query ranges default to 30 days, are limited to 366 days, and support provider, model, mode, and
  session filters. Provider/model filters retain every attempt of matching requests so fallback
  cost cannot disappear.

Still required:

- Reconcile token-calculated costs against provider billing exports where providers expose them.
- Add larger-dataset query benchmarks and database-side aggregation/materialization if the measured
  workload requires it.

### Section 9 — Evaluation platform and router calibration

**Status:** Platform implemented; real multi-provider evidence pending

**Estimated effort:** 3–5 weeks initially, then continuous

Build:

- Evaluation task schema.
- Repository fixture runner.
- Test/compile/lint result collectors.
- Model comparison runner.
- Router comparison runner.
- Statistical reports.
- Shadow decisions.
- Router versioning.

Acceptance:

- Fixed-model and routed runs can be compared on identical tasks.
- Reports include success, cost, latency, and escalation.
- Balanced and Eco thresholds are backed by measured data.
- A regressing router version cannot be promoted accidentally.

Implemented:

- Strict versioned YAML suite/task/command schemas and disposable repository fixtures.
- A LangGraph coding agent with confined file tools, allowlisted no-shell commands, post-agent
  hidden verifiers, bounded turns/time, and secret-minimal subprocess environments.
- Actual retry-inclusive usage collection from the gateway ledger, JSONL portability,
  transactional PostgreSQL run/task persistence, summaries, and fixed-model calibration output.
- Fairness checks require identical task-ID multisets, dataset SHA-256 digest,
  dataset/harness/prompt versions, timeout, retry, cache, and maximum-output settings before fixed
  and routed targets are called comparable.
- One shared benchmark deadline reaches in-flight gateway calls. Provider errors and timeouts are
  retained as honest failed results with actual usage, model attribution, and diagnostic workspace
  instead of disappearing from calibration data.

Still required:

- Run the checked-in 20-task, all-class public coding corpus against real fixed baselines,
  Balanced, and Eco.
- Use those results to choose and document the promotion thresholds; no savings/quality claim is
  valid before this evidence exists.

### Section 10 — Dashboard for 90% parity

**Status:** Goal-scope console implemented and locally validated

**Estimated effort:** 3–4 weeks

Build:

- Overview.
- Request trace explorer.
- Model distribution.
- Cost and baseline savings.
- Latency and errors.
- Session view.
- Model registry.
- Policy editor.
- Provider health.
- Evaluation reports.

Implemented:

- React/Vite same-origin console served by Express.
- Dedicated provider, model, routing-decision, session, spend/savings, evaluation, and failure
  views backed by authenticated metadata-only APIs.
- Route explanations, attempt/fallback counts, health, retry-inclusive cost, and calibration sample
  coverage without prompt/response exposure.

Deferred beyond the current read-only goal scope:

- Browser policy editing; CLI configuration mutations remain validated, locked, backed up, and
  exactly undoable.

Acceptance:

- Operators can answer which model was chosen and why.
- Operators can detect unhealthy models.
- Policies can be changed safely and validated.
- Savings and quality are visible together.

### Section 11 — Production hardening

**Status:** Implemented and cross-platform validated where self-contained; external evidence remains

**Estimated effort:** 2–4 weeks initially, then continuous

Build:

- Load tests.
- Soak tests.
- Stream fuzzing.
- Database backup and restoration.
- Release signing.
- Dependency scanning.
- Security review.
- Incident runbooks.
- Config rollback.
- Controlled shared deployment.

Acceptance:

- The gateway meets its stated latency and availability targets under expected load.
- A provider outage does not take down the gateway.
- Database recovery is demonstrated.
- Releases can be rolled back.
- Security findings have owners and resolution dates.

Implemented:

- Bounded 400-request concurrent load smoke with an enforced p95 limit and zero-failure gate.
- PostgreSQL-backed 15-minute mixed JSON/SSE soak: 17,504 requests, 19.4 requests/second, 1,598.3 ms
  p95, 51.8 ms event-loop p99, 392.7 MiB peak RSS, 152.6 MiB database growth, and zero failures.
- Deterministic 200-pattern arbitrary UTF-8 stream fragmentation fuzzing and a 16 MiB SSE-event
  bound.
- Malformed streams, timeouts, cancellation, rate limits, retry/fallback, circuit breaker, and
  no-replay-after-visible-output tests.
- Full-tree and production-only dependency audits with zero known vulnerabilities.
- Encrypted credentials/transcripts, redacted structured logs, required deployment secrets,
  production-dependency-only image, no-new-privileges, and dropped Linux capabilities.
- Live PostgreSQL 17 migration, readiness, persistence, and complete Compose lifecycle proof.
- Fresh-instance custom-format backup/restore proof for all ten migrations, a Vartma session, and
  its authenticated encrypted canonical transcript, plus incident, credential rotation, and
  rollback runbooks.
- Private vulnerability reporting and an owned security-finding response policy.
- Windows/Linux/macOS CI matrix plus a PostgreSQL integration job; all four jobs pass in GitHub
  Actions run `32816599375`.

Still required:

- Complete independent security review and establish signed release/rollback evidence before a
  public production claim. Continue longer production-shaped soak and recovery drills as recurring
  operational evidence.

### Section 12 — Commercial and enterprise product

Begin only after the router is working and evaluated.

Possible work:

- User-facing accounts.
- Organizations and teams.
- Subscription plans.
- Payment gateway.
- Invoices and taxes.
- Budgets and quotas.
- SAML/OIDC SSO.
- SCIM.
- RBAC.
- Audit export.
- Data residency.
- Multi-region operation.
- Private customer deployments.
- Managed open-source inference.

This section is intentionally outside the initial router milestone.

---

## 23. Suggested timeline

For two to four capable engineers:

| Period      | Target                                |
| ----------- | ------------------------------------- |
| Weeks 1–2   | Sections 0–1                          |
| Weeks 3–5   | Section 2                             |
| Weeks 6–7   | Section 3                             |
| Weeks 8–10  | Section 4                             |
| Weeks 11–12 | Section 5: working Claude Code router |
| Weeks 13–15 | Section 6                             |
| Weeks 16–17 | Sections 7–8                          |
| Weeks 18–22 | Section 9                             |
| Weeks 23–26 | Section 10                            |
| Weeks 27–30 | Section 11 and production validation  |

This is approximately:

- Three months to a strong working-router milestone.
- Six to eight months to a broad parity implementation, followed by real-provider evidence needed
  to substantiate the 98% externally observable target.

For one developer, plan for roughly:

- Five to eight months for a robust working router.
- Nine to fifteen months for the implementation, with the 98% claim gated by benchmark evidence.

The schedule assumes experience with Node.js, TypeScript, Express, provider APIs, PostgreSQL, Prisma, and production backend systems. Learning while building will increase it.

---

## 24. Working-router definition of done

The core router is considered working only when all of the following are true:

- Claude Code can use the gateway through a supported configuration.
- Anthropic-format input is accepted.
- At least Anthropic and OpenAI provider families work.
- A generic OpenAI-compatible provider works.
- Streaming text works.
- Tool calls and tool results work.
- Request cancellation works.
- Quality, Balanced, Eco, and Fixed modes work.
- Required capabilities are enforced.
- Sessions remain sticky.
- Provider failures trigger bounded fallback.
- Quality signals can trigger escalation.
- Every decision is explainable.
- Every provider attempt records usage and cost.
- A user can force a model.
- A user can bypass the router.
- Golden, integration, and real-client tests pass.
- Secrets and prompt content are not exposed in default logs.

---

## 25. Ninety-percent parity definition of done

In addition to the working-router criteria:

- Gemini and local/OpenAI-compatible models participate.
- The evaluation platform produces reproducible comparisons.
- Balanced and Eco behavior is calibrated from measurements.
- Route decisions can be inspected through a dashboard.
- Provider/model health is visible.
- Cost and baseline savings are visible.
- Policies can control models, providers, modes, budgets, and latency.
- Long multi-turn agent sessions are tested.
- Model changes and router changes use canary/shadow validation.
- The product has installation, operation, and troubleshooting documentation.
- The router is deployed in a production-like shared environment.
- Load, security, failure, and recovery tests pass.

Payments, subscriptions, SSO, SCIM, and managed GPU hosting are not required for this parity target.

---

## 26. Major risks and mitigations

### Protocol incompatibility

**Risk:** A translated provider response breaks the coding agent's tool loop.

**Mitigation:**

- Canonical protocol.
- Golden SSE fixtures.
- Tool-call conformance tests.
- Explicit capability rejection.

### Cheap-model quality loss

**Risk:** Cost decreases but users retry more often.

**Mitigation:**

- Measure cost per successful task.
- Count retry cost.
- Use quality floors.
- Calibrate with evaluation data.

### Unsafe retries

**Risk:** A retry duplicates a side-effecting tool action.

**Mitigation:**

- Retry primarily before meaningful output.
- Track tool-call IDs.
- Use bounded retry budgets.
- Do not replay completed tool calls automatically.

### Router latency

**Risk:** Routing adds noticeable delay.

**Mitigation:**

- Use local deterministic classification first.
- Cache model health/configuration.
- Keep routing out of external LLM calls.
- Run expensive analysis asynchronously.

### Provider model changes

**Risk:** Aliases, prices, and behavior change.

**Mitigation:**

- Versioned model registry.
- Versioned price book.
- Conformance tests.
- Canary evaluation.

### Insufficient escalation signals

**Risk:** The gateway cannot see whether code passed tests.

**Mitigation:**

- Outcome feedback API.
- Claude Code/agent hooks when available.
- Tool-result inspection.
- CLI/SDK integration.

### Scope expansion

**Risk:** Dashboard, billing, and enterprise work delay the router.

**Mitigation:**

- Complete Sections 0–5 before commercial features.
- Treat Section 5 as the working-router gate.
- Do not begin payment work before evaluation results exist.

---

## 27. Rules for implementation

1. No provider-specific types inside the routing engine.
2. No hardcoded current model names in routing rules.
3. No routing decision without an explanation record.
4. No advertised saving without a declared baseline.
5. No retry loop without a strict budget.
6. No prompt/content logging by default.
7. No adapter is complete without streaming and tool tests.
8. No router change becomes default without evaluation.
9. No dashboard work blocks gateway correctness.
10. No payment work begins before the working-router definition of done.
11. Every section must add tests with its implementation.
12. Every configuration mutation must have validation and rollback.

---

## 28. Immediate next action

Continue **Section 7 — CLI completion and operator experience**.

The next implementation session should produce:

1. OpenAI-client configure/status/bypass/undo support matching the Claude Code safety model.
2. An explicit secure-credential-storage design and `login` workflow.
3. Cross-platform command/path tests and packaged clean-machine installation tests.

Before selecting standalone executable tooling or an npm-global-only distribution strategy, confirm
the packaging target with the user. The internal CLI commands and diagnostics can continue using the
existing Node.js/TypeScript stack without waiting for that distribution decision.

---

## 29. Official implementation references

- Claude Code LLM gateway configuration:  
  <https://code.claude.com/docs/en/llm-gateway>

- Claude Code LLM gateway protocol requirements:  
  <https://code.claude.com/docs/en/llm-gateway-protocol>

- Anthropic Messages API:  
  <https://platform.claude.com/docs/en/api/messages/create>

- Anthropic streaming:  
  <https://platform.claude.com/docs/en/build-with-claude/streaming>

- Anthropic tool-use contract:  
  <https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works>

- Anthropic rate limits:  
  <https://platform.claude.com/docs/en/api/rate-limits>

- OpenAI model and Responses API guidance:  
  <https://developers.openai.com/api/docs/guides/latest-model>

- OpenAI model catalog:  
  <https://developers.openai.com/api/docs/models>

---

## 30. Final product statement

The product we are building is:

> A model-agnostic routing gateway for coding agents that chooses the best eligible model per task and session, translates provider protocols, preserves streaming and tools, escalates when needed, and proves its quality, cost, and reliability through measurable evaluations.

The first priority is the router. Everything else exists to configure, observe, secure, sell, and operate that router.
