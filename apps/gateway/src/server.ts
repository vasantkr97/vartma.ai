import type { Server } from "node:http";

import type { RouterConfig } from "@vartma/config";
import { createDatabase, PrismaAttemptStore, type RouterDatabase } from "@vartma/database";

import { createApp } from "./app.js";

export interface StartServerOptions {
  database?: RouterDatabase;
}

export async function startServer(
  config: RouterConfig,
  options: StartServerOptions = {},
): Promise<Server> {
  const database = options.database ?? createDatabase(config.database.url);
  const app = createApp({
    config,
    database,
    attemptStore: new PrismaAttemptStore(database),
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const server = app.listen(config.server.port, config.server.host, () => {
      resolve(server);
    });
    server.once("error", reject);
  });
  server.once("close", () => {
    void database.$disconnect();
  });
  return server;
}
