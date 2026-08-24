import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { URL } from "node:url";

const MANAGED_KEYS = ["OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"] as const;

interface OpenAIClientState {
  version: 1;
  envPath: string;
  baselineBackupPath: string;
  baselineExisted: boolean;
  routedManagedHash: string;
  configuredAt: string;
}

export interface OpenAIClientStatus {
  configured: boolean;
  state: "not_configured" | "active" | "drifted";
  envPath: string;
  statePath: string;
  gatewayUrl?: string;
  model?: string;
}

export function resolveOpenAIEnvPath(path = ".env"): string {
  return resolve(path);
}

export function openAIClientStatePath(envPath: string): string {
  return `${envPath}.vartma-openai-state.json`;
}

export async function configureOpenAIClient(options: {
  envPath?: string;
  gatewayUrl: string;
  apiKey: string;
  model: string;
  now?: () => Date;
}): Promise<{
  envPath: string;
  statePath: string;
  baselineBackupPath: string;
  gatewayUrl: string;
  model: string;
}> {
  const envPath = resolveOpenAIEnvPath(options.envPath);
  const statePath = openAIClientStatePath(envPath);
  const existingState = await readState(statePath);
  if (existingState && existingState.envPath !== envPath) {
    throw new Error(`OpenAI client state targets "${existingState.envPath}", not "${envPath}".`);
  }
  const current = await readOptional(envPath);
  const baselineExisted = existingState?.baselineExisted ?? current !== undefined;
  const now = options.now?.() ?? new Date();
  const baselineBackupPath =
    existingState?.baselineBackupPath ??
    `${envPath}.vartma-backups/${basename(envPath)}.${now.toISOString().replace(/[:.]/gu, "-")}.${randomUUID()}.baseline`;
  if (!existingState) {
    await writeTextAtomic(baselineBackupPath, current ?? "", 0o600);
  }
  const gatewayUrl = normalizeOpenAIBaseUrl(options.gatewayUrl);
  const apiKey = safeDotenvValue(options.apiKey, "router API key");
  const model = safeDotenvValue(options.model, "model alias");
  const routed = mergeManagedEntries(current ?? "", {
    OPENAI_BASE_URL: gatewayUrl,
    OPENAI_API_KEY: apiKey,
    OPENAI_MODEL: model,
  });
  await writeTextAtomic(envPath, routed, 0o600);
  const state: OpenAIClientState = {
    version: 1,
    envPath,
    baselineBackupPath,
    baselineExisted,
    routedManagedHash: managedHash(routed),
    configuredAt: now.toISOString(),
  };
  await writeTextAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  return { envPath, statePath, baselineBackupPath, gatewayUrl, model };
}

export async function undoOpenAIClientConfiguration(
  options: {
    envPath?: string;
  } = {},
): Promise<{ envPath: string; restoredFrom: string }> {
  const envPath = resolveOpenAIEnvPath(options.envPath);
  const statePath = openAIClientStatePath(envPath);
  const state = await requireState(statePath, envPath);
  const current = (await readOptional(envPath)) ?? "";
  const baseline = await readFile(state.baselineBackupPath, "utf8");
  const restored = mergeManagedEntries(current, managedEntries(baseline));
  if (!state.baselineExisted && restored.trim() === "") {
    await unlink(envPath).catch(ignoreMissingFile);
  } else {
    await writeTextAtomic(envPath, restored, 0o600);
  }
  await unlink(statePath);
  return { envPath, restoredFrom: state.baselineBackupPath };
}

export async function openAIClientStatus(
  options: {
    envPath?: string;
  } = {},
): Promise<OpenAIClientStatus> {
  const envPath = resolveOpenAIEnvPath(options.envPath);
  const statePath = openAIClientStatePath(envPath);
  const state = await readState(statePath);
  if (!state) return { configured: false, state: "not_configured", envPath, statePath };
  const current = (await readOptional(envPath)) ?? "";
  const entries = managedEntries(current);
  return {
    configured: true,
    state: managedHash(current) === state.routedManagedHash ? "active" : "drifted",
    envPath,
    statePath,
    ...(entries.OPENAI_BASE_URL ? { gatewayUrl: entries.OPENAI_BASE_URL } : {}),
    ...(entries.OPENAI_MODEL ? { model: entries.OPENAI_MODEL } : {}),
  };
}

function mergeManagedEntries(
  content: string,
  values: Partial<Record<(typeof MANAGED_KEYS)[number], string>>,
): string {
  const retained = content.split(/\r?\n/gu).filter((line) => {
    const key = dotenvKey(line);
    return !key || !(MANAGED_KEYS as readonly string[]).includes(key);
  });
  while (retained.at(-1) === "") retained.pop();
  const managed = MANAGED_KEYS.flatMap((key) =>
    values[key] === undefined ? [] : [`${key}=${JSON.stringify(values[key])}`],
  );
  return (
    [...retained, ...(retained.length && managed.length ? [""] : []), ...managed].join("\n") + "\n"
  );
}

function managedEntries(content: string): Partial<Record<(typeof MANAGED_KEYS)[number], string>> {
  const result: Partial<Record<(typeof MANAGED_KEYS)[number], string>> = {};
  for (const line of content.split(/\r?\n/gu)) {
    const key = dotenvKey(line);
    if (!key || !(MANAGED_KEYS as readonly string[]).includes(key)) continue;
    const raw = line.slice(line.indexOf("=") + 1).trim();
    result[key as (typeof MANAGED_KEYS)[number]] = parseDotenvValue(raw);
  }
  return result;
}

function dotenvKey(line: string): string | undefined {
  return /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)?.[1];
}

function parseDotenvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value.replace(/^'|'$/gu, "");
}

function managedHash(content: string): string {
  return createHash("sha256")
    .update(JSON.stringify(managedEntries(content)))
    .digest("hex");
}

function safeDotenvValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n\0]/u.test(trimmed)) throw new Error(`The ${label} is invalid.`);
  return trimmed;
}

function normalizeOpenAIBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The OpenAI-compatible gateway URL must use HTTP or HTTPS.");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v1`.replace(/\/v1\/v1$/u, "/v1");
  return url.toString().replace(/\/$/u, "");
}

async function requireState(path: string, envPath: string): Promise<OpenAIClientState> {
  const state = await readState(path);
  if (!state) throw new Error(`OpenAI client is not configured by Vartma at "${envPath}".`);
  if (state.envPath !== envPath)
    throw new Error(`OpenAI client state belongs to "${state.envPath}".`);
  return state;
}

async function readState(path: string): Promise<OpenAIClientState | undefined> {
  const content = await readOptional(path);
  if (content === undefined) return undefined;
  const value: unknown = JSON.parse(content);
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("envPath" in value) ||
    typeof value.envPath !== "string" ||
    !("baselineBackupPath" in value) ||
    typeof value.baselineBackupPath !== "string" ||
    !("baselineExisted" in value) ||
    typeof value.baselineExisted !== "boolean" ||
    !("routedManagedHash" in value) ||
    typeof value.routedManagedHash !== "string" ||
    !("configuredAt" in value) ||
    typeof value.configuredAt !== "string"
  ) {
    throw new Error(`Invalid OpenAI client state at "${path}".`);
  }
  return value as OpenAIClientState;
}

async function writeTextAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode });
  try {
    await rename(temporaryPath, path);
    if (process.platform !== "win32") await chmod(path, mode);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function ignoreMissingFile(error: unknown): void {
  if (!isMissingFileError(error)) throw error;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
