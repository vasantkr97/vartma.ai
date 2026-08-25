import assert from "node:assert/strict";
import { formatBytes } from "../bytes.mjs";

assert.equal(formatBytes(0), "0 B");
assert.equal(formatBytes(-0), "0 B");
assert.equal(formatBytes(999), "999 B");
assert.equal(formatBytes(1000), "1 kB");
assert.equal(formatBytes(1500), "1.5 kB");
assert.equal(formatBytes(1024, { binary: true }), "1 KiB");
assert.equal(formatBytes(1536, { binary: true, precision: 2 }), "1.5 KiB");
assert.equal(formatBytes(-2500000, { precision: 2 }), "-2.5 MB");
assert.equal(formatBytes(1234567, { precision: 0 }), "1 MB");
assert.throws(() => formatBytes(Number.NaN), TypeError);
assert.throws(() => formatBytes("1000"), TypeError);
assert.throws(() => formatBytes(10, { precision: 4 }), RangeError);
