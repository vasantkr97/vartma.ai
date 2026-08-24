import { createHash } from "node:crypto";

import type { Prisma } from "./generated/prisma/client.js";
import type { RouterDatabase } from "./index.js";

export interface RouterConfigurationSnapshotInput {
  environment: string;
  routerVersion: string;
  priceBookVersion: string;
  payload: Record<string, unknown>;
}

export interface RouterConfigurationStore {
  activate(input: RouterConfigurationSnapshotInput): Promise<{ id: string; hash: string }>;
}

export class PrismaRouterConfigurationStore implements RouterConfigurationStore {
  public constructor(private readonly database: RouterDatabase) {}

  public async activate(
    input: RouterConfigurationSnapshotInput,
  ): Promise<{ id: string; hash: string }> {
    const serialized = stableJson(input.payload);
    const configurationHash = createHash("sha256").update(serialized).digest("hex");
    const payload = JSON.parse(serialized) as Prisma.InputJsonValue;
    const activatedAt = new Date();
    const [, snapshot] = await this.database.$transaction([
      this.database.routerConfigurationSnapshot.updateMany({
        where: { active: true, configurationHash: { not: configurationHash } },
        data: { active: false },
      }),
      this.database.routerConfigurationSnapshot.upsert({
        where: { configurationHash },
        create: {
          configurationHash,
          environment: input.environment,
          routerVersion: input.routerVersion,
          priceBookVersion: input.priceBookVersion,
          payload,
          active: true,
          activatedAt,
        },
        update: {
          environment: input.environment,
          routerVersion: input.routerVersion,
          priceBookVersion: input.priceBookVersion,
          payload,
          active: true,
          activatedAt,
        },
      }),
    ]);
    return { id: snapshot.id, hash: configurationHash };
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("Configuration snapshots cannot contain undefined.");
  return serialized;
}
