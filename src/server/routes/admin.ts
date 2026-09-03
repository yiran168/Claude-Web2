import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import type { GatewayKeyRow, ModelAliasRow, ProtocolMode, UpstreamKind, UpstreamRow } from "../domain.js";
import { HttpError } from "../http-error.js";
import type { AdminAuthService } from "../security/admin-auth.js";
import { encryptSecret, hashPassword, hmacHex, randomToken, verifyPassword, type Keyring } from "../security/crypto.js";
import { assertPublicDestination, joinUpstreamPath, validateUpstreamUrl } from "../security/network.js";

const loginSchema = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(1024) });
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(1024),
}).refine((value) => value.currentPassword !== value.newPassword, { path: ["newPassword"], message: "New password must be different" });
const protocolMode = z.enum(["openai", "anthropic", "dual"]);
const upstreamKind = z.enum(["anthropic", "compatible"]);

const gatewayKeySchema = z.object({
  name: z.string().min(1).max(120),
  mode: protocolMode.default("dual"),
  allowedModels: z.array(z.string().min(1)).max(100).default([]),
  allowedIps: z.array(z.string().min(1)).max(100).default([]),
  rpm: z.number().int().min(1).max(100_000).default(60),
  tpm: z.number().int().min(1).max(100_000_000).default(100_000),
  maxConcurrency: z.number().int().min(1).max(1_000).default(4),
  dailyBudgetMicros: z.number().int().positive().nullable().default(null),
  expiresAt: z.string().datetime().nullable().default(null),
});
const gatewayKeyPatchSchema = gatewayKeySchema.omit({ mode: true }).partial();

const upstreamSchema = z.object({
  name: z.string().min(1).max(120),
  kind: upstreamKind.default("anthropic"),
  baseUrl: z.string().min(1).default("https://api.anthropic.com"),
  apiKey: z.string().min(1).max(4096),
  authScheme: z.enum(["x-api-key", "bearer"]).default("x-api-key"),
  priority: z.number().int().min(0).max(10_000).default(100),
  weight: z.number().int().min(1).max(1_000).default(1),
  maxConcurrency: z.number().int().min(1).max(1_000).default(4),
  enabled: z.boolean().default(true),
  modelPrefix: z.string().max(200).default(""),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
});

const upstreamPatchSchema = upstreamSchema.partial().extend({ apiKey: z.string().min(1).max(4096).optional() });

const modelAliasSchema = z.object({
  publicId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
  upstreamModel: z.string().min(1).max(300),
  upstreamId: z.string().uuid().nullable().default(null),
  displayName: z.string().min(1).max(200),
  capabilities: z.array(z.enum(["text", "vision", "documents", "tools", "thinking", "streaming"])).min(1).default(["text", "streaming"]),
  inputPriceMicrosPerMillion: z.number().int().min(0).max(1_000_000_000_000).default(0),
  outputPriceMicrosPerMillion: z.number().int().min(0).max(1_000_000_000_000).default(0),
  enabled: z.boolean().default(true),
});

