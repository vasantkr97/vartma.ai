import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from "node:crypto";

import type { CanonicalMessage } from "@vartma/canonical";
import type { CanonicalHistoryStore } from "@vartma/routing";

import type { RouterDatabase } from "./index.js";

interface EncryptedTranscriptV1 {
  version: 1;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

interface EncryptedTranscriptV2 {
  version: 2;
  kdf: "scrypt-hkdf-sha256";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

type EncryptedTranscript = EncryptedTranscriptV1 | EncryptedTranscriptV2;

const transcriptRootSalt = Buffer.from("vartma-canonical-transcript-root-v2", "utf8");

export class PrismaEncryptedCanonicalHistoryStore implements CanonicalHistoryStore {
  readonly #masterKey: string;
  readonly #rootKey: Buffer;

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
    // Scrypt's intentionally expensive passphrase hardening runs once per store, not once per
    // routed request. Per-transcript random salts are expanded from this root with HKDF.
    this.#rootKey = scryptSync(masterKey, transcriptRootSalt, 32);
  }

  public async get(sessionId: string): Promise<CanonicalMessage[] | undefined> {
    const transcript = await this.database.canonicalTranscript.findUnique({
      where: { sessionId },
      select: { payload: true },
    });
    return transcript
      ? decryptTranscript(transcript.payload, sessionId, this.#masterKey, this.#rootKey)
      : undefined;
  }

  public async save(sessionId: string, messages: CanonicalMessage[]): Promise<void> {
    const payload = encryptTranscript(messages, sessionId, this.#rootKey);
    await this.database.canonicalTranscript.upsert({
      where: { sessionId },
      create: {
        sessionId,
        payload,
        messageCount: messages.length,
        encryptionVersion: 2,
      },
      update: {
        payload,
        messageCount: messages.length,
        encryptionVersion: 2,
      },
    });
  }
}

function encryptTranscript(
  messages: CanonicalMessage[],
  sessionId: string,
  rootKey: Buffer,
): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveTranscriptKey(rootKey, salt, sessionId);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(transcriptAdditionalData(sessionId));
  const plaintext = Buffer.from(JSON.stringify(messages), "utf8");
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedTranscriptV2 = {
      version: 2,
      kdf: "scrypt-hkdf-sha256",
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
  rootKey: Buffer,
): CanonicalMessage[] {
  try {
    const envelope = parseEnvelope(payload);
    const salt = Buffer.from(envelope.salt, "base64");
    const key =
      envelope.version === 1
        ? scryptSync(masterKey, salt, 32)
        : deriveTranscriptKey(rootKey, salt, sessionId);
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
    !("kdf" in value) ||
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
  const supportedVersion =
    (value.version === 1 && value.kdf === "scrypt") ||
    (value.version === 2 && value.kdf === "scrypt-hkdf-sha256");
  if (!supportedVersion) {
    throw new Error("Unsupported encrypted transcript envelope.");
  }
  return value as EncryptedTranscript;
}

function deriveTranscriptKey(rootKey: Buffer, salt: Buffer, sessionId: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", rootKey, salt, Buffer.from(`session:${sessionId}`, "utf8"), 32),
  );
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
