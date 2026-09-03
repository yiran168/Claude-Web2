import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  deriveKeyring,
  encryptSecret,
  hashPassword,
  hmacHex,
  verifyPassword,
} from "../src/server/security/crypto.js";

describe("security primitives", () => {
  it("encrypts credentials with record-bound authenticated encryption", () => {
    const keys = deriveKeyring(randomBytes(32));
    const envelope = encryptSecret(keys.encryption, "sk-ant-secret", "upstream:one");
    expect(envelope).not.toContain("sk-ant-secret");
    expect(decryptSecret(keys.encryption, envelope, "upstream:one")).toBe("sk-ant-secret");
    expect(() => decryptSecret(keys.encryption, envelope, "upstream:two")).toThrow();
  });

  it("uses domain-separated keys", () => {
    const keys = deriveKeyring(Buffer.alloc(32, 7));
    const hashes = new Set([
      hmacHex(keys.gatewayHmac, "same"),
      hmacHex(keys.sessionHmac, "same"),
      hmacHex(keys.csrfHmac, "same"),
    ]);
    expect(hashes.size).toBe(3);
  });

  it("hashes administrator passwords with Argon2id", () => {
    const encoded = hashPassword("a very strong test password");
    expect(encoded.startsWith("$argon2id$v=19$")).toBe(true);
    expect(verifyPassword("a very strong test password", encoded)).toBe(true);
    expect(verifyPassword("wrong password", encoded)).toBe(false);
  });
});
