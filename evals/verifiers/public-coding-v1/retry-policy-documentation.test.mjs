import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const text = await readFile("RETRIES.md", "utf8");
assert.ok(text.length >= 700, "documentation is too short");
for (const term of [
  "408",
  "429",
  "503",
  "visible output",
  "tool call",
  "retryAfterMs",
  "30,000",
  "250",
  "0.8",
  "1.2",
  "attempt 2",
  "800 ms",
  "1,200 ms",
  "bounded fallback",
]) {
  assert.ok(text.toLowerCase().includes(term.toLowerCase()), `missing ${term}`);
}
assert.doesNotMatch(text, /TODO/u);
