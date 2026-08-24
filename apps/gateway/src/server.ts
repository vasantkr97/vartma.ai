import type { Server } from "node:http";

import type { RouterConfig } from "@vartma/config";
import {
  checkDatabase,
  createDatabase,
  PrismaAttemptStore,
  PrismaRouterConfigurationStore,
  type RouterConfigurationSnapshotInput,
  type RouterConfigurationStore,
  type RouterDatabase,
} from "@vartma/database";

import { createApp } from "./app.js";
import type { Runtime } from "./runtime.js";

export interface StartServerOptions {
  database?: RouterDatabase;
  runtime?: Runtime;
  configurationStore?: RouterConfigurationStore;
}

export async function startServer(
  config: RouterConfig,
  options: StartServerOptions = {},
): Promise<Server> {
  let database: RouterDatabase | undefined =
    options.database ?? createDatabase(config.database.url);
  const configurationStore =
    options.configurationStore ?? new PrismaRouterConfigurationStore(database);
  try {
    try {
      await checkDatabase(database);
      await configurationStore.activate(safeRouterConfigurationSnapshot(config));
    } catch (error) {
      await database.$disconnect().catch(() => undefined);
      database = undefined;
      if (config.database.requiredForReadiness) throw error;
    }
    const app = createApp({
      config,
      ...(options.runtime ? { runtime: options.runtime } : {}),
      ...(database ? { database, attemptStore: new PrismaAttemptStore(database) } : {}),
    });
    const server = await new Promise<Server>((resolve, reject) => {
      const server = app.listen(config.server.port, config.server.host, () => {
        resolve(server);
      });
      server.once("error", reject);
    });
    server.once("close", () => {
      void database?.$disconnect();
    });
    return server;
  } catch (error) {
    await database?.$disconnect().catch(() => undefined);
    throw error;
  }
}

export function safeRouterConfigurationSnapshot(
  config: RouterConfig,
): RouterConfigurationSnapshotInput {
  const payload = {
    environment: config.environment,
    server: config.server,
    auth: {
      enabled: config.auth.enabled,
      configuredApiKeyCount: config.auth.apiKeys.length,
    },
    credentials: config.credentials,
    database: { requiredForReadiness: config.database.requiredForReadiness },
    routing: config.routing,
    providers: config.providers,
    telemetry: {
      serviceName: config.telemetry.serviceName,
      logLevel: config.telemetry.logLevel,
      langSmith: {
        enabled: config.telemetry.langSmith.enabled,
        apiKeyEnv: config.telemetry.langSmith.apiKeyEnv,
        project: config.telemetry.langSmith.project,
        exportContent: config.telemetry.langSmith.exportContent,
      },
    },
  };
  return {
    environment: config.environment,
    routerVersion: config.routing.routerVersion,
    priceBookVersion: config.routing.priceBookVersion,
    payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
  };
}
