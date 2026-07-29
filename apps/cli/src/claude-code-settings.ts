import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CLAUDE_ROUTING_MODES = ["quality", "balanced", "eco"] as const;
export type ClaudeRoutingMode = (typeof CLAUDE_ROUTING_MODES)[number];
export type ClaudeSettingsScope = "user" | "project";

const MANAGED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB",
] as const;

type JsonObject = Record<string, unknown>;

interface ClaudeCodeRouterState {
  version: 1;
  settingsPath: string;
  baselineBackupPath: string;
  routedBackupPath: string;
  configuredAt: string;
  bypassed: boolean;
  gatewayUrl: string;
  mode: ClaudeRoutingMode;
}

export interface ClaudeSettingsLocationOptions {
  scope?: ClaudeSettingsScope;
  cwd?: string;
  homeDirectory?: string;
  settingsPath?: string;
}

export interface ConfigureClaudeCodeOptions extends ClaudeSettingsLocationOptions {
  gatewayUrl: string;
  apiKey: string;
  mode: ClaudeRoutingMode;
  now?: () => Date;
}

export interface ClaudeCodeConfigurationResult {
  settingsPath: string;
  statePath: string;
  baselineBackupPath: string;
  routedBackupPath: string;
  gatewayUrl: string;
  mode: ClaudeRoutingMode;
  reconfigured: boolean;
}

export interface ClaudeCodeStatus {
  configured: boolean;
  state: "not_configured" | "active" | "bypassed" | "drifted";
  settingsPath: string;
  statePath: string;
  gatewayUrl?: string;
  mode?: ClaudeRoutingMode;
  baselineBackupPath?: string;
}

export function resolveClaudeSettingsPath(options: ClaudeSettingsLocationOptions = {}): string {
  if (options.settingsPath) {
    return resolve(options.settingsPath);
  }
  if ((options.scope ?? "project") === "project") {
    return resolve(options.cwd ?? process.cwd(), ".claude", "settings.local.json");
  }
  return resolve(options.homeDirectory ?? homedir(), ".claude", "settings.json");
}

export function claudeRouterStatePath(settingsPath: string): string {
  return join(dirname(settingsPath), ".vartma-state.json");
}

export async function configureClaudeCode(
  options: ConfigureClaudeCodeOptions,
): Promise<ClaudeCodeConfigurationResult> {
  const settingsPath = resolveClaudeSettingsPath(options);
  const statePath = claudeRouterStatePath(settingsPath);
  const gatewayUrl = normalizeGatewayUrl(options.gatewayUrl);
  const apiKey = options.apiKey.trim();
  if (apiKey.length < 8) {
    throw new Error("The router API key must contain at least 8 characters.");
  }
  const existingState = await readState(statePath);
  if (existingState && existingState.settingsPath !== settingsPath) {
    throw new Error(
      `Claude Code router state targets "${existingState.settingsPath}", not "${settingsPath}".`,
    );
  }

  const current = await readJsonObject(settingsPath, true);
  const now = options.now?.() ?? new Date();
  const backupsDirectory = join(dirname(settingsPath), ".vartma-backups");
  await mkdir(backupsDirectory, { recursive: true });
  await secureDirectory(backupsDirectory);

  const baselineBackupPath =
    existingState?.baselineBackupPath ??
    join(backupsDirectory, `settings-baseline-${backupStamp(now)}-${randomUUID()}.json`);
  const routedBackupPath =
    existingState?.routedBackupPath ??
    join(backupsDirectory, `settings-routed-${backupStamp(now)}-${randomUUID()}.json`);
  if (!existingState) {
    await writeJsonAtomic(baselineBackupPath, current);
  } else {
    await readJsonObject(baselineBackupPath, false);
  }

  const routed = applyRouterConfiguration(current, gatewayUrl, apiKey, options.mode);
  await writeJsonAtomic(routedBackupPath, routed);
  await writeJsonAtomic(settingsPath, routed);
  if ((options.scope ?? "project") === "project" && !options.settingsPath) {
    await ensureProjectRouterArtifactsIgnored(options.cwd ?? process.cwd());
  }
  const state: ClaudeCodeRouterState = {
    version: 1,
    settingsPath,
    baselineBackupPath,
    routedBackupPath,
    configuredAt: now.toISOString(),
    bypassed: false,
    gatewayUrl,
    mode: options.mode,
  };
  await writeJsonAtomic(statePath, state as unknown as JsonObject);

  return {
    settingsPath,
    statePath,
    baselineBackupPath,
    routedBackupPath,
    gatewayUrl,
    mode: options.mode,
    reconfigured: existingState !== undefined,
  };
}

