import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { argon2id } from "@noble/hashes/argon2.js";

const encoder = new TextEncoder();

export interface Keyring {
  encryption: Buffer;
  gatewayHmac: Buffer;
  sessionHmac: Buffer;
  csrfHmac: Buffer;
}

export function deriveKeyring(masterKey: Buffer): Keyring {
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", masterKey, Buffer.from("claude-web2:v1"), Buffer.from(info), 32));
  return {
    encryption: derive("credential-encryption"),
    gatewayHmac: derive("gateway-key-hmac"),
    sessionHmac: derive("admin-session-hmac"),
    csrfHmac: derive("csrf-token-hmac"),
  };
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

export function encryptSecret(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}:${ciphertext.toString("base64url")}:${tag.toString("base64url")}`;
}

export function decryptSecret(key: Buffer, envelope: string, aad: string): string {
  const [marker, version, ivPart, ciphertextPart, tagPart] = envelope.split(":");
  if (marker !== "enc" || version !== "v1" || !ivPart || ciphertextPart === undefined || !tagPart) {
    throw new Error("Unsupported encrypted secret envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const memory = 19_456;
  const iterations = 2;
  const parallelism = 1;
  const digest = argon2id(encoder.encode(password), salt, {
    m: memory,
    t: iterations,
    p: parallelism,
    dkLen: 32,
  });
  return `$argon2id$v=19$m=${memory},t=${iterations},p=${parallelism}$${salt.toString("base64url")}$${Buffer.from(digest).toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const parts = encoded.split("$");
    if (parts.length !== 6 || parts[1] !== "argon2id" || parts[2] !== "v=19") return false;
    const parameters = Object.fromEntries((parts[3] ?? "").split(",").map((item) => item.split("=")));
    const salt = Buffer.from(parts[4] ?? "", "base64url");
    const expected = Buffer.from(parts[5] ?? "", "base64url");
    const actual = Buffer.from(argon2id(encoder.encode(password), salt, {
      m: Number(parameters.m),
      t: Number(parameters.t),
      p: Number(parameters.p),
      dkLen: expected.length,
    }));
    return expected.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
