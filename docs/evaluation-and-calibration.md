# Evaluation and calibration

Vartma routing can use versioned fixed-model evaluation evidence instead of treating a manually
assigned quality tier as measured success. Evaluation records are written to JSON Lines for
portable reproduction and, by default, persisted transactionally in PostgreSQL for the operator
console and durable comparison history.

## Fair comparison contract

Every record declares the dataset version and SHA-256 digest, harness version, prompt-template
version, timeout, retry limit, output limit, and whether prompt caching was enabled. The digest
covers the suite manifest, every visible fixture file, and every hidden verifier file. `vartma eval
summarize` reports a comparison as valid only when every target used the same settings and task-ID
multiset. Cost is the sum of all actual provider attempts, including failed attempts; it is not a
price-list estimate for the final answer.

Required record shape:

```json
{
  "runId": "terminal-bench-2026-08-24",
  "taskId": "task-001",
  "taskClass": "debugging",
  "environment": {
    "dataset": "terminal-bench",
    "datasetVersion": "2.0",
    "datasetDigest": "sha256:4f4c8a7c0e2f9f31d77b49c30f4ec8e096ef076394cb9b75bde16f4968d9f227",
    "harnessVersion": "vartma-eval-v1",
    "promptTemplateVersion": "coding-agent-v1",
    "timeoutMs": 900000,
    "maxAttempts": 3,
    "cacheEnabled": true,
    "maxOutputTokens": 4096
  },
  "target": { "kind": "fixed", "model": "anthropic/claude-sonnet" },
  "selectedModel": "anthropic/claude-sonnet",
  "success": true,
  "attempts": 1,
  "latencyMs": 84231,
  "actualCostUsd": "0.4128",
  "inputTokens": 18000,
  "cachedInputTokens": 12000,
  "outputTokens": 3200,
  "reasoningTokens": 0,
  "completedAt": "2026-08-24T10:00:00.000Z"
}
```

Router targets use `{"kind":"router","mode":"balanced"}` or Eco/Quality. Fixed records must
select exactly the declared target model. Calibration intentionally uses only fixed-model results;
attributing a routed task's final success to one intermediate model would bias the profile.

## Public corpus and matrix command

`evals/suites/public-coding-v1.yaml` contains 20 independent coding tasks covering all 15 router
task classes. Each original fixture must fail and each held-out reference solution must pass its
hidden verifier. Validate that invariant locally without provider cost:

```sh
npm run smoke:benchmark-corpus
```

Run fixed baselines, Balanced, and Eco under one manifest and one dataset digest. The first fixed
model is the default frontier baseline; use `--baseline` to select another supplied fixed model:

```sh
npm run eval:matrix -- \
  --fixed anthropic/claude-frontier \
  --fixed deepseek/coding-model \
  --baseline anthropic/claude-frontier \
  --modes balanced,eco \
  --config ./vartma.yaml
```

Use `--plan` to print the exact dataset digest, task count, targets, and baseline without making a
provider request. A real run creates a new `eval-results/matrix-*` directory containing separate
per-target JSONL, combined `results.jsonl`, `manifest.json`, and `report.json`. Failed coding tasks
are valid benchmark outcomes and do not stop later targets; infrastructure or comparability
failures do. The manifest also records the source commit and whether tracked files were dirty, so a
published result cannot silently imply it came from an unmodified release.

## Individual commands

```sh
vartma eval run ./evals/suites/public-coding-v1.yaml \
  --target fixed:anthropic/claude-sonnet \
  --output ./fixed-sonnet.jsonl \
  --config ./vartma.yaml

vartma eval run ./evals/suites/public-coding-v1.yaml \
  --target router:balanced \
  --output ./balanced.jsonl \
  --config ./vartma.yaml

vartma eval summarize ./results.jsonl --baseline fixed:anthropic/claude-sonnet
vartma eval summarize ./results.jsonl --baseline fixed:anthropic/claude-sonnet --json

vartma eval calibrate ./results.jsonl \
  --calibration-version terminal-bench-2026-08-24 \
  --output ./calibration.json \
  --config ./vartma.yaml \
  --apply
```

`eval run` requires the configured PostgreSQL database by default and stores the run, target,
benchmark-environment identity, per-task success, selected model, attempts, actual cost, tokens, and
latency. Use `--no-persist` only for an intentional file-only run. A run is persisted atomically and
can be retried idempotently by run/task identity.

Each suite declares `maxOutputTokens` (default 4096). It is sent to the gateway and included in the
benchmark-environment identity, so runs with different output limits are never reported as directly
comparable. Set it no higher than the smallest model output limit in a comparison matrix.

`eval run` uses a LangGraph workflow with explicit model, tool, verification, and terminal states.
Each task is copied into a disposable directory. The built-in agent can read, list, write, or delete
visible files within that directory and can execute only commands allowlisted by the suite;
commands run without a shell and receive a minimal environment that excludes provider and router
secrets. Held-out verifier files are installed only after the final model turn, immediately before
trusted verifier commands execute. Successful workspaces are removed; failed workspaces are
retained for diagnosis, and `--keep-workspaces` retains all of them.

The result is rejected if the gateway usage ledger has no completed request or provider attempt.
Therefore `actualCostUsd`, tokens, and attempts are derived from recorded upstream usage rather than
from the selected model's price declaration alone. Run fixed and routed targets against the same
suite file, then concatenate their JSONL outputs before `eval summarize`.

The repository retains `evals/suites/smoke.yaml` as a one-task deterministic harness check. It
proves the basic agent/tool/verifier/usage pipeline but is intentionally too small for a quality or
savings claim. `public-coding-v1.yaml` supplies the larger versioned corpus; its existence and
reference integrity still do not substitute for real fixed and routed provider results.

Calibration application uses the same file lock, backup, drift detection, and undo mechanism as
other Vartma configuration changes:

```sh
vartma config undo --config ./vartma.yaml
```

The generated profile contains per-model and per-task success rate, average attempts, sample size,
and median latency with source provenance. Small samples are shrunk toward a task-aware prior;
`routing.calibration.priorSampleSize` controls that strength. The router explanation states whether
its success estimate came from task evaluation, model-wide evaluation, or the uncalibrated quality
prior.

This pipeline makes results reproducible; it does not itself constitute benchmark evidence. Do not
publish a quality or savings claim until real fixed and routed runs pass the fairness checks.