export async function setClaudeCodeBypass(
  enabled: boolean,
  options: ClaudeSettingsLocationOptions = {},
): Promise<ClaudeCodeStatus> {
  const settingsPath = resolveClaudeSettingsPath(options);
  const statePath = claudeRouterStatePath(settingsPath);
  const state = await requireState(statePath, settingsPath);
  const current = await readJsonObject(settingsPath, true);
  const source = await readJsonObject(
    enabled ? state.baselineBackupPath : state.routedBackupPath,
    false,
  );
  await writeJsonAtomic(settingsPath, mergeManagedEnvironment(current, source));
  await writeJsonAtomic(statePath, {
    ...state,
    bypassed: enabled,
  });
  return claudeCodeStatus(options);
}

export async function undoClaudeCodeConfiguration(
  options: ClaudeSettingsLocationOptions = {},
): Promise<{ settingsPath: string; restoredFrom: string }> {
  const settingsPath = resolveClaudeSettingsPath(options);
  const statePath = claudeRouterStatePath(settingsPath);
  const state = await requireState(statePath, settingsPath);
  const current = await readJsonObject(settingsPath, true);
  const baseline = await readJsonObject(state.baselineBackupPath, false);
  await writeJsonAtomic(settingsPath, mergeManagedEnvironment(current, baseline));
  await unlink(statePath);
  return { settingsPath, restoredFrom: state.baselineBackupPath };
}

export async function claudeCodeStatus(
  options: ClaudeSettingsLocationOptions = {},
): Promise<ClaudeCodeStatus> {
  const settingsPath = resolveClaudeSettingsPath(options);
  const statePath = claudeRouterStatePath(settingsPath);
  const state = await readState(statePath);
  if (!state) {
    return { configured: false, state: "not_configured", settingsPath, statePath };
  }
  if (state.settingsPath !== settingsPath) {
    return {
      configured: true,
      state: "drifted",
      settingsPath,
      statePath,
      gatewayUrl: state.gatewayUrl,
      mode: state.mode,
      baselineBackupPath: state.baselineBackupPath,
    };
  }
  const current = await readJsonObject(settingsPath, true);
  const expected = await readJsonObject(
    state.bypassed ? state.baselineBackupPath : state.routedBackupPath,
    false,
  );
  return {
    configured: true,
    state: managedEnvironmentMatches(current, expected)
      ? state.bypassed
        ? "bypassed"
        : "active"
      : "drifted",
    settingsPath,
    statePath,
    gatewayUrl: state.gatewayUrl,
    mode: state.mode,
    baselineBackupPath: state.baselineBackupPath,
  };
}

function applyRouterConfiguration(
  settings: JsonObject,
  gatewayUrl: string,
  apiKey: string,
  mode: ClaudeRoutingMode,
): JsonObject {
  const result = structuredClone(settings);
  const env = readEnvironment(result);
  delete env["ANTHROPIC_API_KEY"];
  result["env"] = {
    ...env,
    ANTHROPIC_BASE_URL: gatewayUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_MODEL: `claude-vartma-${mode}`,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
  };
  return result;
}

async function ensureProjectRouterArtifactsIgnored(projectRoot: string): Promise<void> {
  const path = resolve(projectRoot, ".gitignore");
  const requiredEntries = [
    ".claude/settings.local.json",
    ".claude/.vartma-state.json",
    ".claude/.vartma-backups/",
  ];
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
  const existingEntries = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  const missingEntries = requiredEntries.filter((entry) => !existingEntries.has(entry));
  if (missingEntries.length === 0) {
    return;
  }
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeTextAtomic(path, `${content}${separator}${missingEntries.join("\n")}\n`, 0o644);
}

