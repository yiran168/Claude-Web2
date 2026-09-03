import { randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function config(): AppConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "cw2-test-"));
  temporaryDirectories.push(dataDir);
  return {
    masterKey: randomBytes(32),
    adminPassword: "correct horse battery staple",
    adminUsername: "admin",
    host: "127.0.0.1",
    port: 0,
    dataDir,
    databasePath: join(dataDir, "test.db"),
    trustProxy: false,
    secureCookies: false,
    allowedOrigins: new Set(),
    logLevel: "silent",
  };
}

describe("admin and gateway integration", () => {
  it("serves a real HTTP listener and releases SQLite on shutdown", async () => {
    const appConfig = config();
    const app = await buildApp(appConfig);
    let closed = false;
    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address() as AddressInfo;
      const ready = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ status: "ready", database: "ok" });

      await app.close();
      closed = true;
      const databaseHandle = openSync(appConfig.databasePath, "r+");
      closeSync(databaseHandle);
    } finally {
      if (!closed) await app.close();
    }
  });

  it("requires session + CSRF and reveals gateway secrets once", async () => {
    const app = await buildApp(config());
    try {
      const login = await app.inject({ method: "POST", url: "/api/admin/v1/session", payload: { username: "admin", password: "correct horse battery staple" } });
      expect(login.statusCode).toBe(200);
      const session = login.json<{ csrfToken: string }>();
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;

      const missingCsrf = await app.inject({ method: "POST", url: "/api/admin/v1/keys", headers: { cookie }, payload: { name: "test", mode: "dual" } });
      expect(missingCsrf.statusCode).toBe(403);

      const created = await app.inject({
        method: "POST",
        url: "/api/admin/v1/keys",
        headers: { cookie, "x-cw2-csrf": session.csrfToken },
        payload: { name: "test", mode: "dual", allowedModels: [], allowedIps: [], rpm: 10, tpm: 1000, maxConcurrency: 2, dailyBudgetMicros: null, expiresAt: null },
      });
      expect(created.statusCode).toBe(201);
      const secret = created.json<{ apiKey: string }>().apiKey;
      expect(secret).toMatch(/^gw-dual_/);

      const listed = await app.inject({ method: "GET", url: "/api/admin/v1/keys", headers: { cookie } });
      expect(listed.statusCode).toBe(200);
      expect(listed.body).not.toContain(secret);

      const updatedKey = await app.inject({
        method: "PATCH",
        url: `/api/admin/v1/keys/${created.json<{ id: string }>().id}`,
        headers: { cookie, "x-cw2-csrf": session.csrfToken },
        payload: { name: "updated policy", rpm: 20, dailyBudgetMicros: 1_000_000 },
      });
      expect(updatedKey.statusCode).toBe(200);
      expect(updatedKey.json<{ name: string; rpm: number; dailyBudgetMicros: number }>()).toMatchObject({
        name: "updated policy",
        rpm: 20,
        dailyBudgetMicros: 1_000_000,
      });

      const model = await app.inject({
        method: "POST",
        url: "/api/admin/v1/models",
        headers: { cookie, "x-cw2-csrf": session.csrfToken },
        payload: { publicId: "claude-test", upstreamModel: "claude-real", upstreamId: null, displayName: "Claude Test", capabilities: ["text", "streaming"], enabled: true },
      });
      expect(model.statusCode).toBe(201);

      const publicModels = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${secret}` } });
      expect(publicModels.statusCode).toBe(200);
      expect(publicModels.json<{ data: Array<{ id: string }> }>().data[0]?.id).toBe("claude-test");

      const noUpstream = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${secret}` },
        payload: { model: "claude-test", messages: [{ role: "user", content: "hello" }], max_tokens: 16 },
      });
      expect(noUpstream.statusCode).toBe(503);
      expect(noUpstream.json<{ error: { code: string } }>().error.code).toBe("upstream_unavailable");

      const retryKeyResponse = await app.inject({
        method: "POST",
        url: "/api/admin/v1/keys",
        headers: { cookie, "x-cw2-csrf": session.csrfToken },
        payload: { name: "failed-request-reconciliation", mode: "openai", allowedModels: [], allowedIps: [], rpm: 10, tpm: 100, maxConcurrency: 2, dailyBudgetMicros: null, expiresAt: null },
      });
      const retryKey = retryKeyResponse.json<{ apiKey: string }>().apiKey;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const failed = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: `Bearer ${retryKey}` },
          payload: { model: "claude-test", messages: [{ role: "user", content: "hello" }], max_tokens: 16 },
        });
        expect(failed.statusCode).toBe(503);
      }

      const tinyKeyResponse = await app.inject({
        method: "POST",
        url: "/api/admin/v1/keys",
        headers: { cookie, "x-cw2-csrf": session.csrfToken },
        payload: { name: "tiny", mode: "openai", allowedModels: [], allowedIps: [], rpm: 10, tpm: 1, maxConcurrency: 2, dailyBudgetMicros: null, expiresAt: null },
      });
      const tinyKey = tinyKeyResponse.json<{ apiKey: string }>().apiKey;
      const tokenLimited = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${tinyKey}` },
        payload: { model: "claude-test", messages: [{ role: "user", content: "hello" }], max_tokens: 16 },
      });
      expect(tokenLimited.statusCode).toBe(429);
      expect(tokenLimited.json<{ error: { code: string } }>().error.code).toBe("token_rate_limit_exceeded");
    } finally {
      await app.close();
    }
  });

  it("protects OIDC configuration and never returns the client secret", async () => {
    const app = await buildApp(config());
    try {
      const login = await app.inject({ method: "POST", url: "/api/admin/v1/session", payload: { username: "admin", password: "correct horse battery staple" } });
      const session = login.json<{ csrfToken: string }>();
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const payload = {
        enabled: false,
        providerName: "Example Identity",
        issuer: "https://identity.example.com",
        clientId: "claude-web2",
        clientSecret: "super-secret-client-value",
        clearClientSecret: false,
        tokenAuthMethod: "client_secret_basic",
        scopes: ["openid", "profile", "email"],
        usernameClaim: "preferred_username",
        groupsClaim: "groups",
        allowedGroups: ["gateway-admins"],
        autoProvision: false,
      };

      const missingCsrf = await app.inject({ method: "PUT", url: "/api/admin/v1/oidc", headers: { cookie }, payload });
      expect(missingCsrf.statusCode).toBe(403);

      const saved = await app.inject({ method: "PUT", url: "/api/admin/v1/oidc", headers: { cookie, "x-cw2-csrf": session.csrfToken }, payload });
      expect(saved.statusCode).toBe(200);
      expect(saved.json<{ hasClientSecret: boolean }>().hasClientSecret).toBe(true);
      expect(saved.body).not.toContain(payload.clientSecret);

      const publicConfig = await app.inject({ method: "GET", url: "/api/admin/v1/oidc/public" });
      expect(publicConfig.statusCode).toBe(200);
      expect(publicConfig.json<{ enabled: boolean }>().enabled).toBe(false);

      const enableWithoutPublicUrl = await app.inject({
        method: "PUT",
        url: "/api/admin/v1/oidc",
        headers: { cookie, "x-cw2-csrf": session.csrfToken },
        payload: { ...payload, enabled: true, clientSecret: undefined },
      });
      expect(enableWithoutPublicUrl.statusCode).toBe(400);
      expect(enableWithoutPublicUrl.json<{ error: { code: string } }>().error.code).toBe("oidc_public_url_required");
    } finally {
      await app.close();
    }
  });

  it("rotates the administrator password and revokes other sessions", async () => {
    const app = await buildApp(config());
    try {
      const first = await app.inject({ method: "POST", url: "/api/admin/v1/session", payload: { username: "admin", password: "correct horse battery staple" } });
      const second = await app.inject({ method: "POST", url: "/api/admin/v1/session", payload: { username: "admin", password: "correct horse battery staple" } });
      const firstCookie = String(first.headers["set-cookie"]).split(";")[0]!;
      const secondCookie = String(second.headers["set-cookie"]).split(";")[0]!;
      const csrfToken = first.json<{ csrfToken: string }>().csrfToken;

      const changed = await app.inject({
        method: "POST",
        url: "/api/admin/v1/password",
        headers: { cookie: firstCookie, "x-cw2-csrf": csrfToken },
        payload: { currentPassword: "correct horse battery staple", newPassword: "a different horse battery staple" },
      });
      expect(changed.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/admin/v1/session", headers: { cookie: firstCookie } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/admin/v1/session", headers: { cookie: secondCookie } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/admin/v1/session", payload: { username: "admin", password: "correct horse battery staple" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/admin/v1/session", payload: { username: "admin", password: "a different horse battery staple" } })).statusCode).toBe(200);

      const refreshed = await app.inject({ method: "GET", url: "/api/admin/v1/session", headers: { cookie: firstCookie } });
      const strictSettings = await app.inject({
        method: "PUT",
        url: "/api/admin/v1/settings",
        headers: { cookie: firstCookie, "x-cw2-csrf": refreshed.json<{ csrfToken: string }>().csrfToken },
        payload: { values: { "routing.max_attempts": 99, "unknown.setting": true } },
      });
      expect(strictSettings.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
