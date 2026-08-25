import assert from "node:assert/strict";
import { bucketByUtcDay } from "../buckets.mjs";

const input = [
  "2026-08-25T00:30:00+02:00",
  "2026-08-24T23:00:00Z",
  "2026-08-25T01:00:00-04:00",
  "2026-08-25T05:00:00Z",
];
assert.deepEqual(bucketByUtcDay(input), {
  "2026-08-24": [input[0], input[1]],
  "2026-08-25": [input[2], input[3]],
});
assert.deepEqual(bucketByUtcDay([]), {});
assert.throws(() => bucketByUtcDay(["not-a-date"]), RangeError);
assert.throws(() => bucketByUtcDay([null]), TypeError);
