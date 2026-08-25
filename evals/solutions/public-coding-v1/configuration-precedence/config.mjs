import { defaults } from "./defaults.mjs";

export function loadConfig(file = {}, environment = {}) {
  const fromEnvironment = Object.fromEntries(
    [
      ["host", environment.APP_HOST],
      ["port", environment.APP_PORT === undefined ? undefined : Number(environment.APP_PORT)],
      ["logLevel", environment.APP_LOG_LEVEL],
    ].filter(([, value]) => value !== undefined),
  );
  if (
    "port" in fromEnvironment &&
    (!Number.isInteger(fromEnvironment.port) ||
      fromEnvironment.port < 1 ||
      fromEnvironment.port > 65535)
  ) {
    throw new RangeError("APP_PORT must be an integer from 1 through 65535");
  }
  return { ...defaults, ...file, ...fromEnvironment };
}
