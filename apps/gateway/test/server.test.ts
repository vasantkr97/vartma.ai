import { createDefaultRouterConfig } from "@vartma/config";
import { describe, expect, it } from "vitest";

import { safeRouterConfigurationSnapshot } from "../src/server.js";

describe("gateway configuration persistence", () => {
  it("removes gateway keys and database credentials from the durable snapshot", () => {
    const config = createDefaultRouterConfig();
    config.auth.enabled = true;
    config.auth.apiKeys = ["gateway-api-secret"];
    config.database.url =
      "postgresql://database-user:database-password@database.internal:5432/vartma";

    const snapshot = safeRouterConfigurationSnapshot(config);
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.payload).toMatchObject({
      auth: { enabled: true, configuredApiKeyCount: 1 },
      database: { requiredForReadiness: false },
    });
    expect(serialized).not.toContain("gateway-api-secret");
    expect(serialized).not.toContain("database-password");
    expect(serialized).not.toContain("database-user");
  });
});
