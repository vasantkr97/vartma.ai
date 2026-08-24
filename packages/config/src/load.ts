import { readFile } from "node:fs/promises";

import { parse } from "yaml";

import { routerConfigSchema, type RouterConfig } from "./schema.js";

export interface LoadConfigOptions {
  path: string;
  env?: NodeJS.ProcessEnv;
}

export async function loadConfig(options: LoadConfigOptions): Promise<RouterConfig> {
  const env = options.env ?? process.env;
  const raw = await readFile(options.path, "utf8");
  const parsed: unknown = parse(raw);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Router config at ${options.path} must contain a YAML object.`);
  }

  const object = structuredClone(parsed) as Record<string, unknown>;
  applyEnvironmentOverrides(object, env);
  return routerConfigSchema.parse(object);
}

function applyEnvironmentOverrides(config: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  const server = ensureRecord(config, "server");
  const auth = ensureRecord(config, "auth");
  const database = ensureRecord(config, "database");
  const credentials = ensureRecord(config, "credentials");

  if (env["VARTMA_HOST"]) {
    server["host"] = env["VARTMA_HOST"];
  }
  if (env["VARTMA_PORT"]) {
    const port = Number(env["VARTMA_PORT"]);
    if (!Number.isInteger(port)) {
      throw new Error("VARTMA_PORT must be an integer.");
    }
    server["port"] = port;
  }
  if (env["VARTMA_API_KEYS"]) {
    auth["apiKeys"] = env["VARTMA_API_KEYS"]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (env["DATABASE_URL"]) {
    database["url"] = env["DATABASE_URL"];
  }
  if (env["VARTMA_CREDENTIAL_STORE_PATH"]) {
    credentials["storePath"] = env["VARTMA_CREDENTIAL_STORE_PATH"];
  }
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  const record: Record<string, unknown> = {};
  parent[key] = record;
  return record;
}
