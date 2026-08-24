import type { CanonicalMessage } from "@vartma/canonical";
import { describe, expect, it, vi } from "vitest";

import { PrismaEncryptedCanonicalHistoryStore, type RouterDatabase } from "../src/index.js";

describe("Prisma encrypted canonical history", () => {
  it("persists authenticated ciphertext and restores canonical messages", async () => {
    let record: { payload: string; messageCount: number } | undefined;
    const database = {
      canonicalTranscript: {
        upsert: vi.fn((input: { create: { payload: string; messageCount: number } }) => {
          record = {
            payload: input.create.payload,
            messageCount: input.create.messageCount,
          };
          return Promise.resolve(record);
        }),
        findUnique: vi.fn(() => Promise.resolve(record ? { payload: record.payload } : null)),
      },
    } as unknown as RouterDatabase;
    const messages: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: "private repository requirement" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "call-1", name: "edit_file", arguments: { path: "a.ts" } },
        ],
      },
    ];
    const masterKey = "canonical-history-master-passphrase";
    const store = new PrismaEncryptedCanonicalHistoryStore(database, masterKey);

    await store.save("session-1", messages);
    expect(record?.messageCount).toBe(2);
    expect(record?.payload).not.toContain("private repository requirement");
    expect(record?.payload).not.toContain(masterKey);
    await expect(store.get("session-1")).resolves.toEqual(messages);

    const wrongKeyStore = new PrismaEncryptedCanonicalHistoryStore(
      database,
      "incorrect-canonical-master-key",
    );
    await expect(wrongKeyStore.get("session-1")).rejects.toThrow("could not be authenticated");
  });

  it("binds ciphertext to its session ID to prevent transcript swapping", async () => {
    let payload = "";
    const database = {
      canonicalTranscript: {
        upsert: vi.fn((input: { create: { payload: string } }) => {
          payload = input.create.payload;
          return Promise.resolve(input.create);
        }),
        findUnique: vi.fn(() => Promise.resolve({ payload })),
      },
    } as unknown as RouterDatabase;
    const store = new PrismaEncryptedCanonicalHistoryStore(
      database,
      "session-binding-master-passphrase",
    );
    await store.save("session-original", [
      { role: "user", content: [{ type: "text", text: "bound" }] },
    ]);
    await expect(store.get("session-different")).rejects.toThrow("could not be authenticated");
  });
});
