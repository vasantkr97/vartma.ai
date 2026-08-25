import assert from "node:assert/strict";
import { migrateConfig } from "../migrate.mjs";

const source = {
  version: 1,
  model: "openai/gpt",
  apiKeyEnv: "OPENAI_API_KEY",
  metadata: { owner: "platform", nested: { enabled: true } },
};
const before = globalThis.structuredClone(source);
const migrated = migrateConfig(source);
assert.deepEqual(source, before);
assert.deepEqual(migrated, {
  version: 2,
  routing: { defaultModel: "openai/gpt", mode: "balanced" },
  providers: { default: { credentialEnv: "OPENAI_API_KEY" } },
  metadata: { owner: "platform", nested: { enabled: true } },
});
assert.deepEqual(migrateConfig(migrated), migrated);
const cloned = migrateConfig(migrated);
cloned.metadata.nested.enabled = false;
assert.equal(migrated.metadata.nested.enabled, true);
assert.throws(() => migrateConfig({ version: 3 }), /Unsupported/u);
assert.throws(() => migrateConfig(null), TypeError);
