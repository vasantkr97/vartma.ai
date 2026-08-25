import assert from "node:assert/strict";
import { LruCache } from "../lru.mjs";

assert.throws(() => new LruCache(0), RangeError);
const cache = new LruCache(2);
assert.equal(cache.set("a", 1), cache);
cache.set("b", 2);
assert.deepEqual(cache.entries(), [
  ["b", 2],
  ["a", 1],
]);
assert.equal(cache.get("a"), 1);
cache.set("c", 3);
assert.equal(cache.has("b"), false);
assert.equal(cache.has("a"), true);
assert.deepEqual(cache.entries(), [
  ["c", 3],
  ["a", 1],
]);
cache.set("a", 9);
assert.deepEqual(cache.entries(), [
  ["a", 9],
  ["c", 3],
]);
assert.equal(cache.size, 2);
assert.equal(cache.delete("c"), true);
assert.equal(cache.delete("missing"), false);
assert.equal(cache.get("missing"), undefined);
