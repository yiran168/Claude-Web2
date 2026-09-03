import { createHash, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { HttpError } from "../http-error.js";
import { assertPublicDestination } from "./network.js";
import type { AdminAuthService } from "./admin-auth.js";
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  hmacHex,
  randomToken,
  safeEqualHex,
  type Keyring,
} from "./crypto.js";

export type OidcTokenAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

interface OidcConfigRow {
  id: number;
  enabled: number;
  provider_name: string;
  issuer: string;
  client_id: string;
  encrypted_client_secret: string | null;
  token_auth_method: OidcTokenAuthMethod;
  scopes_json: string;
  username_claim: string;
  groups_claim: string;
  allowed_groups_json: string;
  auto_provision: number;
  created_at: string;
  updated_at: string;
}

interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported?: string[];
}

interface FlowPayload {
  verifier: string;
  nonce: string;
  redirectUri: string;
  bindingHash: string;
  mode: "login" | "link";
  adminId?: string;
}

interface AdminRow {
  id: string;
  username: string;
}

export interface OidcConfigInput {
  enabled: boolean;
  providerName: string;
  issuer: string;
  clientId: string;
  clientSecret?: string | undefined;
  clearClientSecret: boolean;
  tokenAuthMethod: OidcTokenAuthMethod;
  scopes: string[];
  usernameClaim: string;
  groupsClaim: string;
  allowedGroups: string[];
  autoProvision: boolean;
}

const metadataSchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  jwks_uri: z.string().min(1),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
});

const tokenSchema = z.object({
  id_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
}).passthrough();

const jwksSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
});

const allowedAlgorithms = ["RS256", "PS256", "ES256", "EdDSA"] as const;
const oidcCookieName = "cw2_oidc_tx";

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function normalizeIssuer(raw: string): string {
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "OIDC issuer is not a valid URL", "invalid_oidc_issuer");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new HttpError(400, "OIDC issuer must be a public HTTPS URL without credentials, query, or fragment", "invalid_oidc_issuer");
  }
  return url.pathname === "/" ? url.origin : url.toString();
}

function secureEndpoint(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `${label} is not a valid URL`, "invalid_oidc_metadata");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new HttpError(400, `${label} must be a public HTTPS URL without embedded credentials or a fragment`, "invalid_oidc_metadata");
  }
  return url;
}

function oauthFormEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function claimStrings(payload: JWTPayload, name: string): string[] {
  const value = payload[name];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return [];
}

function safeUsername(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  return normalized;
}

export class OidcService {
  private metadataCache: { issuer: string; value: OidcMetadata; expiresAt: number } | undefined;

  constructor(
    private readonly db: AppDatabase,
    private readonly config: AppConfig,
    private readonly keys: Keyring,
    private readonly adminAuth: AdminAuthService,
  ) {}

  publicConfig(): Record<string, unknown> {
    const row = this.readConfig();
    const enabled = Boolean(row?.enabled) && Boolean(this.config.publicUrl);
    return {
      enabled,
      providerName: row?.provider_name ?? "Single sign-on",
      callbackUrl: this.config.publicUrl ? `${this.config.publicUrl}/api/admin/v1/oidc/callback` : null,
    };
  }

  adminConfig(): Record<string, unknown> {
    const row = this.readConfig();
    return {
      enabled: Boolean(row?.enabled),
      providerName: row?.provider_name ?? "Single sign-on",
      issuer: row?.issuer ?? "",
      clientId: row?.client_id ?? "",
      hasClientSecret: Boolean(row?.encrypted_client_secret),
      tokenAuthMethod: row?.token_auth_method ?? "client_secret_basic",
      scopes: row ? parseJson<string[]>(row.scopes_json, ["openid", "profile", "email"]) : ["openid", "profile", "email"],
      usernameClaim: row?.username_claim ?? "preferred_username",
      groupsClaim: row?.groups_claim ?? "groups",
      allowedGroups: row ? parseJson<string[]>(row.allowed_groups_json, []) : [],
      autoProvision: Boolean(row?.auto_provision),
      callbackUrl: this.config.publicUrl ? `${this.config.publicUrl}/api/admin/v1/oidc/callback` : null,
    };
  }

