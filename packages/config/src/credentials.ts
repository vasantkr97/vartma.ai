import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  open as openFile,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

const encryptedCredentialFileSchema = z
  .object({
    version: z.literal(1),
    kdf: z.literal("scrypt"),
    cipher: z.literal("aes-256-gcm"),
    salt: z.string().min(1),
    iv: z.string().min(1),
    authTag: z.string().min(1),
    ciphertext: z.string(),
  })
  .strict();

const credentialPayloadSchema = z
  .object({
    version: z.literal(1),
    credentials: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();

const ADDITIONAL_DATA = Buffer.from("vartma-credential-store-v1", "utf8");

export function resolveCredentialStorePath(configPath: string, storePath: string): string {
  return resolve(dirname(resolve(configPath)), storePath);
}

export function readEncryptedCredential(options: {
  path: string;
  masterKey: string;
  reference: string;
}): string | undefined {
  const masterKey = validateMasterKey(options.masterKey);
  let content: string;
  try {
    content = readFileSync(resolve(options.path), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw new Error(
      `Unable to read the encrypted credential store at "${resolve(options.path)}".`,
      {
        cause: error,
      },
    );
  }
  return decryptPayload(content, masterKey).credentials[options.reference];
}

export async function setEncryptedCredential(options: {
  path: string;
  masterKey: string;
  reference: string;
  value: string;
}): Promise<void> {
  const masterKey = validateMasterKey(options.masterKey);
  const reference = validateReference(options.reference);
  const value = options.value.trim();
  if (!value) {
    throw new Error("A provider credential cannot be empty.");
  }
  await mutateCredentialStore(resolve(options.path), masterKey, (credentials) => ({
    ...credentials,
    [reference]: value,
  }));
}

export async function deleteEncryptedCredential(options: {
  path: string;
  masterKey: string;
  reference: string;
}): Promise<boolean> {
  const masterKey = validateMasterKey(options.masterKey);
  const reference = validateReference(options.reference);
  let removed = false;
  await mutateCredentialStore(resolve(options.path), masterKey, (credentials) => {
    if (!(reference in credentials)) {
      return credentials;
    }
    const updated = { ...credentials };
    delete updated[reference];
    removed = true;
    return updated;
  });
  return removed;
}

export function listEncryptedCredentialReferences(options: {
  path: string;
  masterKey: string;
}): string[] {
  const masterKey = validateMasterKey(options.masterKey);
  try {
    const content = readFileSync(resolve(options.path), "utf8");
    return Object.keys(decryptPayload(content, masterKey).credentials).sort();
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

async function mutateCredentialStore(
  path: string,
  masterKey: string,
  mutation: (credentials: Record<string, string>) => Record<string, string>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await withCredentialLock(path, async () => {
    const current = await readCredentialPayload(path, masterKey);
    const encrypted = encryptPayload(
      { version: 1, credentials: mutation(current.credentials) },
      masterKey,
    );
    await writeAtomic(path, `${JSON.stringify(encrypted, null, 2)}\n`);
  });
}

async function readCredentialPayload(path: string, masterKey: string) {
  try {
    return decryptPayload(await readFile(path, "utf8"), masterKey);
  } catch (error) {
    if (isMissingFileError(error)) {
      return credentialPayloadSchema.parse({ version: 1, credentials: {} });
    }
    throw error;
  }
}

function encryptPayload(payload: z.infer<typeof credentialPayloadSchema>, masterKey: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(masterKey, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(ADDITIONAL_DATA);
  const plaintext = Buffer.from(JSON.stringify(credentialPayloadSchema.parse(payload)), "utf8");
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return encryptedCredentialFileSchema.parse({
      version: 1,
      kdf: "scrypt",
      cipher: "aes-256-gcm",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
  } finally {
    plaintext.fill(0);
    key.fill(0);
  }
}

function decryptPayload(content: string, masterKey: string) {
  try {
    const encrypted = encryptedCredentialFileSchema.parse(JSON.parse(content));
    const salt = Buffer.from(encrypted.salt, "base64");
    const iv = Buffer.from(encrypted.iv, "base64");
    const authTag = Buffer.from(encrypted.authTag, "base64");
    const key = scryptSync(masterKey, salt, 32);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(ADDITIONAL_DATA);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
        decipher.final(),
      ]);
      try {
        return credentialPayloadSchema.parse(JSON.parse(plaintext.toString("utf8")));
      } finally {
        plaintext.fill(0);
      }
    } finally {
      key.fill(0);
    }
  } catch (error) {
    throw new Error(
      "The encrypted credential store could not be authenticated. Check the master key and file integrity.",
      { cause: error },
    );
  }
}

async function withCredentialLock(path: string, operation: () => Promise<void>): Promise<void> {
  const lockPath = `${path}.lock`;
  let handle: FileHandle;
  try {
    handle = await openFile(lockPath, "wx", 0o600);
  } catch (error) {
    if (isFileExistsError(error)) {
      throw new Error(`Another credential operation is active for "${path}".`, { cause: error });
    }
    throw error;
  }
  try {
    await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporaryPath, path);
    if (process.platform !== "win32") {
      await chmod(path, 0o600);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function validateMasterKey(masterKey: string): string {
  if (masterKey.length < 20) {
    throw new Error("Vartma's credential master key must contain at least 20 characters.");
  }
  return masterKey;
}

function validateReference(reference: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(reference)) {
    throw new Error("A credential reference must be 1-200 safe identifier characters.");
  }
  return reference;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isFileExistsError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
