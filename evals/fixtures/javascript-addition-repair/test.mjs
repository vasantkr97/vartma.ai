import assert from "node:assert/strict";

import { add } from "./math.mjs";

assert.equal(add(2, 3), 5);
assert.equal(add(-2, 2), 0);
assert.equal(add(0.5, 0.25), 0.75);
process.stdout.write("javascript-addition-repair passed\n");
