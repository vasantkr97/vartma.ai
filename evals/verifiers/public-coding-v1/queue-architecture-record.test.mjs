import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const text = await readFile("ADR.md", "utf8");
assert.ok(text.length > 2200, "ADR is not substantive");
for (const heading of [
  "decision",
  "ordering",
  "idempotency",
  "retries",
  "dead letters",
  "backpressure",
  "observability",
  "recovery",
  "rejected alternatives",
]) {
  assert.ok(text.toLowerCase().includes(heading), `missing ${heading}`);
}
for (const claim of [
  "at-least-once",
  "tenant",
  "partition",
  "acknowledge",
  "jitter",
  "trace ID",
  "RPO",
  "RTO",
  "fence",
  "exactly-once",
]) {
  assert.ok(text.toLowerCase().includes(claim.toLowerCase()), `missing ${claim}`);
}
assert.doesNotMatch(text, /TODO/u);
