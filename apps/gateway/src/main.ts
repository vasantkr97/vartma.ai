import { resolve } from "node:path";

import { loadConfig } from "@vartma/config";

import { startServer } from "./server.js";

const configPath = resolve(process.env["VARTMA_CONFIG_PATH"] ?? "./configs/vartma.example.yaml");
const config = await loadConfig({ path: configPath });
const server = await startServer(config);
const address = server.address();

process.stdout.write(
  `Model router gateway listening on ${
    typeof address === "object" && address ? `${address.address}:${address.port}` : String(address)
  }\n`,
);

function shutdown(signal: string): void {
  process.stdout.write(`Received ${signal}; shutting down.\n`);
  server.close((error) => {
    if (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
