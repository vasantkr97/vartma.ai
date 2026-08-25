import assert from "node:assert/strict";
import { mapPool } from "../pool.mjs";

let active = 0;
let peak = 0;
const result = await mapPool([30, 5, 20, 1, 10], 2, async (delay, index) => {
  active += 1;
  peak = Math.max(peak, active);
  await new Promise((resolve) => setTimeout(resolve, delay));
  active -= 1;
  return `${index}:${delay}`;
});
assert.ok(peak <= 2, `observed concurrency ${peak}`);
assert.deepEqual(result, ["0:30", "1:5", "2:20", "3:1", "4:10"]);
assert.deepEqual(await mapPool([], 3, async () => 1), []);
await assert.rejects(
  mapPool([1, 2, 3], 2, async (value) => {
    if (value === 2) throw new Error("mapper failed");
    return value;
  }),
  /mapper failed/u,
);
await assert.rejects(
  mapPool([1], 0, async (value) => value),
  RangeError,
);
