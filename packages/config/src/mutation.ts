import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open as openFile,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type { RoutingMode } from "@vartma/canonical";
import type { RoutingCalibration } from "@vartma/routing";
import { parse, parseDocument, stringify } from "yaml";

import { createDefaultRouterConfig } from "./defaults.js";
import {
  providerConfigSchema,
  routerConfigSchema,
  type ProviderConfig,
  type RouterConfig,
} from "./schema.js";

export type ConfigurableRoutingMode = Exclude<RoutingMode, "fixed">;

export type RouterConfigMutation =
  | { kind: "set-mode"; mode: ConfigurableRoutingMode }
  | { kind: "use-model"; modelId: string }
  | { kind: "set-baseline"; modelId: string }
  | { kind: "set-calibration"; calibration: RoutingCalibration }
  | { kind: "add-provider"; provider: ProviderConfig }
  | { kind: "remove-provider"; providerId: string }
  | { kind: "set-provider-credential"; providerId: string; credentialRef: string | null }
  | { kind: "set-provider-enabled"; providerId: string; enabled: boolean };

export interface RouterConfigMutationResult {
  configPath: string;
  operation: string;
  backupPath: string;
  config: RouterConfig;
}

export interface RouterConfigInitializationResult {
  configPath: string;
  operation: "init";
  config: RouterConfig;
}

export interface RouterConfigUndoResult {
  configPath: string;
  operation: string;
  restoredFrom?: string;
  removedInitializedFile: boolean;
  recoveredIncompleteMutation: boolean;
}

interface ConfigHistoryEntry {
  id: string;
  operation: string;
  previousHash: string | null;
  appliedHash: string;
  backupPath?: string;
  createdAt: string;
}

interface ConfigMutationState {
  version: 1;
  configPath: string;
  history: ConfigHistoryEntry[];
}

export async function initializeRouterConfig(options: {
  path: string;
  now?: () => Date;
}): Promise<RouterConfigInitializationResult> {
  const configPath = resolve(options.path);
  return withConfigLock(configPath, async () => {
    if ((await readOptional(configPath)) !== undefined) {
      throw new Error(
        `Router configuration already exists at "${configPath}". No changes were made.`,
      );
    }
    const existingState = await readMutationState(configPath, true);
    if (existingState?.history.length) {
      throw new Error(
        `Router configuration state exists for "${configPath}" but the configuration file is missing. Run config undo or inspect the state before continuing.`,
      );
    }

    const now = options.now?.() ?? new Date();
    const config = createDefaultRouterConfig(now);
    const content = stringify(config, { lineWidth: 0 });
    validateRouterConfigYaml(content);
    const entry: ConfigHistoryEntry = {
      id: randomUUID(),
      operation: "init",
      previousHash: null,
      appliedHash: contentHash(content),
      createdAt: now.toISOString(),
    };
    await writeMutationState(configPath, {
      version: 1,
      configPath,
      history: [entry],
    });
    await writeTextAtomic(configPath, content, 0o600);
    return { configPath, operation: "init", config };
  });
}

export async function mutateRouterConfig(options: {
  path: string;
  mutation: RouterConfigMutation;
  now?: () => Date;
}): Promise<RouterConfigMutationResult> {
  const configPath = resolve(options.path);
  return withConfigLock(configPath, async () => {
    const current = await readRequired(configPath);
    validateRouterConfigYaml(current);
    const previousHash = contentHash(current);
    const state = await reconciledMutationState(configPath, previousHash);
    const operation = mutationLabel(options.mutation);
    const updated = applyMutation(current, options.mutation);
    if (updated.content === current) {
      throw new Error(`Configuration already satisfies "${operation}". No changes were made.`);
    }

    const now = options.now?.() ?? new Date();
    const backupPath = backupFilePath(configPath, now);
    await writeTextAtomic(backupPath, current, 0o600);
    const entry: ConfigHistoryEntry = {
      id: randomUUID(),
      operation,
      previousHash,
      appliedHash: contentHash(updated.content),
      backupPath,
      createdAt: now.toISOString(),
    };
    await writeMutationState(configPath, {
      ...state,
      history: [...state.history, entry],
    });
    await writeTextAtomic(configPath, updated.content, 0o600);
    return {
      configPath,
      operation,
      backupPath,
      config: updated.config,
    };
  });
}

