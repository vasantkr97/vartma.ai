import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import type { CanonicalMessage } from "@vartma/canonical";
import type { CanonicalHistoryStore } from "@vartma/routing";

import type { RouterDatabase } from "./index.js";

interface EncryptedTranscript {
  version: 1;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class PrismaEncryptedCanonicalHistoryStore implements CanonicalHistoryStore {
  readonly #masterKey: string;

  public constructor(
    private readonly database: RouterDatabase,
    masterKey: string,
  ) {
    if (masterKey.length < 20) {
      throw new Error(
        "Canonical-history encryption requires a master key of at least 20 characters.",
      );
    }
    this.#masterKey = masterKey;
  }

  public async get(sessionId: string): Promise<CanonicalMessage[] | undefined> {
    const transcript = await this.database.canonicalTranscript.findUnique({
      where: { sessionId },
      select: { payload: true },
    });
    return transcript
      ? decryptTranscript(transcript.payload, sessionId, this.#masterKey)
      : undefined;
  }

  public async save(sessionId: string, messages: CanonicalMessage[]): Promise<void> {
    const payload = encryptTranscript(messages, sessionId, this.#masterKey);
    await this.database.canonicalTranscript.upsert({
      where: { sessionId },
      create: {
        sessionId,
        payload,
        messageCount: messages.length,
        encryptionVersion: 1,
      },
      update: {
        payload,
        messageCount: messages.length,
        encryptionVersion: 1,
      },
    });
  }
}

function encryptTranscript(
  messages: CanonicalMessage[],
  sessionId: string,
  masterKey: string,
): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(masterKey, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(transcriptAdditionalData(sessionId));
  const plaintext = Buffer.from(JSON.stringify(messages), "utf8");
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedTranscript = {
      version: 1,
      kdf: "scrypt",
      cipher: "aes-256-gcm",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    return JSON.stringify(envelope);
  } finally {
    plaintext.fill(0);
    key.fill(0);
  }
}

function decryptTranscript(
  payload: string,
  sessionId: string,
  masterKey: string,
): CanonicalMessage[] {
  try {
    const envelope = parseEnvelope(payload);
    const key = scryptSync(masterKey, Buffer.from(envelope.salt, "base64"), 32);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
      decipher.setAAD(transcriptAdditionalData(sessionId));
      decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
      try {
        const messages: unknown = JSON.parse(plaintext.toString("utf8"));
        if (!isCanonicalMessages(messages)) {
          throw new Error("Transcript payload has an invalid canonical message shape.");
        }
        return messages;
      } finally {
        plaintext.fill(0);
      }
    } finally {
      key.fill(0);
    }
  } catch (error) {
    throw new Error(`Canonical transcript for session "${sessionId}" could not be authenticated.`, {
      cause: error,
    });
  }
}

function parseEnvelope(payload: string): EncryptedTranscript {
  const value: unknown = JSON.parse(payload);
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("kdf" in value) ||
    value.kdf !== "scrypt" ||
    !("cipher" in value) ||
    value.cipher !== "aes-256-gcm" ||
    !("salt" in value) ||
    typeof value.salt !== "string" ||
    !("iv" in value) ||
    typeof value.iv !== "string" ||
    !("authTag" in value) ||
    typeof value.authTag !== "string" ||
    !("ciphertext" in value) ||
    typeof value.ciphertext !== "string"
  ) {
    throw new Error("Unsupported encrypted transcript envelope.");
  }
  return value as EncryptedTranscript;
}

function isCanonicalMessages(value: unknown): value is CanonicalMessage[] {
  return (
    Array.isArray(value) &&
    (value as unknown[]).every((candidate: unknown) => {
      if (candidate === null || typeof candidate !== "object") return false;
      const message = candidate as Record<string, unknown>;
      return (
        (message["role"] === "system" ||
          message["role"] === "user" ||
          message["role"] === "assistant" ||
          message["role"] === "tool") &&
        Array.isArray(message["content"])
      );
    })
  );
}

function transcriptAdditionalData(sessionId: string): Buffer {
  return Buffer.from(`vartma-canonical-transcript-v1:${sessionId}`, "utf8");
}