function mergeManagedEnvironment(current: JsonObject, source: JsonObject): JsonObject {
  const result = structuredClone(current);
  const currentEnvironment = readEnvironment(result);
  const sourceEnvironment = readEnvironment(source);
  for (const key of MANAGED_ENV_KEYS) {
    if (Object.hasOwn(sourceEnvironment, key)) {
      currentEnvironment[key] = sourceEnvironment[key];
    } else {
      delete currentEnvironment[key];
    }
  }
  if (Object.keys(currentEnvironment).length === 0) {
    delete result["env"];
  } else {
    result["env"] = currentEnvironment;
  }
  return result;
}

function managedEnvironmentMatches(left: JsonObject, right: JsonObject): boolean {
  const leftEnvironment = readEnvironment(left);
  const rightEnvironment = readEnvironment(right);
  return MANAGED_ENV_KEYS.every(
    (key) =>
      Object.hasOwn(leftEnvironment, key) === Object.hasOwn(rightEnvironment, key) &&
      leftEnvironment[key] === rightEnvironment[key],
  );
}

function readEnvironment(settings: JsonObject): JsonObject {
  const value = settings["env"];
  if (value === undefined) {
    return {};
  }
  if (!isJsonObject(value)) {
    throw new Error('Claude Code settings field "env" must be a JSON object.');
  }
  return structuredClone(value);
}

async function requireState(
  statePath: string,
  settingsPath: string,
): Promise<ClaudeCodeRouterState> {
  const state = await readState(statePath);
  if (!state) {
    throw new Error(
      `Claude Code is not configured by vartma at "${settingsPath}". Run "vartma configure claude-code" first.`,
    );
  }
  if (state.settingsPath !== settingsPath) {
    throw new Error(`Router state belongs to "${state.settingsPath}", not "${settingsPath}".`);
  }
  return state;
}

async function readState(path: string): Promise<ClaudeCodeRouterState | undefined> {
  const value = await readJsonObject(path, true);
  if (Object.keys(value).length === 0) {
    return undefined;
  }
  if (
    value["version"] !== 1 ||
    typeof value["settingsPath"] !== "string" ||
    typeof value["baselineBackupPath"] !== "string" ||
    typeof value["routedBackupPath"] !== "string" ||
    typeof value["configuredAt"] !== "string" ||
    typeof value["bypassed"] !== "boolean" ||
    typeof value["gatewayUrl"] !== "string" ||
    !isClaudeRoutingMode(value["mode"])
  ) {
    throw new Error(`Invalid vartma Claude Code state file: ${path}`);
  }
  return value as unknown as ClaudeCodeRouterState;
}

async function readJsonObject(path: string, allowMissing: boolean): Promise<JsonObject> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (allowMissing && isMissingFileError(error)) {
      return {};
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in "${path}". No changes were made.`, { cause: error });
  }
  if (!isJsonObject(value)) {
    throw new Error(`Expected a JSON object in "${path}". No changes were made.`);
  }
  return value;
}

async function writeJsonAtomic(path: string, value: JsonObject): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
  await secureFile(path);
}

async function writeTextAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, {
    encoding: "utf8",
    mode,
  });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function secureFile(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
  }
}

async function secureDirectory(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, 0o700);
  }
}

function normalizeGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Invalid gateway URL "${value}".`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Claude Code gateway URL must use http or https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Claude Code gateway URL cannot contain credentials, query, or fragment.");
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (normalizedPath !== "") {
    throw new Error("Use the gateway root URL without a path such as /v1.");
  }
  url.pathname = "/";
  return url.toString().replace(/\/$/, "");
}

function backupStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isClaudeRoutingMode(value: unknown): value is ClaudeRoutingMode {
  return value === "quality" || value === "balanced" || value === "eco";
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