export async function undoRouterConfigMutation(options: {
  path: string;
}): Promise<RouterConfigUndoResult> {
  const configPath = resolve(options.path);
  return withConfigLock(configPath, async () => {
    const state = await readMutationState(configPath, false);
    if (!state) {
      throw new Error(`No vartma configuration changes are recorded for "${configPath}".`);
    }
    const entry = state.history.at(-1);
    if (!entry) {
      throw new Error(`No vartma configuration change is available to undo for "${configPath}".`);
    }
    const current = await readOptional(configPath);
    const currentHash = current === undefined ? null : contentHash(current);
    const remainingHistory = state.history.slice(0, -1);

    if (currentHash === entry.previousHash) {
      await persistRemainingState(configPath, state, remainingHistory);
      return {
        configPath,
        operation: entry.operation,
        ...(entry.backupPath ? { restoredFrom: entry.backupPath } : {}),
        removedInitializedFile: entry.previousHash === null,
        recoveredIncompleteMutation: true,
      };
    }
    if (currentHash !== entry.appliedHash) {
      throw new Error(
        `Router configuration drift was detected at "${configPath}". No changes were made. Restore or review the file before retrying undo.`,
      );
    }

    if (entry.previousHash === null) {
      await unlink(configPath);
    } else {
      if (!entry.backupPath) {
        throw new Error("The router configuration backup path is missing. No changes were made.");
      }
      const backup = await readRequired(entry.backupPath);
      if (contentHash(backup) !== entry.previousHash) {
        throw new Error(
          `Router configuration backup "${entry.backupPath}" failed its integrity check. No changes were made.`,
        );
      }
      validateRouterConfigYaml(backup);
      await writeTextAtomic(configPath, backup, 0o600);
    }
    await persistRemainingState(configPath, state, remainingHistory);
    return {
      configPath,
      operation: entry.operation,
      ...(entry.backupPath ? { restoredFrom: entry.backupPath } : {}),
      removedInitializedFile: entry.previousHash === null,
      recoveredIncompleteMutation: false,
    };
  });
}

export async function readProviderDefinition(path: string): Promise<ProviderConfig> {
  const definitionPath = resolve(path);
  const content = await readRequired(definitionPath);
  let value: unknown;
  try {
    value = parse(content) as unknown;
  } catch (error) {
    throw new Error(`Provider definition at "${definitionPath}" is not valid YAML or JSON.`, {
      cause: error,
    });
  }
  return providerConfigSchema.parse(value);
}

