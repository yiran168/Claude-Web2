import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { HttpError } from "../http-error.js";
import type { AdminAuthService } from "../security/admin-auth.js";
import { OidcService } from "../security/oidc.js";
import type { Keyring } from "../security/crypto.js";

const configSchema = z.object({
  enabled: z.boolean(),
  providerName: z.string().trim().min(1).max(100),
  issuer: z.string().trim().min(1).max(2048),
  clientId: z.string().trim().min(1).max(1024),
  clientSecret: z.string().min(1).max(4096).optional(),
  clearClientSecret: z.boolean().default(false),
  tokenAuthMethod: z.enum(["client_secret_basic", "client_secret_post", "none"]),
  scopes: z.array(z.string().trim().min(1).max(100)).min(1).max(32),
  usernameClaim: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
  groupsClaim: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/),
  allowedGroups: z.array(z.string().trim().min(1).max(200)).max(100),
  autoProvision: z.boolean(),
});

const callbackSchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(256).optional(),
});

export async function registerOidcRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  auth: AdminAuthService,
  config: AppConfig,
  keys: Keyring,
): Promise<void> {
  const oidc = new OidcService(db, config, keys, auth);

  app.get("/api/admin/v1/oidc/public", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return oidc.publicConfig();
  });

  app.get("/api/admin/v1/oidc", async (request, reply) => {
    auth.require(request);
    reply.header("cache-control", "no-store");
    return oidc.adminConfig();
  });

  app.put("/api/admin/v1/oidc", async (request, reply) => {
    const session = auth.require(request, true);
    reply.header("cache-control", "no-store");
    return oidc.configure(configSchema.parse(request.body), session.username);
  });

  app.post("/api/admin/v1/oidc/test", async (request, reply) => {
    const session = auth.require(request, true);
    reply.header("cache-control", "no-store");
    return oidc.test(session.username);
  });

  app.post("/api/admin/v1/oidc/link/start", async (request, reply) => {
    const session = auth.require(request, true);
    reply.header("cache-control", "no-store");
    return { authorizationUrl: await oidc.begin("link", reply, session.adminId) };
  });

  app.get("/api/admin/v1/oidc/start", { logLevel: "silent" }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return reply.redirect(await oidc.begin("login", reply));
  });

  app.get("/api/admin/v1/oidc/callback", { logLevel: "silent" }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      await oidc.complete(callbackSchema.parse(request.query), request, reply);
      if (!config.publicUrl) throw new HttpError(500, "OIDC public URL is unavailable", "oidc_configuration_error");
      return reply.redirect(`${config.publicUrl}/dashboard?oidc=success`);
    } catch (error) {
      const code = error instanceof HttpError ? error.code : "oidc_callback_failed";
      db.audit(`ip:${request.ip}`, "oidc.callback_failed", "oidc_provider", undefined, { code });
      request.log.warn({ code }, "OIDC callback failed");
      if (!config.publicUrl) throw error;
      const target = new URL("/", config.publicUrl);
      target.searchParams.set("oidc_error", code);
      return reply.redirect(target.toString());
    }
  });
}