  async configure(input: OidcConfigInput, actor: string): Promise<Record<string, unknown>> {
    const issuer = normalizeIssuer(input.issuer);
    const scopes = [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))];
    if (!scopes.includes("openid")) throw new HttpError(400, "OIDC scopes must include openid", "invalid_oidc_scopes");
    if (input.enabled && !this.config.publicUrl) {
      throw new HttpError(400, "CW2_PUBLIC_URL must be configured before enabling OIDC", "oidc_public_url_required");
    }
    const current = this.readConfig();
    let encryptedSecret = input.clearClientSecret ? null : current?.encrypted_client_secret ?? null;
    if (input.clientSecret) encryptedSecret = encryptSecret(this.keys.encryption, input.clientSecret, "oidc:client-secret");
    if (input.tokenAuthMethod !== "none" && !encryptedSecret) {
      throw new HttpError(400, "A client secret is required for the selected token authentication method", "oidc_client_secret_required");
    }
    if (input.tokenAuthMethod === "none") encryptedSecret = null;
    if (input.enabled) await this.discover(issuer, true);

    const now = this.db.now();
    this.db.run(
      `INSERT INTO oidc_config(
        id,enabled,provider_name,issuer,client_id,encrypted_client_secret,token_auth_method,scopes_json,
        username_claim,groups_claim,allowed_groups_json,auto_provision,created_at,updated_at
      ) VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,provider_name=excluded.provider_name,issuer=excluded.issuer,
        client_id=excluded.client_id,encrypted_client_secret=excluded.encrypted_client_secret,
        token_auth_method=excluded.token_auth_method,scopes_json=excluded.scopes_json,username_claim=excluded.username_claim,
        groups_claim=excluded.groups_claim,allowed_groups_json=excluded.allowed_groups_json,
        auto_provision=excluded.auto_provision,updated_at=excluded.updated_at`,
      input.enabled ? 1 : 0,
      input.providerName,
      issuer,
      input.clientId,
      encryptedSecret,
      input.tokenAuthMethod,
      JSON.stringify(scopes),
      input.usernameClaim,
      input.groupsClaim,
      JSON.stringify([...new Set(input.allowedGroups.map((group) => group.trim()).filter(Boolean))]),
      input.autoProvision ? 1 : 0,
      current?.created_at ?? now,
      now,
    );
    this.metadataCache = undefined;
    this.db.audit(actor, "oidc.configure", "oidc_provider", undefined, {
      enabled: input.enabled,
      issuer,
      tokenAuthMethod: input.tokenAuthMethod,
      autoProvision: input.autoProvision,
    });
    return this.adminConfig();
  }

  async test(actor: string): Promise<{ ok: true; issuer: string; authorizationEndpoint: string }> {
    const row = this.requireConfig(false);
    const metadata = await this.discover(row.issuer, true);
    this.db.audit(actor, "oidc.discovery_test", "oidc_provider", undefined, { issuer: row.issuer, ok: true });
    return { ok: true, issuer: metadata.issuer, authorizationEndpoint: metadata.authorization_endpoint };
  }

  async begin(mode: "login" | "link", reply: FastifyReply, adminId?: string): Promise<string> {
    const row = this.requireConfig(true);
    if (!this.config.publicUrl) throw new HttpError(503, "OIDC public URL is not configured", "oidc_unavailable");
    if (mode === "link" && !adminId) throw new HttpError(400, "Administrator identity is required", "invalid_oidc_link");
    const metadata = await this.discover(row.issuer);
    const state = randomToken(32);
    const verifier = randomToken(64);
    const nonce = randomToken(32);
    const binding = randomToken(32);
    const stateHash = hmacHex(this.keys.csrfHmac, state);
    const redirectUri = `${this.config.publicUrl}/api/admin/v1/oidc/callback`;
    const flow: FlowPayload = {
      verifier,
      nonce,
      redirectUri,
      bindingHash: hmacHex(this.keys.sessionHmac, binding),
      mode,
      ...(adminId ? { adminId } : {}),
    };
    const now = this.db.now();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.db.run("DELETE FROM oidc_flows WHERE expires_at<=?", now);
    this.db.run(
      "INSERT INTO oidc_flows(state_hash,encrypted_payload,expires_at,created_at) VALUES(?,?,?,?)",
      stateHash,
      encryptSecret(this.keys.encryption, JSON.stringify(flow), `oidc-flow:${stateHash}`),
      expiresAt,
      now,
    );
    reply.setCookie(oidcCookieName, binding, {
      path: "/api/admin/v1/oidc/callback",
      httpOnly: true,
      sameSite: "lax",
      secure: this.config.secureCookies,
      maxAge: 10 * 60,
    });

    const authorizationUrl = secureEndpoint(metadata.authorization_endpoint, "OIDC authorization endpoint");
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", row.client_id);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("scope", parseJson<string[]>(row.scopes_json, ["openid"]).join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    return authorizationUrl.toString();
  }

  async complete(
    query: { code?: string | undefined; state?: string | undefined; error?: string | undefined },
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ username: string }> {
    const state = query.state;
    if (!state || state.length > 512) throw new HttpError(400, "OIDC state is missing or invalid", "invalid_oidc_state");
    const stateHash = hmacHex(this.keys.csrfHmac, state);
    const flowRow = this.db.get<{ encrypted_payload: string; expires_at: string }>(
      "SELECT encrypted_payload,expires_at FROM oidc_flows WHERE state_hash=?",
      stateHash,
    );
    this.db.run("DELETE FROM oidc_flows WHERE state_hash=?", stateHash);
    reply.clearCookie(oidcCookieName, { path: "/api/admin/v1/oidc/callback" });
    if (!flowRow || Date.parse(flowRow.expires_at) <= Date.now()) {
      throw new HttpError(400, "OIDC transaction expired or was already used", "invalid_oidc_state");
    }
    const flow = JSON.parse(decryptSecret(this.keys.encryption, flowRow.encrypted_payload, `oidc-flow:${stateHash}`)) as FlowPayload;
    const binding = request.cookies[oidcCookieName];
    if (!binding || !safeEqualHex(hmacHex(this.keys.sessionHmac, binding), flow.bindingHash)) {
      throw new HttpError(400, "OIDC browser transaction did not match", "invalid_oidc_transaction");
    }
    if (query.error) throw new HttpError(401, "Identity provider denied the authorization request", "oidc_authorization_denied");
    if (!query.code || query.code.length > 4096) throw new HttpError(400, "OIDC authorization code is missing or invalid", "invalid_oidc_code");

    const row = this.requireConfig(true);
    const metadata = await this.discover(row.issuer);
    const idToken = await this.exchangeCode(row, metadata, query.code, flow);
    const claims = await this.verifyIdToken(row, metadata, idToken, flow.nonce);
    this.enforceGroups(row, claims);
    const admin = this.resolveIdentity(row, claims, flow);
    this.adminAuth.createOidcSession(admin.id, admin.username, request, reply);
    return { username: admin.username };
  }

  private readConfig(): OidcConfigRow | undefined {
    return this.db.get<OidcConfigRow>("SELECT * FROM oidc_config WHERE id=1");
  }

  private requireConfig(mustBeEnabled: boolean): OidcConfigRow {
    const row = this.readConfig();
    if (!row || (mustBeEnabled && !row.enabled)) throw new HttpError(503, "OIDC is not enabled", "oidc_unavailable");
    return row;
  }

  private async discover(issuer: string, force = false): Promise<OidcMetadata> {
    if (!force && this.metadataCache?.issuer === issuer && this.metadataCache.expiresAt > Date.now()) return this.metadataCache.value;
    const discoveryUrl = secureEndpoint(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, "OIDC discovery endpoint");
    const raw = await this.fetchJson(discoveryUrl, { method: "GET", headers: { accept: "application/json" } });
    const metadata = metadataSchema.parse(raw) as OidcMetadata;
    if (metadata.issuer !== issuer) throw new HttpError(400, "OIDC discovery issuer did not exactly match the configured issuer", "oidc_issuer_mismatch");
    for (const [label, endpoint] of [
      ["OIDC authorization endpoint", metadata.authorization_endpoint],
      ["OIDC token endpoint", metadata.token_endpoint],
      ["OIDC JWKS endpoint", metadata.jwks_uri],
    ] as const) {
      const url = secureEndpoint(endpoint, label);
      await assertPublicDestination(url);
    }
    this.metadataCache = { issuer, value: metadata, expiresAt: Date.now() + 5 * 60_000 };
    return metadata;
  }

  private async exchangeCode(row: OidcConfigRow, metadata: OidcMetadata, code: string, flow: FlowPayload): Promise<string> {
    const tokenUrl = secureEndpoint(metadata.token_endpoint, "OIDC token endpoint");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    });
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    };
    const secret = row.encrypted_client_secret
      ? decryptSecret(this.keys.encryption, row.encrypted_client_secret, "oidc:client-secret")
      : undefined;
    if (row.token_auth_method === "client_secret_basic") {
      if (!secret) throw new HttpError(500, "OIDC client secret is unavailable", "oidc_configuration_error");
      headers.authorization = `Basic ${Buffer.from(`${oauthFormEncode(row.client_id)}:${oauthFormEncode(secret)}`).toString("base64")}`;
    } else {
      body.set("client_id", row.client_id);
      if (row.token_auth_method === "client_secret_post") {
        if (!secret) throw new HttpError(500, "OIDC client secret is unavailable", "oidc_configuration_error");
        body.set("client_secret", secret);
      }
    }
    const raw = await this.fetchJson(tokenUrl, { method: "POST", headers, body: body.toString() });
    return tokenSchema.parse(raw).id_token;
  }

  private async verifyIdToken(row: OidcConfigRow, metadata: OidcMetadata, idToken: string, expectedNonce: string): Promise<JWTPayload> {
    const header = decodeProtectedHeader(idToken);
    if (!header.alg || !allowedAlgorithms.includes(header.alg as (typeof allowedAlgorithms)[number])) {
      throw new HttpError(401, "OIDC ID token uses an unsupported signature algorithm", "invalid_oidc_token");
    }
    const providerAlgorithms = metadata.id_token_signing_alg_values_supported;
    if (providerAlgorithms && !providerAlgorithms.includes(header.alg)) {
      throw new HttpError(401, "OIDC ID token algorithm was not advertised by the provider", "invalid_oidc_token");
    }
    const jwksUrl = secureEndpoint(metadata.jwks_uri, "OIDC JWKS endpoint");
    const rawJwks = jwksSchema.parse(await this.fetchJson(jwksUrl, { method: "GET", headers: { accept: "application/json" } }));
    const keySet = createLocalJWKSet(rawJwks as JSONWebKeySet);
    const verified = await jwtVerify(idToken, keySet, {
      issuer: row.issuer,
      audience: row.client_id,
      algorithms: [...allowedAlgorithms],
      clockTolerance: "60 seconds",
      maxTokenAge: "10 minutes",
    });
    const nonce = typeof verified.payload.nonce === "string" ? verified.payload.nonce : "";
    if (!safeEqualHex(hmacHex(this.keys.csrfHmac, nonce), hmacHex(this.keys.csrfHmac, expectedNonce))) {
      throw new HttpError(401, "OIDC nonce validation failed", "invalid_oidc_token");
    }
    const audiences = Array.isArray(verified.payload.aud) ? verified.payload.aud : [verified.payload.aud].filter(Boolean);
    if ((audiences.length > 1 || verified.payload.azp !== undefined) && verified.payload.azp !== row.client_id) {
      throw new HttpError(401, "OIDC authorized party validation failed", "invalid_oidc_token");
    }
    if (!verified.payload.sub) throw new HttpError(401, "OIDC subject claim is missing", "invalid_oidc_token");
    return verified.payload;
  }

  private enforceGroups(row: OidcConfigRow, claims: JWTPayload): void {
    const allowed = parseJson<string[]>(row.allowed_groups_json, []);
    if (allowed.length === 0) return;
    const actual = new Set(claimStrings(claims, row.groups_claim));
    if (!allowed.some((group) => actual.has(group))) {
      throw new HttpError(403, "OIDC identity is not a member of an allowed group", "oidc_group_denied");
    }
  }

  private resolveIdentity(row: OidcConfigRow, claims: JWTPayload, flow: FlowPayload): AdminRow {
    const subject = claims.sub!;
    const identity = this.db.get<{ admin_id: string }>(
      "SELECT admin_id FROM oidc_identities WHERE issuer=? AND subject=?",
      row.issuer,
      subject,
    );
    const claimedUsername = safeUsername(claims[row.username_claim])
      ?? safeUsername(claims.email)
      ?? `oidc-${createHash("sha256").update(subject).digest("hex").slice(0, 12)}`;
    const now = this.db.now();

    return this.db.transaction(() => {
      if (flow.mode === "link") {
        const target = flow.adminId ? this.db.get<AdminRow>("SELECT id,username FROM admins WHERE id=?", flow.adminId) : undefined;
        if (!target) throw new HttpError(400, "The administrator account for this link request no longer exists", "invalid_oidc_link");
        if (identity && identity.admin_id !== target.id) {
          throw new HttpError(409, "This OIDC identity is already linked to another administrator", "oidc_identity_conflict");
        }
        if (!identity) {
          this.db.run(
            "INSERT INTO oidc_identities(issuer,subject,admin_id,username_snapshot,created_at,last_login_at) VALUES(?,?,?,?,?,?)",
            row.issuer,
            subject,
            target.id,
            claimedUsername,
            now,
            now,
          );
        } else {
          this.db.run("UPDATE oidc_identities SET username_snapshot=?,last_login_at=? WHERE issuer=? AND subject=?", claimedUsername, now, row.issuer, subject);
        }
        this.db.audit(target.username, "oidc.identity_link", "admin", target.id, { issuer: row.issuer, subjectHash: createHash("sha256").update(subject).digest("hex").slice(0, 16) });
        return target;
      }

      if (identity) {
        const admin = this.db.get<AdminRow>("SELECT id,username FROM admins WHERE id=?", identity.admin_id);
        if (!admin) throw new HttpError(401, "Linked administrator account no longer exists", "oidc_identity_invalid");
        this.db.run("UPDATE oidc_identities SET username_snapshot=?,last_login_at=? WHERE issuer=? AND subject=?", claimedUsername, now, row.issuer, subject);
        return admin;
      }
      if (!row.auto_provision) throw new HttpError(403, "OIDC identity is not linked to an administrator", "oidc_identity_not_linked");

      let username = claimedUsername;
      if (this.db.get("SELECT id FROM admins WHERE username=?", username)) {
        username = `${username.slice(0, 110)}-${createHash("sha256").update(`${row.issuer}\u0000${subject}`).digest("hex").slice(0, 8)}`;
      }
      const adminId = randomUUID();
      this.db.run(
        "INSERT INTO admins(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)",
        adminId,
        username,
        hashPassword(randomToken(48)),
        now,
        now,
      );
      this.db.run(
        "INSERT INTO oidc_identities(issuer,subject,admin_id,username_snapshot,created_at,last_login_at) VALUES(?,?,?,?,?,?)",
        row.issuer,
        subject,
        adminId,
        claimedUsername,
        now,
        now,
      );
      this.db.audit(`oidc:${username}`, "admin.oidc_provision", "admin", adminId, { issuer: row.issuer });
      return { id: adminId, username };
    });
  }

  private async fetchJson(url: URL, init: RequestInit): Promise<unknown> {
    await assertPublicDestination(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > 1_048_576) throw new HttpError(400, "OIDC provider response was too large", "invalid_oidc_response");
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 1_048_576) throw new HttpError(400, "OIDC provider response was too large", "invalid_oidc_response");
      if (!response.ok) throw new HttpError(400, `OIDC provider returned HTTP ${response.status}`, "oidc_provider_error");
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new HttpError(400, "OIDC provider returned invalid JSON", "invalid_oidc_response");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "OIDC provider could not be reached", "oidc_provider_unreachable");
    } finally {
      clearTimeout(timeout);
    }
  }
}