function applyMutation(
  content: string,
  mutation: RouterConfigMutation,
): { content: string; config: RouterConfig } {
  const document = parseDocument(content);
  if (document.errors.length) {
    throw new Error(`Router configuration contains invalid YAML: ${document.errors[0]?.message}`);
  }
  const current = routerConfigSchema.parse(document.toJS());

  switch (mutation.kind) {
    case "set-mode":
      document.setIn(["routing", "defaultMode"], mutation.mode);
      break;
    case "use-model": {
      const available = current.providers.some(
        (provider) =>
          provider.enabled &&
          provider.models.some((model) => model.enabled && model.id === mutation.modelId),
      );
      if (!available) {
        throw new Error(`Enabled model "${mutation.modelId}" was not found. No changes were made.`);
      }
      document.setIn(["routing", "defaultMode"], "fixed");
      document.setIn(["routing", "defaultModel"], mutation.modelId);
      break;
    }
    case "set-baseline": {
      const available = current.providers.some(
        (provider) =>
          provider.enabled &&
          provider.models.some((model) => model.enabled && model.id === mutation.modelId),
      );
      if (!available) {
        throw new Error(
          `Enabled baseline model "${mutation.modelId}" was not found. No changes were made.`,
        );
      }
      document.setIn(["routing", "baselineModel"], mutation.modelId);
      break;
    }
    case "set-calibration":
      document.setIn(["routing", "calibration"], mutation.calibration);
      break;
    case "add-provider":
      if (current.providers.some((provider) => provider.id === mutation.provider.id)) {
        throw new Error(`Provider "${mutation.provider.id}" already exists. No changes were made.`);
      }
      document.addIn(["providers"], mutation.provider);
      break;
    case "remove-provider": {
      const providerIndex = current.providers.findIndex(
        (provider) => provider.id === mutation.providerId,
      );
      if (providerIndex < 0) {
        throw new Error(`Provider "${mutation.providerId}" was not found. No changes were made.`);
      }
      if (
        current.providers[providerIndex]?.models.some(
          (model) => model.id === current.routing.defaultModel,
        )
      ) {
        throw new Error(
          `Provider "${mutation.providerId}" owns default model "${current.routing.defaultModel}". Select another model before removing it.`,
        );
      }
      if (
        current.routing.baselineModel &&
        current.providers[providerIndex]?.models.some(
          (model) => model.id === current.routing.baselineModel,
        )
      ) {
        throw new Error(
          `Provider "${mutation.providerId}" owns baseline model "${current.routing.baselineModel}". Select another baseline before removing it.`,
        );
      }
      document.deleteIn(["providers", providerIndex]);
      break;
    }
    case "set-provider-credential": {
      const providerIndex = current.providers.findIndex(
        (provider) => provider.id === mutation.providerId,
      );
      if (providerIndex < 0) {
        throw new Error(`Provider "${mutation.providerId}" was not found. No changes were made.`);
      }
      if (current.providers[providerIndex]?.type === "fake") {
        throw new Error("The fake provider does not accept credentials. No changes were made.");
      }
      if (mutation.credentialRef) {
        document.setIn(["providers", providerIndex, "credentialRef"], mutation.credentialRef);
      } else {
        document.deleteIn(["providers", providerIndex, "credentialRef"]);
      }
      break;
    }
    case "set-provider-enabled": {
      const providerIndex = current.providers.findIndex(
        (provider) => provider.id === mutation.providerId,
      );
      if (providerIndex < 0) {
        throw new Error(`Provider "${mutation.providerId}" was not found. No changes were made.`);
      }
      if (
        !mutation.enabled &&
        current.providers[providerIndex]?.models.some(
          (model) => model.id === current.routing.defaultModel,
        )
      ) {
        throw new Error(
          `Provider "${mutation.providerId}" owns default model "${current.routing.defaultModel}". Select another model before disabling it.`,
        );
      }
      if (
        !mutation.enabled &&
        current.routing.baselineModel &&
        current.providers[providerIndex]?.models.some(
          (model) => model.id === current.routing.baselineModel,
        )
      ) {
        throw new Error(
          `Provider "${mutation.providerId}" owns baseline model "${current.routing.baselineModel}". Select another baseline before disabling it.`,
        );
      }
      document.setIn(["providers", providerIndex, "enabled"], mutation.enabled);
      break;
    }
  }

  const updatedContent = document.toString({ lineWidth: 0 });
  return {
    content: updatedContent,
    config: validateRouterConfigYaml(updatedContent),
  };
}

function validateRouterConfigYaml(content: string): RouterConfig {
  let value: unknown;
  try {
    value = parse(content) as unknown;
  } catch (error) {
    throw new Error("Router configuration is not valid YAML. No changes were made.", {
      cause: error,
    });
  }
  return routerConfigSchema.parse(value);
}

