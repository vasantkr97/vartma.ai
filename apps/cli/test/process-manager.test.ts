import { createServer } from "node:net";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeRouterConfig } from "@vartma/config";
import { afterEach, describe, expect, it } from "vitest";

import {
  managedStatePath,
  startManagedGateway,
  stopManagedGateway,
} from "../src/process-manager.js";

describe("managed gateway lifecycle", () => {
  let activeConfigPath: string | undefined;

  afterEach(async () => {
    if (activeConfigPath) {
      await stopManagedGateway({ configPath: activeConfigPath, shutdownTimeoutMs: 5_000 }).catch(
        () => undefined,
      );
      activeConfigPath = undefined;
    }
  });

  it("starts once, verifies ownership, and stops without leaving state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-managed-gateway-"));
    const configPath = join(directory, "vartma.yaml");
    await initializeRouterConfig({ path: configPath });
    const port = await availablePort();
    const content = (await readFile(configPath, "utf8")).replace(
      /^\s*port:\s*8080\s*$/mu,
      `  port: ${String(port)}`,
    );
    await writeFile(configPath, content, "utf8");
    activeConfigPath = configPath;

    const started = await startManagedGateway({ configPath, startupTimeoutMs: 10_000 });
    expect(started.pid).toBeGreaterThan(0);
    expect((await fetch(started.healthUrl)).headers.get("x-vartma-instance-id")).toBe(
      started.instanceId,
    );

    const duplicate = await startManagedGateway({ configPath, startupTimeoutMs: 10_000 });
    expect(duplicate).toMatchObject({ pid: started.pid, alreadyRunning: true });

    const stopped = await stopManagedGateway({ configPath, shutdownTimeoutMs: 10_000 });
    expect(stopped).toMatchObject({ pid: started.pid, stopped: true });
    activeConfigPath = undefined;
    await expect(access(managedStatePath(configPath))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not receive a TCP port.");
  }
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return address.port;
}
