import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import { AppDatabase } from "./db/database.js";
import { HttpError } from "./http-error.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerGatewayRoutes } from "./routes/gateway.js";
import { registerOidcRoutes } from "./routes/oidc.js";
import { AdminAuthService } from "./security/admin-auth.js";
import { deriveKeyring } from "./security/crypto.js";
import { GatewayAuthService } from "./security/gateway-auth.js";
import { UpstreamPool } from "./upstream/pool.js";

function requestOrigin(protocol: string, host: string | undefined): string | undefined {
  return host ? `${protocol}://${host}` : undefined;
}

function errorStatus(error: unknown): number {
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof ZodError) return 400;
  const candidate = error as { statusCode?: unknown };
  return typeof candidate?.statusCode === "number" ? candidate.statusCode : 500;
}

export interface BuildAppOptions {
  upstreamFetch?: typeof globalThis.fetch;
}

export async function buildApp(config: AppConfig, options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    forceCloseConnections: "idle",
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-api-key",
          "req.headers.cookie",
          "res.headers.set-cookie",
          "body.apiKey",
          "body.password",
          "body.clientSecret",
        ],
        censor: "[REDACTED]",
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 12 * 1024 * 1024,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });
  const db = new AppDatabase(config);
  const keys = deriveKeyring(config.masterKey);
  const adminAuth = new AdminAuthService(db, config, keys);
  const gatewayAuth = new GatewayAuthService(db, keys);
  const pool = new UpstreamPool(db, keys, options.upstreamFetch ?? globalThis.fetch);
  const purgeExpiredMetadata = () => {
    const readDays = (key: string, fallback: number) => {
      const row = db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key=?", key);
      if (!row) return fallback;
      try { return Math.max(1, Number(JSON.parse(row.value_json)) || fallback); } catch { return fallback; }
    };
    const requestCutoff = new Date(Date.now() - readDays("logging.request_retention_days", 30) * 86_400_000).toISOString();
    const auditCutoff = new Date(Date.now() - readDays("logging.audit_retention_days", 180) * 86_400_000).toISOString();
    db.run("DELETE FROM request_logs WHERE created_at < ?", requestCutoff);
    db.run("DELETE FROM audit_events WHERE created_at < ?", auditCutoff);
    db.run("DELETE FROM sessions WHERE expires_at < ?", db.now());
  };
  purgeExpiredMetadata();
  const retentionTimer = setInterval(purgeExpiredMetadata, 6 * 60 * 60 * 1000);
  retentionTimer.unref();

  await app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin) return;
    const ownHttp = requestOrigin("http", request.headers.host);
    const ownHttps = requestOrigin("https", request.headers.host);
    if (origin !== ownHttp && origin !== ownHttps && !config.allowedOrigins.has(origin)) {
      throw new HttpError(403, "Origin is not allowed", "origin_not_allowed");
    }
    reply.header("access-control-allow-origin", origin);
    reply.header("vary", "Origin");
    reply.header("access-control-allow-credentials", "true");
    reply.header("access-control-allow-headers", "content-type,authorization,x-api-key,x-cw2-csrf,anthropic-version,anthropic-beta,x-request-id");
    reply.header("access-control-allow-methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    if (request.method === "OPTIONS") return reply.code(204).send();
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (_request.url.startsWith("/api/admin/")) reply.header("cache-control", "no-store");
    if (config.secureCookies) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    return payload;
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    const result = db.get<{ ok: number }>("SELECT 1 AS ok");
    if (result?.ok !== 1) throw new HttpError(503, "Database is not ready", "not_ready");
    return { status: "ready", database: "ok" };
  });

  await registerAdminRoutes(app, db, adminAuth, keys);
  await registerOidcRoutes(app, db, adminAuth, config, keys);
  await registerGatewayRoutes(app, db, gatewayAuth, adminAuth, pool);

  app.setErrorHandler(async (error, request, reply) => {
    const status = errorStatus(error);
    if (status >= 500) request.log.error({ err: error }, "request failed");
    const message = error instanceof ZodError
      ? error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")
      : error instanceof HttpError
        ? error.message
        : status < 500 && error instanceof Error
          ? error.message
          : "Internal server error";
    const code = error instanceof HttpError ? error.code : error instanceof ZodError ? "invalid_request_error" : "internal_error";
    if (request.url.startsWith("/v1/messages")) {
      return reply.code(status).send({
        type: "error",
        error: { type: code, message },
        request_id: request.id,
      });
    }
    return reply.code(status).send({
      error: { message, type: code, code },
      requestId: request.id,
    });
  });

  const webRoot = resolve(process.cwd(), "dist", "web");
  if (existsSync(resolve(webRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/") && !request.url.startsWith("/v1/") && !request.url.startsWith("/health/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: { message: "Route not found", type: "not_found", code: "not_found" }, requestId: request.id });
    });
  }

  app.addHook("onClose", async () => {
    clearInterval(retentionTimer);
    db.close();
  });
  return app;
}
