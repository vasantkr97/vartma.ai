import assert from "node:assert/strict";
import { getByPointer } from "../pointer.mjs";

const document = { "": 0, a: { b: ["zero", { "c/d": 2, "m~n": 3 }] }, falseValue: false };
assert.equal(getByPointer(document, ""), document);
assert.equal(getByPointer(document, "/"), 0);
assert.equal(getByPointer(document, "/a/b/0"), "zero");
assert.equal(getByPointer(document, "/a/b/1/c~1d"), 2);
assert.equal(getByPointer(document, "/a/b/1/m~0n"), 3);
assert.equal(getByPointer(document, "/falseValue"), false);
assert.equal(getByPointer(document, "/missing"), undefined);
assert.throws(() => getByPointer(document, "a/b"), SyntaxError);
assert.throws(() => getByPointer(document, "/bad~2escape"), SyntaxError);
