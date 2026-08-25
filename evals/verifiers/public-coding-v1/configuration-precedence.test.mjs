import assert from "node:assert/strict";
import { loadConfig } from "../config.mjs";

assert.deepEqual(loadConfig(), {
  host: "127.0.0.1",
  port: 8080,
  logLevel: "info",
  telemetry: false,
});
assert.deepEqual(loadConfig({ port: 9000, telemetry: true }, {}), {
  host: "127.0.0.1",
  port: 9000,
  logLevel: "info",
  telemetry: true,
});
assert.deepEqual(loadConfig({ host: "file", port: 9000 }, { APP_HOST: "env", APP_PORT: "7000" }), {
  host: "env",
  port: 7000,
  logLevel: "info",
  telemetry: false,
});
assert.throws(() => loadConfig({}, { APP_PORT: "not-a-number" }), RangeError);
assert.throws(() => loadConfig({}, { APP_PORT: "70000" }), RangeError);
