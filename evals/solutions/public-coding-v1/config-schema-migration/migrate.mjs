export function migrateConfig(config) {
  if (!config || typeof config !== "object") throw new TypeError("config must be an object");
  if (config.version === 2) return globalThis.structuredClone(config);
  if (config.version !== 1)
    throw new Error(`Unsupported config version: ${String(config.version)}`);
  return {
    version: 2,
    routing: { defaultModel: config.model, mode: "balanced" },
    providers: { default: { credentialEnv: config.apiKeyEnv } },
    metadata: globalThis.structuredClone(config.metadata ?? {}),
  };
}
