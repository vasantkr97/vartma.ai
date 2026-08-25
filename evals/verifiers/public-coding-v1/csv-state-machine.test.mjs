import assert from "node:assert/strict";
import { parseCsv } from "../csv.mjs";

assert.deepEqual(parseCsv("a,b\r\nc,d"), [
  ["a", "b"],
  ["c", "d"],
]);
assert.deepEqual(parseCsv('name,note\nAda,"hello, world"'), [
  ["name", "note"],
  ["Ada", "hello, world"],
]);
assert.deepEqual(parseCsv('"a""b","line 1\nline 2",'), [['a"b', "line 1\nline 2", ""]]);
assert.deepEqual(parseCsv(",,\n"), [["", "", ""]]);
assert.deepEqual(parseCsv(""), []);
assert.throws(() => parseCsv('a,"broken'), SyntaxError);
