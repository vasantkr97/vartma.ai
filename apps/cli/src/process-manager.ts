import { randomUUID } from "node:crypto";
import { chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadConfig } from "@vartma/config";
import { z } from "zod";

const managedGatewayStateSchema = z
  .object({
    version: z.literal(1),
    pid: z.number().int().positive(),
    instanceId: z.string().uuid(),
    configPath: z.string().min(1),
    healthUrl: z.url(),
    startedAt: z.iso.datetime(),
  })
  .strict();

type ManagedGatewayState = z.infer<typeof managedGatewayStateSchema>;

export interface ManagedGatewayResult {
  pid: number;
  instanceId: string;
  healthUrl: string;
  statePath: string;
  alreadyRunning?: boolean;
  staleStateRemoved?: boolean;
}

export async function startManagedGateway(options: {
  configPath: string;
  startupTimeoutMs?: number;
}): Promise<ManagedGatewayResult> {
  const config = await loadConfig({ path: options.configPath });
  const statePath = managedStatePath(options.configPath);
  const existing = await readState(statePath);
  if (existing) {
    if (processExists(existing.pid) && (await gatewayOwnsInstance(existing))) {
      return { ...existing, statePath, alreadyRunning: true };
    }
    await unlink(statePath).catch(ignoreMissingFile);
  }

  const instanceId = randomUUID();
  const healthUrl = `http://${clientHost(config.server.host)}:${String(config.server.port)}/healthz`;
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      "serve",
      "--config",
      options.configPath,
    ],
    {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, VARTMA_INSTANCE_ID: instanceId },
    },
  );
  if (!child.pid) {
    throw new Error("The managed gateway process did not receive a process ID.");
  }
  child.unref();
  const state: ManagedGatewayState = {
    version: 1,
    pid: child.pid,
    instanceId,
    configPath: options.configPath,
    healthUrl,
    startedAt: new Date().toISOString(),
  };
  await writeState(statePath, state);
  try {
    await waitForInstance(state, options.startupTimeoutMs ?? 10_000);
  } catch (error) {
    if (processExists(state.pid)) {
      process.kill(state.pid, "SIGTERM");
    }
    await unlink(statePath).catch(ignoreMissingFile);
    throw error;
  }
  return { ...state, statePath, ...(existing ? { staleStateRemoved: true } : {}) };
}

export async function stopManagedGateway(options: {
  configPath: string;
  shutdownTimeoutMs?: number;
}): Promise<(ManagedGatewayResult & { stopped: boolean }) | undefined> {
  const statePath = managedStatePath(options.configPath);
  const state = await readState(statePath);
  if (!state) {
    return undefined;
  }
  if (!processExists(state.pid)) {
    await unlink(statePath).catch(ignoreMissingFile);
    return { ...state, statePath, stopped: false, staleStateRemoved: true };
  }
  if (!(await gatewayOwnsInstance(state))) {
    throw new Error(
      `Refusing to stop PID ${String(state.pid)} because the gateway instance token does not match the managed state.`,
    );
  }

  process.kill(state.pid, "SIGTERM");
  const deadline = Date.now() + (options.shutdownTimeoutMs ?? 10_000);
  while (processExists(state.pid) && Date.now() < deadline) {
    await delay(100);
  }
  if (processExists(state.pid)) {
    throw new Error(
      `Gateway PID ${String(state.pid)} did not stop within the configured timeout; state was retained.`,
    );
  }
  await unlink(statePath).catch(ignoreMissingFile);
  return { ...state, statePath, stopped: true };
}

export function managedStatePath(configPath: string): string {
  return `${configPath}.vartma-server.json`;
}

async function waitForInstance(state: ManagedGatewayState, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(state.pid)) {
      throw new Error("The gateway process exited before becoming ready.");
    }
    if (await gatewayOwnsInstance(state)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Gateway did not become ready within ${String(timeoutMs)}ms.`);
}

async function gatewayOwnsInstance(state: ManagedGatewayState): Promise<boolean> {
  try {
    const response = await fetch(state.healthUrl, { signal: AbortSignal.timeout(1_000) });
    return response.headers.get("x-vartma-instance-id") === state.instanceId;
  } catch {
    return false;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function readState(path: string): Promise<ManagedGatewayState | undefined> {
  try {
    return managedGatewayStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw new Error(`Managed gateway state at "${path}" is invalid.`, { cause: error });
  }
}

async function writeState(path: string, state: ManagedGatewayState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
  }
}

function clientHost(host: string): string {
  const value = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return value.includes(":") ? `[${value}]` : value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function ignoreMissingFile(error: unknown): void {
  if (!isNodeError(error) || error.code !== "ENOENT") {
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