const settingsSchema = z.object({
  values: z.object({
    "ui.product_name": z.string().trim().min(1).max(80).optional(),
    "ui.compact_sidebar": z.boolean().optional(),
    "routing.strategy": z.enum(["weighted_least_loaded", "round_robin", "priority_only"]).optional(),
    "routing.max_attempts": z.number().int().min(1).max(5).optional(),
    "logging.request_retention_days": z.number().int().min(1).max(3650).optional(),
    "logging.audit_retention_days": z.number().int().min(30).max(3650).optional(),
  }).strict(),
});

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function presentKey(row: GatewayKeyRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    suffix: row.key_suffix,
    mode: row.mode,
    scopes: parseJson(row.scopes_json, []),
    allowedModels: parseJson(row.allowed_models_json, []),
    allowedIps: parseJson(row.allowed_ips_json, []),
    rpm: row.rpm,
    tpm: row.tpm,
    maxConcurrency: row.max_concurrency,
    dailyBudgetMicros: row.daily_budget_micros,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function presentUpstream(row: UpstreamRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    priority: row.priority,
    weight: row.weight,
    maxConcurrency: row.max_concurrency,
    enabled: Boolean(row.enabled),
    modelPrefix: row.model_prefix,
    timeoutMs: row.timeout_ms,
    healthStatus: row.health_status,
    failureCount: row.failure_count,
    cooldownUntil: row.cooldown_until,
    lastError: row.last_error,
    hasCredential: Boolean(row.encrypted_api_key),
    authScheme: row.auth_scheme,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function presentAlias(row: ModelAliasRow): Record<string, unknown> {
  return {
    id: row.id,
    publicId: row.public_id,
    upstreamModel: row.upstream_model,
    upstreamId: row.upstream_id,
    displayName: row.display_name,
    capabilities: parseJson(row.capabilities_json, []),
    inputPriceMicrosPerMillion: row.input_price_micros_per_million,
    outputPriceMicrosPerMillion: row.output_price_micros_per_million,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function generateGatewayKey(mode: ProtocolMode): string {
  const prefix = mode === "openai" ? "gw-oai" : mode === "anthropic" ? "gw-ant" : "gw-dual";
  return `${prefix}_${randomToken(32)}`;
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  auth: AdminAuthService,
  keys: Keyring,
): Promise<void> {
  app.post("/api/admin/v1/session", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    return auth.login(body.username, body.password, request, reply);
  });

  app.get("/api/admin/v1/session", async (request) => auth.refresh(request));

  app.delete("/api/admin/v1/session", async (request, reply) => {
    auth.logout(request, reply);
    return reply.code(204).send();
  });

  app.post("/api/admin/v1/password", async (request) => {
    const session = auth.require(request, true);
    const body = passwordChangeSchema.parse(request.body);
    const admin = db.get<{ password_hash: string }>("SELECT password_hash FROM admins WHERE id=?", session.adminId);
    if (!admin || !verifyPassword(body.currentPassword, admin.password_hash)) {
      db.audit(session.username, "admin.password_change_failed", "admin", session.adminId);
      throw new HttpError(401, "Current password is incorrect", "invalid_current_password");
    }
    db.transaction(() => {
      db.run("UPDATE admins SET password_hash=?,updated_at=? WHERE id=?", hashPassword(body.newPassword), db.now(), session.adminId);
      db.run("DELETE FROM sessions WHERE admin_id=? AND id_hash<>?", session.adminId, session.sessionHash);
      db.audit(session.username, "admin.password_change", "admin", session.adminId, { otherSessionsRevoked: true });
    });
    return { ok: true };
  });

  app.get("/api/admin/v1/dashboard", async (request) => {
    auth.require(request);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const aggregate = db.get<{
      requests: number;
      failures: number;
      input_tokens: number | null;
      output_tokens: number | null;
      cost_micros: number | null;
      avg_latency: number | null;
    }>(
      `SELECT COUNT(*) AS requests,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS failures,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cost_micros) AS cost_micros,
              AVG(latency_ms) AS avg_latency
       FROM request_logs WHERE created_at>=?`,
      since,
    );
    const series = db.all<{ hour: string; requests: number; failures: number }>(
      `SELECT strftime('%Y-%m-%dT%H:00:00Z', created_at) AS hour,
              COUNT(*) AS requests,
              SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS failures
       FROM request_logs WHERE created_at>=? GROUP BY hour ORDER BY hour`,
      since,
    );
    const upstreams = db.all<UpstreamRow>("SELECT * FROM upstreams ORDER BY priority,name").map(presentUpstream);
    return {
      period: "24h",
      requests: aggregate?.requests ?? 0,
      failures: aggregate?.failures ?? 0,
      inputTokens: aggregate?.input_tokens ?? 0,
      outputTokens: aggregate?.output_tokens ?? 0,
      costMicros: aggregate?.cost_micros ?? 0,
      averageLatencyMs: Math.round(aggregate?.avg_latency ?? 0),
      series,
      upstreams,
    };
  });

  app.get("/api/admin/v1/keys", async (request) => {
    auth.require(request);
    return { items: db.all<GatewayKeyRow>("SELECT * FROM gateway_keys ORDER BY created_at DESC").map(presentKey) };
  });

  app.post("/api/admin/v1/keys", async (request, reply) => {
    const session = auth.require(request, true);
    const body = gatewayKeySchema.parse(request.body);
    const id = randomUUID();
    const rawKey = generateGatewayKey(body.mode);
    const now = db.now();
    db.run(
      `INSERT INTO gateway_keys(
        id,name,key_hash,key_prefix,key_suffix,mode,scopes_json,allowed_models_json,allowed_ips_json,
        rpm,tpm,max_concurrency,daily_budget_micros,expires_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      body.name,
      hmacHex(keys.gatewayHmac, rawKey),
      rawKey.slice(0, rawKey.indexOf("_") + 7),
      rawKey.slice(-4),
      body.mode,
      JSON.stringify(["inference"]),
      JSON.stringify(body.allowedModels),
      JSON.stringify(body.allowedIps),
      body.rpm,
      body.tpm,
      body.maxConcurrency,
      body.dailyBudgetMicros,
      body.expiresAt,
      now,
    );
    db.audit(session.username, "gateway_key.create", "gateway_key", id, { name: body.name, mode: body.mode });
    return reply.code(201).send({ id, apiKey: rawKey, revealOnce: true });
  });

  app.post<{ Params: { id: string } }>("/api/admin/v1/keys/:id/revoke", async (request) => {
    const session = auth.require(request, true);
    const existing = db.get<GatewayKeyRow>("SELECT * FROM gateway_keys WHERE id=?", request.params.id);
    if (!existing) throw new HttpError(404, "Gateway key not found", "not_found");
    db.run("UPDATE gateway_keys SET revoked_at=? WHERE id=?", db.now(), existing.id);
    db.audit(session.username, "gateway_key.revoke", "gateway_key", existing.id, { name: existing.name });
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/v1/keys/:id", async (request) => {
    const session = auth.require(request, true);
    const body = gatewayKeyPatchSchema.parse(request.body);
    const existing = db.get<GatewayKeyRow>("SELECT * FROM gateway_keys WHERE id=?", request.params.id);
    if (!existing) throw new HttpError(404, "Gateway key not found", "not_found");
    db.run(
      `UPDATE gateway_keys SET name=?,allowed_models_json=?,allowed_ips_json=?,rpm=?,tpm=?,max_concurrency=?,
       daily_budget_micros=?,expires_at=? WHERE id=?`,
      body.name ?? existing.name,
      JSON.stringify(body.allowedModels ?? parseJson(existing.allowed_models_json, [])),
      JSON.stringify(body.allowedIps ?? parseJson(existing.allowed_ips_json, [])),
      body.rpm ?? existing.rpm,
      body.tpm ?? existing.tpm,
      body.maxConcurrency ?? existing.max_concurrency,
      body.dailyBudgetMicros === undefined ? existing.daily_budget_micros : body.dailyBudgetMicros,
      body.expiresAt === undefined ? existing.expires_at : body.expiresAt,
      existing.id,
    );
    db.audit(session.username, "gateway_key.update", "gateway_key", existing.id, { fields: Object.keys(body) });
    return presentKey(db.get<GatewayKeyRow>("SELECT * FROM gateway_keys WHERE id=?", existing.id)!);
  });

  app.delete<{ Params: { id: string } }>("/api/admin/v1/keys/:id", async (request, reply) => {
    const session = auth.require(request, true);
    const existing = db.get<GatewayKeyRow>("SELECT * FROM gateway_keys WHERE id=?", request.params.id);
    if (!existing) throw new HttpError(404, "Gateway key not found", "not_found");
    db.run("DELETE FROM gateway_keys WHERE id=?", existing.id);
    db.audit(session.username, "gateway_key.delete", "gateway_key", existing.id, { name: existing.name });
    return reply.code(204).send();
  });

  app.get("/api/admin/v1/upstreams", async (request) => {
    auth.require(request);
    return { items: db.all<UpstreamRow>("SELECT * FROM upstreams ORDER BY priority,name").map(presentUpstream) };
  });

  app.post("/api/admin/v1/upstreams", async (request, reply) => {
    const session = auth.require(request, true);
    const body = upstreamSchema.parse(request.body);
    const url = validateUpstreamUrl(body.kind, body.baseUrl);
    await assertPublicDestination(url);
    const id = randomUUID();
    const now = db.now();
    db.run(
      `INSERT INTO upstreams(
        id,name,kind,base_url,encrypted_api_key,auth_scheme,priority,weight,max_concurrency,enabled,model_prefix,timeout_ms,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      body.name,
      body.kind,
      url.toString().replace(/\/$/, ""),
      encryptSecret(keys.encryption, body.apiKey, `upstream:${id}`),
      body.kind === "anthropic" ? "x-api-key" : body.authScheme,
      body.priority,
      body.weight,
      body.maxConcurrency,
      body.enabled ? 1 : 0,
      body.modelPrefix,
      body.timeoutMs,
      now,
      now,
    );
    db.audit(session.username, "upstream.create", "upstream", id, { name: body.name, kind: body.kind, origin: url.origin });
    return reply.code(201).send(presentUpstream(db.get<UpstreamRow>("SELECT * FROM upstreams WHERE id=?", id)!));
  });

  app.patch<{ Params: { id: string } }>("/api/admin/v1/upstreams/:id", async (request) => {
    const session = auth.require(request, true);
    const body = upstreamPatchSchema.parse(request.body);
    const current = db.get<UpstreamRow>("SELECT * FROM upstreams WHERE id=?", request.params.id);
    if (!current) throw new HttpError(404, "Upstream not found", "not_found");
    const kind = (body.kind ?? current.kind) as UpstreamKind;
    const rawBaseUrl = body.baseUrl ?? current.base_url;
    const url = validateUpstreamUrl(kind, rawBaseUrl);
    await assertPublicDestination(url);
    const encryptedKey = body.apiKey
      ? encryptSecret(keys.encryption, body.apiKey, `upstream:${current.id}`)
      : current.encrypted_api_key;
    db.run(
      `UPDATE upstreams SET name=?,kind=?,base_url=?,encrypted_api_key=?,auth_scheme=?,priority=?,weight=?,max_concurrency=?,
       enabled=?,model_prefix=?,timeout_ms=?,updated_at=? WHERE id=?`,
      body.name ?? current.name,
      kind,
      url.toString().replace(/\/$/, ""),
      encryptedKey,
      kind === "anthropic" ? "x-api-key" : (body.authScheme ?? current.auth_scheme),
      body.priority ?? current.priority,
      body.weight ?? current.weight,
      body.maxConcurrency ?? current.max_concurrency,
      (body.enabled ?? Boolean(current.enabled)) ? 1 : 0,
      body.modelPrefix ?? current.model_prefix,
      body.timeoutMs ?? current.timeout_ms,
      db.now(),
      current.id,
    );
    db.audit(session.username, "upstream.update", "upstream", current.id, { fields: Object.keys(body) });
    return presentUpstream(db.get<UpstreamRow>("SELECT * FROM upstreams WHERE id=?", current.id)!);
  });

  app.delete<{ Params: { id: string } }>("/api/admin/v1/upstreams/:id", async (request, reply) => {
    const session = auth.require(request, true);
    const current = db.get<UpstreamRow>("SELECT * FROM upstreams WHERE id=?", request.params.id);
    if (!current) throw new HttpError(404, "Upstream not found", "not_found");
    db.run("DELETE FROM upstreams WHERE id=?", current.id);
    db.audit(session.username, "upstream.delete", "upstream", current.id, { name: current.name });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/admin/v1/upstreams/:id/check", async (request) => {
    const session = auth.require(request, true);
    const current = db.get<UpstreamRow>("SELECT * FROM upstreams WHERE id=?", request.params.id);
    if (!current) throw new HttpError(404, "Upstream not found", "not_found");
    const url = joinUpstreamPath(current.base_url, "/v1/models");
    await assertPublicDestination(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(current.timeout_ms, 15_000));
    let status = "degraded";
    let detail = "Connection failed";
    try {
      const credential = (await import("../security/crypto.js")).decryptSecret(keys.encryption, current.encrypted_api_key, `upstream:${current.id}`);
      const credentialHeaders = current.auth_scheme === "bearer"
        ? { authorization: `Bearer ${credential}` }
        : { "x-api-key": credential };
      const response = await fetch(url, {
        method: "GET",
        headers: { ...credentialHeaders, "anthropic-version": "2023-06-01" },
        redirect: "error",
        signal: controller.signal,
      });
      status = response.ok ? "healthy" : "degraded";
      detail = response.ok ? `HTTP ${response.status}` : `HTTP ${response.status}: upstream rejected the health check`;
    } catch (error) {
      detail = error instanceof Error ? error.message.slice(0, 300) : "Connection failed";
    } finally {
      clearTimeout(timeout);
    }
    db.run(
      "UPDATE upstreams SET health_status=?,failure_count=?,last_error=?,updated_at=? WHERE id=?",
      status,
      status === "healthy" ? 0 : current.failure_count + 1,
      status === "healthy" ? null : detail,
      db.now(),
      current.id,
    );
    db.audit(session.username, "upstream.health_check", "upstream", current.id, { status });
    return { status, detail };
  });

  app.get("/api/admin/v1/models", async (request) => {
    auth.require(request);
    return { items: db.all<ModelAliasRow>("SELECT * FROM model_aliases ORDER BY public_id").map(presentAlias) };
  });

  app.post("/api/admin/v1/models", async (request, reply) => {
    const session = auth.require(request, true);
    const body = modelAliasSchema.parse(request.body);
    if (body.upstreamId && !db.get("SELECT id FROM upstreams WHERE id=?", body.upstreamId)) {
      throw new HttpError(400, "Bound upstream does not exist", "invalid_upstream");
    }
    const id = randomUUID();
    const now = db.now();
    try {
      db.run(
        `INSERT INTO model_aliases(
          id,public_id,upstream_model,upstream_id,display_name,capabilities_json,
          input_price_micros_per_million,output_price_micros_per_million,enabled,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        body.publicId,
        body.upstreamModel,
        body.upstreamId,
        body.displayName,
        JSON.stringify(body.capabilities),
        body.inputPriceMicrosPerMillion,
        body.outputPriceMicrosPerMillion,
        body.enabled ? 1 : 0,
        now,
        now,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) throw new HttpError(409, "Public model ID already exists", "model_exists");
      throw error;
    }
    db.audit(session.username, "model_alias.create", "model_alias", id, { publicId: body.publicId });
    return reply.code(201).send(presentAlias(db.get<ModelAliasRow>("SELECT * FROM model_aliases WHERE id=?", id)!));
  });

  app.patch<{ Params: { id: string } }>("/api/admin/v1/models/:id", async (request) => {
    const session = auth.require(request, true);
    const body = modelAliasSchema.partial().parse(request.body);
    const current = db.get<ModelAliasRow>("SELECT * FROM model_aliases WHERE id=?", request.params.id);
    if (!current) throw new HttpError(404, "Model alias not found", "not_found");
    const nextUpstreamId = body.upstreamId === undefined ? current.upstream_id : body.upstreamId;
    if (nextUpstreamId && !db.get("SELECT id FROM upstreams WHERE id=?", nextUpstreamId)) throw new HttpError(400, "Bound upstream does not exist", "invalid_upstream");
    db.run(
      `UPDATE model_aliases SET public_id=?,upstream_model=?,upstream_id=?,display_name=?,capabilities_json=?,
       input_price_micros_per_million=?,output_price_micros_per_million=?,enabled=?,updated_at=? WHERE id=?`,
      body.publicId ?? current.public_id,
      body.upstreamModel ?? current.upstream_model,
      nextUpstreamId,
      body.displayName ?? current.display_name,
      JSON.stringify(body.capabilities ?? parseJson(current.capabilities_json, [])),
      body.inputPriceMicrosPerMillion ?? current.input_price_micros_per_million,
      body.outputPriceMicrosPerMillion ?? current.output_price_micros_per_million,
      (body.enabled ?? Boolean(current.enabled)) ? 1 : 0,
      db.now(),
      current.id,
    );
    db.audit(session.username, "model_alias.update", "model_alias", current.id, { fields: Object.keys(body) });
    return presentAlias(db.get<ModelAliasRow>("SELECT * FROM model_aliases WHERE id=?", current.id)!);
  });

  app.delete<{ Params: { id: string } }>("/api/admin/v1/models/:id", async (request, reply) => {
    const session = auth.require(request, true);
    const current = db.get<ModelAliasRow>("SELECT * FROM model_aliases WHERE id=?", request.params.id);
    if (!current) throw new HttpError(404, "Model alias not found", "not_found");
    db.run("DELETE FROM model_aliases WHERE id=?", current.id);
    db.audit(session.username, "model_alias.delete", "model_alias", current.id, { publicId: current.public_id });
    return reply.code(204).send();
  });

  app.get("/api/admin/v1/requests", async (request) => {
    auth.require(request);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return { items: db.all("SELECT * FROM request_logs ORDER BY created_at DESC LIMIT ?", query.limit) };
  });

  app.get("/api/admin/v1/audit", async (request) => {
    auth.require(request);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return {
      items: db.all<{ metadata_json: string } & Record<string, unknown>>("SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?", query.limit)
        .map((row) => ({ ...row, metadata: parseJson(row.metadata_json, {}), metadata_json: undefined })),
    };
  });

  app.get("/api/admin/v1/settings", async (request) => {
    auth.require(request);
    return {
      values: Object.fromEntries(db.all<{ key: string; value_json: string }>("SELECT key,value_json FROM settings").map((row) => [row.key, parseJson(row.value_json, null)])),
    };
  });

  app.put("/api/admin/v1/settings", async (request) => {
    const session = auth.require(request, true);
    const body = settingsSchema.parse(request.body);
    const now = db.now();
    db.transaction(() => {
      for (const [key, value] of Object.entries(body.values)) {
        db.run(
          "INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
          key,
          JSON.stringify(value),
          now,
        );
      }
    });
    db.audit(session.username, "settings.update", "settings", undefined, { keys: Object.keys(body.values) });
    return { ok: true };
  });
}
