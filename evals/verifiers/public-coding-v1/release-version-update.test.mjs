import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const release = JSON.parse(await readFile("release.json", "utf8"));
const changelog = await readFile("CHANGELOG.md", "utf8");
assert.deepEqual(packageJson, {
  name: "release-fixture",
  version: "2.4.0",
  private: true,
  type: "module",
});
assert.deepEqual(release, { version: "2.4.0", date: "2026-08-25", channel: "stable" });
assert.match(
  changelog,
  /^# Changelog\s+## 2\.4\.0 - 2026-08-25\s+- Add provider-neutral routing diagnostics\./u,
);
assert.match(changelog, /## 2\.3\.1 - 2026-07-10/u);
assert.equal(
  await readFile("runtime.mjs", "utf8"),
  'export const runtimeMarker = "must-remain-unchanged";\n',
);
