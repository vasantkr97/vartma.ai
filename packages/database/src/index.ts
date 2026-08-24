import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export type RouterDatabase = PrismaClient;

export function createDatabase(connectionString: string): RouterDatabase {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export async function checkDatabase(database: RouterDatabase): Promise<void> {
  await database.$queryRaw`SELECT 1`;
}

export * from "./attempt-store.js";
export * from "./canonical-history-store.js";
export * from "./configuration-store.js";
export * from "./evaluation-store.js";
export * from "./inspection-store.js";
export * from "./session-store.js";
export * from "./usage-analytics-store.js";
