import { createCipheriv, randomBytes, scryptSync } from "node:crypto";

import type { CanonicalMessage } from "@vartma/canonical";
import { describe, expect, it, vi } from "vitest";

import { PrismaEncryptedCanonicalHistoryStore, type RouterDatabase } from "../src/index.js";

describe("Prisma encrypted canonical history", () => {
  it("persists authenticated ciphertext and restores canonical messages", async () => {
    let record: { payload: string; messageCount: number; encryptionVersion: number } | undefined;
    const database = {
      canonicalTranscript: {
        upsert: vi.fn(
          (input: {
            create: { payload: string; messageCount: number; encryptionVersion: number };
          }) => {
            record = {
              payload: input.create.payload,
              messageCount: input.create.messageCount,
              encryptionVersion: input.create.encryptionVersion,
            };
            return Promise.resolve(record);
          },
        ),
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
    const firstPayload = record?.payload;
    expect(record?.messageCount).toBe(2);
    expect(record?.encryptionVersion).toBe(2);
    expect(JSON.parse(record?.payload ?? "{}")).toMatchObject({
      version: 2,
      kdf: "scrypt-hkdf-sha256",
      cipher: "aes-256-gcm",
    });
    expect(record?.payload).not.toContain("private repository requirement");
    expect(record?.payload).not.toContain(masterKey);
    await expect(store.get("session-1")).resolves.toEqual(messages);

    await store.save("session-1", messages);
    expect(record?.payload).not.toBe(firstPayload);
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

  it("reads version-one scrypt envelopes written before root-key derivation", async () => {
    const masterKey = "legacy-canonical-master-passphrase";
    const sessionId = "legacy-session";
    const messages: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: "legacy transcript" }] },
    ];
    const payload = legacyPayload(messages, sessionId, masterKey);
    const database = {
      canonicalTranscript: {
        findUnique: vi.fn(() => Promise.resolve({ payload })),
      },
    } as unknown as RouterDatabase;

    const store = new PrismaEncryptedCanonicalHistoryStore(database, masterKey);
    await expect(store.get(sessionId)).resolves.toEqual(messages);
  });
});

function legacyPayload(messages: CanonicalMessage[], sessionId: string, masterKey: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(masterKey, salt, 32);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(`vartma-canonical-transcript-v1:${sessionId}`, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(messages), "utf8")),
      cipher.final(),
    ]);
    return JSON.stringify({
      version: 1,
      kdf: "scrypt",
      cipher: "aes-256-gcm",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
  } finally {
    key.fill(0);
  }
}
