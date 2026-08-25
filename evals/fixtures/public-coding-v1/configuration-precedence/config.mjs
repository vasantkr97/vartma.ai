import { defaults } from "./defaults.mjs";

export function loadConfig(file = {}, environment = {}) {
  const fromEnvironment = {
    host: environment.APP_HOST,
    port: environment.APP_PORT ? Number(environment.APP_PORT) : undefined,
    logLevel: environment.APP_LOG_LEVEL,
  };
  return { ...defaults, ...fromEnvironment, ...file };
}
