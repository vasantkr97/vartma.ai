import assert from "node:assert/strict";
import { stableTopologicalSort } from "../topo.mjs";

assert.deepEqual(
  stableTopologicalSort(["test", "build"], { build: ["compile"], test: ["compile"], compile: [] }),
  ["compile", "test", "build"],
);
assert.deepEqual(
  stableTopologicalSort(["deploy"], {
    deploy: ["build", "audit"],
    build: ["compile"],
    compile: [],
    audit: [],
  }),
  ["compile", "build", "audit", "deploy"],
);
assert.deepEqual(stableTopologicalSort([], { b: [], a: [] }), ["b", "a"]);
assert.throws(() => stableTopologicalSort(["a", "a"], { a: [] }), /Duplicate/u);
assert.throws(
  () => stableTopologicalSort(["a"], { a: ["missing"] }),
  /Missing declaration.*missing/u,
);
assert.throws(
  () => stableTopologicalSort(["a"], { a: ["b"], b: ["c"], c: ["a"] }),
  /a.*b.*c.*a|b.*c.*a.*b|c.*a.*b.*c/u,
);
