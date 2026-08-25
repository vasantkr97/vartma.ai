import assert from "node:assert/strict";
import { slugify } from "../slug.mjs";

assert.equal(slugify("  Hello,   World!  "), "hello-world");
assert.equal(slugify("Crème brûlée déjà vu"), "creme-brulee-deja-vu");
assert.equal(slugify("rock 'n' roll"), "rock-n-roll");
assert.equal(slugify("---A___B---"), "a-b");
assert.equal(slugify("!!!"), "");
assert.throws(() => slugify(null), TypeError);
