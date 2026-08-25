import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { resolveWorkspacePath } from "../workspace-path.mjs";

const root = resolve("sandbox", "workspace");
assert.equal(resolveWorkspacePath(root, "src/file.mjs"), join(root, "src", "file.mjs"));
assert.equal(resolveWorkspacePath(root, "."), root);
for (const attack of [
  "../secret",
  "../../workspace-evil/file",
  "..\\secret",
  "%2e%2e%2fsecret",
  "/etc/passwd",
  "C:\\Windows\\system.ini",
  "bad\0name",
  "%E0%A4%A",
]) {
  assert.throws(() => resolveWorkspacePath(root, attack), undefined, attack);
}
