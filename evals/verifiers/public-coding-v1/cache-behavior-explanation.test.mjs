import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const explanation = await readFile("EXPLANATION.md", "utf8");
assert.ok(explanation.length > 1100, "explanation is too short");
for (const term of [
  "fresh hit",
  "stale-while-revalidate",
  "inFlight",
  "coalesces",
  "different keys",
  "finally",
  "background refresh",
  "hard miss",
  "10,900",
  "12,000",
  "15,001",
]) {
  assert.ok(explanation.toLowerCase().includes(term.toLowerCase()), `missing ${term}`);
}
const cacheSource = await readFile("cache.mjs", "utf8");
assert.match(
  cacheSource,
  /export function createCache\(loader, \{ ttlMs, staleMs, now = Date\.now \}\)/u,
);
assert.match(cacheSource, /void refresh\(key\)\.catch\(\(\) => undefined\)/u);
assert.match(cacheSource, /return refresh\(key\)/u);