async function reconciledMutationState(
  configPath: string,
  currentHash: string,
): Promise<ConfigMutationState> {
  const state = (await readMutationState(configPath, true)) ?? {
    version: 1,
    configPath,
    history: [],
  };
  const last = state.history.at(-1);
  if (!last || last.appliedHash === currentHash) {
    return state;
  }
  if (last.previousHash === currentHash) {
    const recovered = { ...state, history: state.history.slice(0, -1) };
    await persistRemainingState(configPath, state, recovered.history);
    return recovered;
  }
  throw new Error(
    `Router configuration drift was detected at "${configPath}". No changes were made. Undo or reconcile the previous vartma change first.`,
  );
}

async function readMutationState(
  configPath: string,
  allowMissing: boolean,
): Promise<ConfigMutationState | undefined> {
  const path = mutationStatePath(configPath);
  const content = await readOptional(path);
  if (content === undefined) {
    if (allowMissing) {
      return undefined;
    }
    throw new Error(`No vartma configuration changes are recorded for "${configPath}".`);
  }
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Invalid vartma configuration state at "${path}". No changes were made.`, {
      cause: error,
    });
  }
  if (!isMutationState(value) || resolve(value.configPath) !== configPath) {
    throw new Error(`Invalid vartma configuration state at "${path}". No changes were made.`);
  }
  return value;
}

function isMutationState(value: unknown): value is ConfigMutationState {
  if (!isRecord(value) || value.version !== 1 || typeof value.configPath !== "string") {
    return false;
  }
  return (
    Array.isArray(value.history) &&
    value.history.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.operation === "string" &&
        (entry.previousHash === null || typeof entry.previousHash === "string") &&
        typeof entry.appliedHash === "string" &&
        (entry.backupPath === undefined || typeof entry.backupPath === "string") &&
        typeof entry.createdAt === "string",
    )
  );
}

async function writeMutationState(configPath: string, state: ConfigMutationState): Promise<void> {
  await writeTextAtomic(
    mutationStatePath(configPath),
    `${JSON.stringify(state, null, 2)}\n`,
    0o600,
  );
}

async function persistRemainingState(
  configPath: string,
  state: ConfigMutationState,
  history: ConfigHistoryEntry[],
): Promise<void> {
  if (history.length) {
    await writeMutationState(configPath, { ...state, history });
  } else {
    await unlink(mutationStatePath(configPath)).catch((error: unknown) => {
      if (!isMissingFileError(error)) {
        throw error;
      }
    });
  }
}

async function withConfigLock<T>(configPath: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(configPath), { recursive: true });
  const lockPath = `${configPath}.vartma.lock`;
  let handle: FileHandle;
  try {
    handle = await openFile(lockPath, "wx", 0o600);
  } catch (error) {
    if (isFileExistsError(error)) {
      throw new Error(
        `Another vartma configuration operation is active for "${configPath}". No changes were made.`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

async function writeTextAtomic(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode });
  try {
    await rename(temporaryPath, path);
    if (process.platform !== "win32") {
      await chmod(path, mode);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readRequired(path: string): Promise<string> {
  const content = await readOptional(path);
  if (content === undefined) {
    throw new Error(`Required file "${path}" does not exist.`);
  }
  return content;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function mutationLabel(mutation: RouterConfigMutation): string {
  switch (mutation.kind) {
    case "set-mode":
      return `mode:${mutation.mode}`;
    case "use-model":
      return `use:${mutation.modelId}`;
    case "set-baseline":
      return `baseline:${mutation.modelId}`;
    case "set-calibration":
      return `calibration:${mutation.calibration.version}`;
    case "add-provider":
      return `provider:add:${mutation.provider.id}`;
    case "remove-provider":
      return `provider:remove:${mutation.providerId}`;
    case "set-provider-credential":
      return `provider:credential:${mutation.providerId}`;
    case "set-provider-enabled":
      return `provider:${mutation.enabled ? "enable" : "disable"}:${mutation.providerId}`;
  }
}

function mutationStatePath(configPath: string): string {
  return `${configPath}.vartma-state.json`;
}

function backupFilePath(configPath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return `${configPath}.vartma-backups/${basename(configPath)}.${stamp}.${randomUUID()}.bak`;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isFileExistsError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
