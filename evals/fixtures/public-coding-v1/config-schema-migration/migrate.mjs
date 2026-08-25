export function migrateConfig(config) {
  return { ...config, version: 2 };
}
