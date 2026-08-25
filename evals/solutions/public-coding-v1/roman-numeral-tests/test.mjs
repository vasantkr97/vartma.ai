import assert from "node:assert/strict";
import { toRoman } from "./roman.mjs";

for (const [value, expected] of [
  [1, "I"],
  [3, "III"],
  [4, "IV"],
  [9, "IX"],
  [40, "XL"],
  [49, "XLIX"],
  [90, "XC"],
  [400, "CD"],
  [944, "CMXLIV"],
  [3999, "MMMCMXCIX"],
]) {
  assert.equal(toRoman(value), expected);
}
for (const invalid of [0, -1, 4000, 1.5, "4", null]) {
  assert.throws(() => toRoman(invalid), RangeError);
}
