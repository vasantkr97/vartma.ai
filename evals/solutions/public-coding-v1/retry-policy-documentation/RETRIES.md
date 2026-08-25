# Retry policy

## Eligibility and non-replay safety

Vartma retries only HTTP 408, 409, 429, 500, 502, 503, and 504 responses, and only while the
zero-based `attempt` is below `maxAttempts`. It never replays after visible output or after a
completed tool call, because either condition could duplicate user-visible text or side effects.

## Delay calculation

When the provider supplies `retryAfterMs`, the delay is clamped to 0–30,000 ms and takes priority.
Otherwise the base delay is `min(10000, 250 * 2 ** attempt)`. Multiplicative jitter ranges from
0.8 through 1.2 and is injected through `random`, which makes tests deterministic.

For example, attempt 2 has a 1,000 ms base. With `random()` returning 0, the delay is 800 ms; with
0.5 it is 1,000 ms; and with 1 it is 1,200 ms. A `retryAfterMs` value of 45,000 becomes 30,000 ms.

## Operator guidance

Retry spikes should be split by provider and status. Do not increase attempts to mask an outage:
bounded fallback or an open circuit is safer than multiplying cost and latency.
