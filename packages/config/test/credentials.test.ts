import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  deleteEncryptedCredential,
  listEncryptedCredentialReferences,
  readEncryptedCredential,
  setEncryptedCredential,
} from "../src/index.js";

describe("encrypted provider credentials", () => {
  it("encrypts, authenticates, rotates, lists, and deletes provider keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-credentials-"));
    const path = join(directory, "credentials.enc");
    const masterKey = "correct horse battery staple for vartma";
    const firstSecret = "provider-secret-first-value";

    await setEncryptedCredential({
      path,
      masterKey,
      reference: "openai",
      value: firstSecret,
    });

    const encrypted = await readFile(path, "utf8");
    expect(encrypted).not.toContain(firstSecret);
    expect(encrypted).not.toContain(masterKey);
    expect(JSON.parse(encrypted)).toMatchObject({
      version: 1,
      kdf: "scrypt",
      cipher: "aes-256-gcm",
    });
    expect(readEncryptedCredential({ path, masterKey, reference: "openai" })).toBe(firstSecret);
    expect(listEncryptedCredentialReferences({ path, masterKey })).toEqual(["openai"]);
    expect(() =>
      readEncryptedCredential({
        path,
        masterKey: "a different master passphrase entirely",
        reference: "openai",
      }),
    ).toThrow("could not be authenticated");

    await setEncryptedCredential({
      path,
      masterKey,
      reference: "openai",
      value: "rotated-provider-secret",
    });
    expect(readEncryptedCredential({ path, masterKey, reference: "openai" })).toBe(
      "rotated-provider-secret",
    );
    await expect(deleteEncryptedCredential({ path, masterKey, reference: "openai" })).resolves.toBe(
      true,
    );
    expect(readEncryptedCredential({ path, masterKey, reference: "openai" })).toBeUndefined();
  });

  it("rejects short master keys and unsafe references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vartma-credentials-invalid-"));
    const path = join(directory, "credentials.enc");
    await expect(
      setEncryptedCredential({ path, masterKey: "too-short", reference: "openai", value: "key" }),
    ).rejects.toThrow("at least 20 characters");
    await expect(
      setEncryptedCredential({
        path,
        masterKey: "valid-master-passphrase-value",
        reference: "../unsafe",
        value: "key",
      }),
    ).rejects.toThrow("safe identifier");
  });
});
