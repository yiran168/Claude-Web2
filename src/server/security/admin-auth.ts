import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { HttpError } from "../http-error.js";
import { hmacHex, randomToken, safeEqualHex, type Keyring, verifyPassword } from "./crypto.js";

interface AdminRow {
  id: string;
  username: string;
  password_hash: string;
}

interface SessionRow {
  id_hash: string;
  admin_id: string;
  csrf_hash: string;
  expires_at: string;
  username: string;
}

export interface AdminSession {
  adminId: string;
  username: string;
  sessionHash: string;
}

interface AttemptBucket {
  firstAt: number;
  failures: number;
  blockedUntil: number;
}

export class AdminAuthService {
  private readonly attempts = new Map<string, AttemptBucket>();
  private readonly cookieName = "cw2_session";

  constructor(
    private readonly db: AppDatabase,
    private readonly config: AppConfig,
    private readonly keys: Keyring,
  ) {}

  login(username: string, password: string, request: FastifyRequest, reply: FastifyReply): { username: string; csrfToken: string; expiresAt: string } {
    const attemptKey = request.ip;
    this.assertLoginAllowed(attemptKey);
    const admin = this.db.get<AdminRow>("SELECT id,username,password_hash FROM admins WHERE username=?", username);
    if (!admin || !verifyPassword(password, admin.password_hash)) {
      this.recordFailure(attemptKey);
      this.db.audit(`ip:${request.ip}`, "session.login_failed", "admin", username);
      throw new HttpError(401, "Invalid username or password", "invalid_credentials");
    }

    this.attempts.delete(attemptKey);
    const result = this.createSession(admin.id, admin.username, request, reply);
    this.db.audit(admin.username, "session.login", "session", result.sessionHash.slice(0, 12), { ip: request.ip, method: "password" });
    return { username: result.username, csrfToken: result.csrfToken, expiresAt: result.expiresAt };
  }

  createOidcSession(adminId: string, username: string, request: FastifyRequest, reply: FastifyReply): { username: string; csrfToken: string; expiresAt: string } {
    const result = this.createSession(adminId, username, request, reply);
    this.db.audit(username, "session.login", "session", result.sessionHash.slice(0, 12), { ip: request.ip, method: "oidc" });
    return { username: result.username, csrfToken: result.csrfToken, expiresAt: result.expiresAt };
  }

  private createSession(adminId: string, username: string, request: FastifyRequest, reply: FastifyReply): { username: string; csrfToken: string; expiresAt: string; sessionHash: string } {
    const existingToken = request.cookies[this.cookieName];
    if (existingToken) this.db.run("DELETE FROM sessions WHERE id_hash=?", hmacHex(this.keys.sessionHmac, existingToken));
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const sessionHash = hmacHex(this.keys.sessionHmac, token);
    const csrfHash = hmacHex(this.keys.csrfHmac, csrfToken);
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const now = this.db.now();
    this.db.run("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.db.run(
      "INSERT INTO sessions(id_hash,admin_id,csrf_hash,expires_at,ip,user_agent,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?)",
      sessionHash,
      adminId,
      csrfHash,
      expiresAt,
      request.ip,
      request.headers["user-agent"]?.slice(0, 512) ?? null,
      now,
      now,
    );
    this.setCookie(reply, token, expiresAt);
    return { username, csrfToken, expiresAt, sessionHash };
  }

  require(request: FastifyRequest, requireCsrf = false): AdminSession {
    const rawToken = request.cookies[this.cookieName];
    if (!rawToken) throw new HttpError(401, "Administrator session required", "admin_auth_required");
    const sessionHash = hmacHex(this.keys.sessionHmac, rawToken);
    const row = this.db.get<SessionRow>(
      `SELECT s.id_hash,s.admin_id,s.csrf_hash,s.expires_at,a.username
       FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.id_hash=?`,
      sessionHash,
    );
    if (!row || Date.parse(row.expires_at) <= Date.now()) {
      if (row) this.db.run("DELETE FROM sessions WHERE id_hash=?", sessionHash);
      throw new HttpError(401, "Administrator session expired", "admin_session_expired");
    }
    if (requireCsrf) {
      const csrf = request.headers["x-cw2-csrf"];
      if (typeof csrf !== "string" || !safeEqualHex(hmacHex(this.keys.csrfHmac, csrf), row.csrf_hash)) {
        throw new HttpError(403, "Invalid CSRF token", "invalid_csrf");
      }
    }
    this.db.run("UPDATE sessions SET last_seen_at=? WHERE id_hash=?", this.db.now(), sessionHash);
    return { adminId: row.admin_id, username: row.username, sessionHash };
  }

  refresh(request: FastifyRequest): { username: string; csrfToken: string; expiresAt: string } {
    const session = this.require(request);
    const csrfToken = randomToken(24);
    const csrfHash = hmacHex(this.keys.csrfHmac, csrfToken);
    this.db.run("UPDATE sessions SET csrf_hash=? WHERE id_hash=?", csrfHash, session.sessionHash);
    const row = this.db.get<{ expires_at: string }>("SELECT expires_at FROM sessions WHERE id_hash=?", session.sessionHash);
    return { username: session.username, csrfToken, expiresAt: row?.expires_at ?? new Date().toISOString() };
  }

  logout(request: FastifyRequest, reply: FastifyReply): void {
    const session = this.require(request, true);
    this.db.run("DELETE FROM sessions WHERE id_hash=?", session.sessionHash);
    reply.clearCookie(this.cookieName, { path: "/" });
    this.db.audit(session.username, "session.logout", "session", session.sessionHash.slice(0, 12));
  }

  private setCookie(reply: FastifyReply, token: string, expiresAt: string): void {
    reply.setCookie(this.cookieName, token, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: this.config.secureCookies,
      expires: new Date(expiresAt),
    });
  }

  private assertLoginAllowed(key: string): void {
    const bucket = this.attempts.get(key);
    if (bucket && bucket.blockedUntil > Date.now()) {
      throw new HttpError(429, "Too many failed login attempts. Try again later.", "login_rate_limited");
    }
  }

  private recordFailure(key: string): void {
    const now = Date.now();
    const existing = this.attempts.get(key);
    const bucket = !existing || now - existing.firstAt > 15 * 60_000
      ? { firstAt: now, failures: 0, blockedUntil: 0 }
      : existing;
    bucket.failures += 1;
    if (bucket.failures >= 5) bucket.blockedUntil = now + 15 * 60_000;
    this.attempts.set(key, bucket);
  }
}
