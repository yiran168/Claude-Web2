import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";

interface Hit {
  path: string;
  authorization?: string;
  apiKey?: string;
  body: Record<string, unknown>;
}

const temporaryDirectories: string[] = [];
const hits: Hit[] = [];
let mockOrigin = "";

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

beforeAll(async () => {
  const server = createServer(async (request, response) => {
    try {
      const body = await bodyOf(request);
      hits.push({
        path: request.url ?? "/",
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        ...(typeof request.headers["x-api-key"] === "string" ? { apiKey: request.headers["x-api-key"] } : {}),
        body,
      });
      if (request.url?.startsWith("/fail/")) {
        sendJson(response, 429, { error: { type: "rate_limit_error", message: "synthetic limit" } }, { "retry-after": "0" });
        return;
      }
      if (request.url?.startsWith("/stream/")) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_stream\",\"usage\":{\"input_tokens\":10}}}\n\n");
        response.write("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello from stream\"}}\n\n");
        response.write("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\n");
        response.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
        return;
      }
      sendJson(response, 200, {
        id: "msg_http",
        type: "message",
        role: "assistant",
        model: "upstream-real",
        content: [{ type: "text", text: "Hello from HTTP" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }, { "request-id": "req_upstream_http" });
    } catch (error) {
      sendJson(response, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Mock server did not bind a TCP port"));
      mockOrigin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
  Object.assign(globalThis, { __cw2MockServer: server });
});

afterAll(async () => {
  const server = (globalThis as typeof globalThis & { __cw2MockServer?: ReturnType<typeof createServer> }).__cw2MockServer;
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => hits.splice(0));

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function config(): AppConfig {
  const dataDir = mkdtempSync(join(tmpdir(), "cw2-upstream-test-"));
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

function mappedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const original = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  return fetch(`${mockOrigin}${original.pathname}${original.search}`, init);
}

async function adminSession(app: Awaited<ReturnType<typeof buildApp>>) {
  const login = await app.inject({ method: "POST", url: "/api/admin/v1/session", payload: { username: "admin", password: "correct horse battery staple" } });
  return {
    cookie: String(login.headers["set-cookie"]).split(";")[0]!,
    csrf: login.json<{ csrfToken: string }>().csrfToken,
  };
}

async function provision(
  app: Awaited<ReturnType<typeof buildApp>>,
  options: { upstreamPath: string; dailyBudgetMicros?: number | null; priority?: number; model?: string },
) {
  const session = await adminSession(app);
  const headers = { cookie: session.cookie, "x-cw2-csrf": session.csrf };
  const upstream = await app.inject({
    method: "POST",
    url: "/api/admin/v1/upstreams",
    headers,
    payload: {
      name: options.upstreamPath,
      kind: "compatible",
      baseUrl: `https://1.1.1.1/${options.upstreamPath}`,
      apiKey: "upstream-test-secret",
      authScheme: "bearer",
      priority: options.priority ?? 10,
      weight: 1,
      maxConcurrency: 4,
      enabled: true,
      modelPrefix: "",
      timeoutMs: 5_000,
    },
  });
  expect(upstream.statusCode).toBe(201);

  const publicModel = options.model ?? "claude-test";
  const model = await app.inject({
    method: "POST",
    url: "/api/admin/v1/models",
    headers,
    payload: {
      publicId: publicModel,
      upstreamModel: "upstream-real",
      upstreamId: null,
      displayName: "Claude Test",
      capabilities: ["text", "streaming"],
      inputPriceMicrosPerMillion: 1_000_000,
      outputPriceMicrosPerMillion: 1_000_000,
      enabled: true,
    },
  });
  if (model.statusCode !== 409) expect(model.statusCode).toBe(201);

  const key = await app.inject({
    method: "POST",
    url: "/api/admin/v1/keys",
    headers,
    payload: {
      name: `key-${options.upstreamPath}`,
      mode: "dual",
      allowedModels: [publicModel],
      allowedIps: [],
      rpm: 100,
      tpm: 100_000,
      maxConcurrency: 4,
      dailyBudgetMicros: options.dailyBudgetMicros ?? null,
      expiresAt: null,
    },
  });
  expect(key.statusCode).toBe(201);
  return { apiKey: key.json<{ apiKey: string }>().apiKey, headers, publicModel };
}

describe("real upstream HTTP integration", () => {
  it("records priced usage and rejects a request that would exceed the daily budget", async () => {
    const app = await buildApp(config(), { upstreamFetch: mappedFetch });
    try {
      const requestBody = { model: "claude-budget", messages: [{ role: "user", content: "hello" }], max_tokens: 1 };
      const estimatedCost = Math.ceil(JSON.stringify(requestBody).length / 4) + 1;
      const provisioned = await provision(app, { upstreamPath: "healthy", model: "claude-budget", dailyBudgetMicros: estimatedCost + 15 - 1 });
      const first = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${provisioned.apiKey}` },
        payload: requestBody,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json<{ model: string; choices: Array<{ message: { content: string } }> }>().model).toBe("claude-budget");
      expect(first.body).toContain("Hello from HTTP");
      expect(hits).toHaveLength(1);
      expect(hits[0]?.authorization).toBe("Bearer upstream-test-secret");

      const blocked = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${provisioned.apiKey}` },
        payload: requestBody,
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json<{ error: { code: string } }>().error.code).toBe("daily_budget_exceeded");
      expect(hits).toHaveLength(1);

      const requests = await app.inject({ method: "GET", url: "/api/admin/v1/requests", headers: { cookie: provisioned.headers.cookie } });
      expect(requests.json<{ items: Array<{ cost_micros: number }> }>().items[0]?.cost_micros).toBe(15);
    } finally {
      await app.close();
    }
  });

  it("transforms a real chunked Anthropic SSE response into OpenAI SSE", async () => {
    const app = await buildApp(config(), { upstreamFetch: mappedFetch });
    try {
      const provisioned = await provision(app, { upstreamPath: "stream" });
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${provisioned.apiKey}` },
        payload: { model: provisioned.publicModel, stream: true, messages: [{ role: "user", content: "hello" }], max_tokens: 16 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("Hello from stream");
      expect(response.body).toContain("data: [DONE]");
      expect(hits[0]?.body.stream).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("fails over from a retryable 429 before returning response bytes", async () => {
    const app = await buildApp(config(), { upstreamFetch: mappedFetch });
    try {
      const failing = await provision(app, { upstreamPath: "fail", priority: 1, model: "claude-failover" });
      await provision(app, { upstreamPath: "healthy-failover", priority: 2, model: "claude-failover" });
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: { "x-api-key": failing.apiKey, "anthropic-version": "2023-06-01" },
        payload: { model: "claude-failover", messages: [{ role: "user", content: "hello" }], max_tokens: 16 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Hello from HTTP");
      expect(hits.map((hit) => hit.path)).toEqual(["/fail/v1/messages", "/healthy-failover/v1/messages"]);
    } finally {
      await app.close();
    }
  });
});
