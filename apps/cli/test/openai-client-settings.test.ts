import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  configureOpenAIClient,
  openAIClientStatePath,
  openAIClientStatus,
  undoOpenAIClientConfiguration,
} from "../src/openai-client-settings.js";

describe("OpenAI-compatible client configuration", () => {
  it("preserves unrelated dotenv values and restores the original managed values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-openai-client-"));
    const envPath = join(directory, ".env");
    const original =
      "# project settings\nUNRELATED=value\nOPENAI_BASE_URL=https://api.openai.com/v1\nOPENAI_API_KEY='original-key'\n";
    await writeFile(envPath, original, "utf8");

    const configured = await configureOpenAIClient({
      envPath,
      gatewayUrl: "http://127.0.0.1:8080",
      apiKey: "router-secret-key",
      model: "vartma-balanced",
      now: () => new Date("2026-08-24T00:00:00.000Z"),
    });
    const routed = await readFile(envPath, "utf8");
    expect(routed).toContain("# project settings");
    expect(routed).toContain("UNRELATED=value");
    expect(routed).toContain('OPENAI_BASE_URL="http://127.0.0.1:8080/v1"');
    expect(routed).toContain('OPENAI_API_KEY="router-secret-key"');
    expect(routed).toContain('OPENAI_MODEL="vartma-balanced"');
    expect(await openAIClientStatus({ envPath })).toMatchObject({
      configured: true,
      state: "active",
      gatewayUrl: "http://127.0.0.1:8080/v1",
      model: "vartma-balanced",
    });
    expect(await readFile(configured.statePath, "utf8")).not.toContain("router-secret-key");

    await writeFile(envPath, routed.replace("UNRELATED=value", "UNRELATED=changed"), "utf8");
    expect((await openAIClientStatus({ envPath })).state).toBe("active");
    await undoOpenAIClientConfiguration({ envPath });
    const restored = await readFile(envPath, "utf8");
    expect(restored).toContain("UNRELATED=changed");
    expect(restored).toContain('OPENAI_BASE_URL="https://api.openai.com/v1"');
    expect(restored).toContain('OPENAI_API_KEY="original-key"');
    expect(restored).not.toContain("OPENAI_MODEL");
    await expect(access(openAIClientStatePath(envPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a newly-created dotenv file on undo", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-openai-client-new-"));
    const envPath = join(directory, ".env");
    await configureOpenAIClient({
      envPath,
      gatewayUrl: "http://localhost:8080/v1",
      apiKey: "router-key-value",
      model: "vartma-eco",
    });
    await undoOpenAIClientConfiguration({ envPath });
    await expect(access(envPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects managed-value drift without exposing the API key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-openai-client-drift-"));
    const envPath = join(directory, ".env");
    await configureOpenAIClient({
      envPath,
      gatewayUrl: "http://localhost:8080",
      apiKey: "router-key-value",
      model: "vartma-quality",
    });
    const content = await readFile(envPath, "utf8");
    await writeFile(envPath, content.replace("vartma-quality", "different-model"), "utf8");
    const status = await openAIClientStatus({ envPath });
    expect(status.state).toBe("drifted");
    expect(JSON.stringify(status)).not.toContain("router-key-value");
  });
});
