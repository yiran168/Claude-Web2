import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";

if (existsSync(resolve(process.cwd(), ".env"))) {
  process.loadEnvFile(resolve(process.cwd(), ".env"));
}

const envSchema = z.object({
  CW2_MASTER_KEY: z.string().min(1, "CW2_MASTER_KEY is required"),
  CW2_ADMIN_PASSWORD: z.string().min(12).optional(),
  CW2_ADMIN_USERNAME: z.string().min(1).default("admin"),
  CW2_HOST: z.string().default("127.0.0.1"),
  CW2_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  CW2_DATA_DIR: z.string().default("./data"),
  CW2_TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  CW2_SECURE_COOKIES: z.enum(["true", "false", "auto"]).default("auto"),
  CW2_ALLOWED_ORIGINS: z.string().default(""),
  CW2_PUBLIC_URL: z.string().optional(),
  CW2_LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export interface AppConfig {
  masterKey: Buffer;
  adminPassword?: string;
  adminUsername: string;
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  trustProxy: boolean;
  secureCookies: boolean;
  allowedOrigins: Set<string>;
  publicUrl?: string;
  logLevel: string;
}

function decodeMasterKey(value: string): Buffer {
  let key: Buffer;
  if (value.startsWith("base64:")) {
    key = Buffer.from(value.slice(7), "base64");
  } else if (value.startsWith("hex:")) {
    key = Buffer.from(value.slice(4), "hex");
  } else {
    throw new Error("CW2_MASTER_KEY must start with base64: or hex:");
  }
  if (key.length !== 32) {
    throw new Error("CW2_MASTER_KEY must decode to exactly 32 bytes");
  }
  return key;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

function parsePublicUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CW2_PUBLIC_URL must be a valid absolute URL");
  }
  const localHttp = url.protocol === "http:" && isLoopback(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("CW2_PUBLIC_URL must use HTTPS (HTTP is allowed only for loopback development)");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("CW2_PUBLIC_URL must be an origin without credentials, path, query, or fragment");
  }
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const dataDir = resolve(process.cwd(), parsed.CW2_DATA_DIR);
  const publicUrl = parsePublicUrl(parsed.CW2_PUBLIC_URL);
  const secureCookies = parsed.CW2_SECURE_COOKIES === "true"
    || (parsed.CW2_SECURE_COOKIES === "auto" && (publicUrl ? publicUrl.protocol === "https:" : !isLoopback(parsed.CW2_HOST)));
  const allowedOrigins = new Set(parsed.CW2_ALLOWED_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean));
  if (publicUrl) allowedOrigins.add(publicUrl.origin);
  const config: AppConfig = {
    masterKey: decodeMasterKey(parsed.CW2_MASTER_KEY),
    adminUsername: parsed.CW2_ADMIN_USERNAME,
    host: parsed.CW2_HOST,
    port: parsed.CW2_PORT,
    dataDir,
    databasePath: resolve(dataDir, "claude-web2.db"),
    trustProxy: parsed.CW2_TRUST_PROXY === "true",
    secureCookies,
    allowedOrigins,
    ...(publicUrl ? { publicUrl: publicUrl.origin } : {}),
    logLevel: parsed.CW2_LOG_LEVEL,
  };
  if (parsed.CW2_ADMIN_PASSWORD !== undefined) {
    config.adminPassword = parsed.CW2_ADMIN_PASSWORD;
  }
  return config;
}
