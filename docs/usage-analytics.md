# Usage, Cost, and Savings Analytics

Section 8 is in progress. The router now records immutable, retry-inclusive attempt usage and
provides authenticated aggregate and per-request query APIs.

## Declare the comparison baseline

Savings are calculated only when the request has a declared baseline model:

```yaml
routing:
  defaultMode: balanced
  defaultModel: fake/default
  baselineModel: fake/default
  priceBookVersion: prices-2026-07-28
```

The default route and cost baseline are separate concepts. Change the baseline safely with:

```sh
npm run vartma -- baseline provider/model
```

The model must be enabled. Removing or disabling a provider that owns the active baseline is
rejected until another baseline is selected. If `baselineModel` is absent, requests still receive
complete usage accounting, but their savings fields are unavailable rather than being compared
against an invented baseline.

## Attempt ledger

Every terminal provider attempt creates one `UsageEvent`, including failed and cancelled attempts.
The event stores:

- provider, router model, and upstream model;
- provider-attempt ID and terminal status;
- input, cached-input, output, and reasoning tokens;
- calculated token cost and separately reserved tool cost;
- price-book version;
- the exact input/cached/output/reasoning rates used;
- price source, effective date, and verification date.

`providerAttemptId` is unique, and no usage-update operation exists. A failed cheap attempt followed
by a successful fallback therefore contributes both attempt costs to the request and session total.
A failure before any usage is observed still receives a zero-token/zero-cost ledger event so the
attempt is not invisible.

Costs currently mean provider-reported token usage multiplied by the stored price snapshot. They
are not presented as reconciled invoice charges. Provider-specific non-token charges can be added
to `toolCost` when an upstream reports them.

## Versioned price books

The first use of a `(priceBookVersion, provider, model)` tuple creates an immutable
`PriceBookEntry`. Reusing that version with different model, rate, date, or source data fails the
write and instructs the operator to create a new version. Historical usage and baselines retain
their calculated costs and rate snapshots, so editing current configuration cannot rewrite past
reports.

Records migrated from the earlier schema retain their historical calculated cost. Their unavailable
rate snapshot is explicitly marked as a legacy value rather than reconstructed.

## Aggregate API

```http
GET /vartma/v1/usage
```

The endpoint uses the normal router API-key authentication when authentication is enabled.

Query parameters:

- `from`: inclusive ISO-8601 timestamp or date;
- `to`: exclusive ISO-8601 timestamp or date;
- `provider`;
- `model`;
- `routing_mode`: `quality`, `balanced`, `eco`, or `fixed`;
- `session_id`;
- `group_by`: `provider`, `model`, `routing_mode`, or `day`.

The default range is the last 30 days and the maximum range is 366 days. Only terminal requests are
included. Provider/model filters select requests that used the matching attempt; all attempts for
those requests remain in the total so fallback cost cannot disappear from savings.

Example:

```sh
curl "http://127.0.0.1:8080/vartma/v1/usage?group_by=model" \
  -H "x-api-key: $VARTMA_API_KEY"
```

The response separates:

- all terminal request/attempt/token totals;
- cost from all attempts;
- cost specifically from failed/cancelled attempts;
- requests with a declared, comparable baseline;
- baseline cost and retry-inclusive savings for only that comparable set;
- each baseline model and price-book version used;
- the requested routing distribution.

All monetary and token totals are strings where necessary for lossless JSON. A null savings
percentage means there was no nonzero comparable baseline.

## Per-request API

```http
GET /vartma/v1/usage/requests/{request_id}
```

This returns the declared baseline, every attempt ledger event, exact rate evidence, actual
retry-inclusive attempt cost, failed-attempt cost, and savings. Prompt and generated content are not
queried or returned.

## Current validation boundary

The Prisma schema and migration are locally generated and validated, and unit/API tests cover
failed-attempt charging, immutable price conflicts, baseline isolation, aggregation, authentication,
range validation, and secret-free results. A live migration run against Docker PostgreSQL remains
pending because Docker Desktop is not currently running in this environment.
