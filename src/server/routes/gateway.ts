import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "../db/database.js";
import type { CanonicalRequest } from "../domain.js";
import { HttpError } from "../http-error.js";
import {
  anthropicResponseToOpenAi,
  normalizeAnthropicRequest,
  normalizeOpenAiRequest,
  rewriteAnthropicResponse,
  toAnthropicRequest,
} from "../protocol/canonical.js";
import { rewriteAnthropicSseModel, transformAnthropicSseToOpenAi } from "../protocol/sse.js";
import type { AdminAuthService } from "../security/admin-auth.js";
import type { GatewayAuthService, TokenUsage } from "../security/gateway-auth.js";
import { UpstreamPool, UpstreamResponseError } from "../upstream/pool.js";

type ApiProtocol = "openai" | "anthropic";

type Usage = TokenUsage;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function extractUsage(value: unknown): Usage {
  const body = asRecord(value);
  const usage = asRecord(body.usage);
  return { input: Number(usage.input_tokens ?? 0), output: Number(usage.output_tokens ?? 0) };
}

function estimateUsage(value: unknown, includeOutput = true): Usage {
  let characters = 0;
  try { characters = JSON.stringify(value).length; } catch { characters = 0; }
  const body = asRecord(value);
  const requestedOutput = Number(body.max_completion_tokens ?? body.max_tokens ?? 0);
  return {
    input: Math.ceil(characters / 4),
    output: includeOutput && Number.isFinite(requestedOutput) ? Math.max(0, requestedOutput) : 0,
  };
}

function responseErrorMessage(body: unknown): string {
  const record = asRecord(body);
  const error = asRecord(record.error);
  return typeof error.message === "string" ? error.message.slice(0, 1_000) : "Upstream rejected the request";
}

function clientAbortSignal(request: FastifyRequest, reply?: FastifyReply): AbortSignal {
  const controller = new AbortController();
  request.raw.once("aborted", () => controller.abort(new Error("Client aborted request")));
  reply?.raw.once("close", () => {
    if (!reply.raw.writableEnded) controller.abort(new Error("Client closed response connection"));
  });
  return controller.signal;
}

function finalizedStream(source: ReadableStream<Uint8Array>, finalize: (status: "completed" | "cancelled" | "error") => void): ReadableStream<Uint8Array> {
  let finalized = false;
  let readerReleased = false;
  const reader = source.getReader();
  const done = (status: "completed" | "cancelled" | "error") => {
    if (finalized) return;
    finalized = true;
    finalize(status);
  };
  const releaseReader = () => {
    if (readerReleased) return;
    readerReleased = true;
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: ended, value } = await reader.read();
        if (ended) {
          done("completed");
          releaseReader();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        done("error");
        releaseReader();
        controller.error(error);
      }
    },
    async cancel(reason) {
      done("cancelled");
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });
}

function writeLog(
  db: AppDatabase,
  values: {
    requestId: string;
    keyId: string | null;
    upstreamId: string | null;
    protocol: ApiProtocol;
    model: string;
    status: string;
    httpStatus: number;
    started: number;
    ttft?: number;
    usage?: Usage;
    costMicros?: number;
    errorCode?: string;
  },
): void {
  db.run(
    `INSERT INTO request_logs(
      request_id,key_id,upstream_id,protocol,model,status,http_status,input_tokens,output_tokens,cost_micros,latency_ms,ttft_ms,error_code,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    values.requestId,
    values.keyId,
    values.upstreamId,
    values.protocol,
    values.model,
    values.status,
    values.httpStatus,
    values.usage?.input ?? null,
    values.usage?.output ?? null,
    values.costMicros ?? null,
    Math.max(0, Math.round(performance.now() - values.started)),
    values.ttft ?? null,
    values.errorCode ?? null,
    db.now(),
  );
}

async function executeInference(
  request: FastifyRequest,
  reply: FastifyReply,
  db: AppDatabase,
  pool: UpstreamPool,
  protocol: ApiProtocol,
  input: unknown,
  keyId: string | null,
  releasePrincipal: () => void,
  commitUsage: (usage: Usage, billable?: boolean) => number,
): Promise<unknown> {
  const started = performance.now();
  let canonical: CanonicalRequest | undefined;
  let upstreamId: string | null = null;
  let upstreamRelease: (() => void) | undefined;
  let released = false;
  const releaseAll = (leaseRelease = upstreamRelease) => {
    if (released) return;
    released = true;
    leaseRelease?.();
    releasePrincipal();
  };
  try {
    const normalized = protocol === "openai" ? normalizeOpenAiRequest(input) : normalizeAnthropicRequest(input);
    canonical = normalized;
    const alias = pool.resolveModel(normalized.model);
    const signal = clientAbortSignal(request, reply);
    const betaHeader = typeof request.headers["anthropic-beta"] === "string" ? request.headers["anthropic-beta"] : undefined;
    const result = await pool.fetchWithFailover(
      alias,
      (upstreamModel) => toAnthropicRequest(normalized, upstreamModel),
      "/v1/messages",
      signal,
      betaHeader,
    );
    upstreamId = result.upstream.id;
    upstreamRelease = result.release;
    const ttft = Math.round(performance.now() - started);
    reply.header("x-request-id", request.id);
    if (result.response.headers.get("request-id")) reply.header("x-upstream-request-id", result.response.headers.get("request-id")!);
    if (normalized.stream) {
      if (!result.response.body) throw new HttpError(502, "Upstream returned an empty stream", "empty_upstream_stream");
      reply.header("content-type", "text/event-stream; charset=utf-8");
      reply.header("cache-control", "no-cache, no-transform");
      reply.header("connection", "keep-alive");
      let streamUsage: Usage = { input: 0, output: 0 };
      const captureUsage = (usage: Usage) => { streamUsage = usage; };
      const transformed = protocol === "openai"
        ? transformAnthropicSseToOpenAi(result.response.body, normalized.model, captureUsage)
        : rewriteAnthropicSseModel(result.response.body, normalized.model, captureUsage);
      const tracked = finalizedStream(transformed, (streamStatus) => {
        const costMicros = commitUsage(streamUsage);
        releaseAll(result.release);
        writeLog(db, {
          requestId: request.id,
          keyId,
          upstreamId: result.upstream.id,
          protocol,
          model: normalized.model,
          status: streamStatus === "error" ? "error" : streamStatus,
          httpStatus: streamStatus === "error" ? 502 : 200,
          started,
          ttft,
          usage: streamUsage,
          costMicros,
          ...(streamStatus === "error" ? { errorCode: "stream_error" } : {}),
        });
      });
      return reply.send(Readable.fromWeb(tracked as never));
    }

    const payload = await result.response.json() as unknown;
    const usage = extractUsage(payload);
    const costMicros = commitUsage(usage);
    releaseAll(result.release);
    writeLog(db, {
      requestId: request.id,
      keyId,
      upstreamId: result.upstream.id,
      protocol,
      model: normalized.model,
      status: "completed",
      httpStatus: 200,
      started,
      ttft,
      usage,
      costMicros,
    });
    return protocol === "openai"
      ? anthropicResponseToOpenAi(payload, normalized.model)
      : rewriteAnthropicResponse(payload, normalized.model);
  } catch (error) {
    commitUsage({ input: 0, output: 0 });
    releaseAll();
    const status = error instanceof UpstreamResponseError ? error.status : error instanceof HttpError ? error.statusCode : 500;
    const code = error instanceof UpstreamResponseError ? "upstream_rejected" : error instanceof HttpError ? error.code : "internal_error";
    writeLog(db, {
      requestId: request.id,
      keyId,
      upstreamId,
      protocol,
      model: canonical?.model ?? "unknown",
      status: "error",
      httpStatus: status,
      started,
      errorCode: code,
    });
    if (error instanceof UpstreamResponseError) {
      throw new HttpError(error.status, responseErrorMessage(error.body), "upstream_error", error.body);
    }
    throw error;
  }
}

async function executeCountTokens(
  request: FastifyRequest,
  db: AppDatabase,
  pool: UpstreamPool,
  input: unknown,
  releasePrincipal: () => void,
  commitUsage: (usage: Usage, billable?: boolean) => number,
): Promise<unknown> {
  let result: Awaited<ReturnType<UpstreamPool["fetchWithFailover"]>> | undefined;
  try {
    const canonical = normalizeAnthropicRequest({ ...asRecord(input), max_tokens: asRecord(input).max_tokens ?? 1, stream: false });
    const alias = pool.resolveModel(canonical.model);
    result = await pool.fetchWithFailover(
      alias,
      (upstreamModel) => {
        const body = toAnthropicRequest(canonical, upstreamModel);
        delete body.max_tokens;
        delete body.stream;
        return body;
      },
      "/v1/messages/count_tokens",
      clientAbortSignal(request),
      typeof request.headers["anthropic-beta"] === "string" ? request.headers["anthropic-beta"] : undefined,
    );
    const payload = await result.response.json() as unknown;
    commitUsage({ input: Number(asRecord(payload).input_tokens ?? 0), output: 0 }, false);
    return payload;
  } catch (error) {
    commitUsage({ input: 0, output: 0 }, false);
    throw error;
  } finally {
    result?.release();
    releasePrincipal();
  }
}

export async function registerGatewayRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  gatewayAuth: GatewayAuthService,
  adminAuth: AdminAuthService,
  pool: UpstreamPool,
): Promise<void> {
  app.post("/v1/chat/completions", async (request, reply) => {
    const model = typeof asRecord(request.body).model === "string" ? String(asRecord(request.body).model) : "";
    const principal = gatewayAuth.authenticate(request, "openai", model, estimateUsage(request.body));
    return executeInference(request, reply, db, pool, "openai", request.body, principal.key.id, principal.release, principal.commitUsage);
  });

  app.post("/v1/messages", async (request, reply) => {
    const model = typeof asRecord(request.body).model === "string" ? String(asRecord(request.body).model) : "";
    const principal = gatewayAuth.authenticate(request, "anthropic", model, estimateUsage(request.body));
    return executeInference(request, reply, db, pool, "anthropic", request.body, principal.key.id, principal.release, principal.commitUsage);
  });

  app.post("/v1/messages/count_tokens", async (request) => {
    const model = typeof asRecord(request.body).model === "string" ? String(asRecord(request.body).model) : "";
    const principal = gatewayAuth.authenticate(request, "anthropic", model, estimateUsage(request.body, false));
    return executeCountTokens(request, db, pool, request.body, principal.release, principal.commitUsage);
  });

  app.get("/v1/models", async (request) => {
    const protocol: ApiProtocol = typeof request.headers["x-api-key"] === "string" ? "anthropic" : "openai";
    const principal = gatewayAuth.authenticate(request, protocol, "*");
    try {
      const models = pool.listModels();
      if (protocol === "openai") {
        return {
          object: "list",
          data: models.map((model) => ({
            id: model.public_id,
            object: "model",
            created: Math.floor(Date.parse(model.created_at) / 1000),
            owned_by: "claude-web2",
          })),
        };
      }
      return {
        data: models.map((model) => ({
          type: "model",
          id: model.public_id,
          display_name: model.display_name,
          created_at: model.created_at,
        })),
        has_more: false,
        first_id: models[0]?.public_id ?? null,
        last_id: models.at(-1)?.public_id ?? null,
      };
    } finally {
      principal.release();
    }
  });

  app.get<{ Params: { id: string } }>("/v1/models/:id", async (request) => {
    const protocol: ApiProtocol = typeof request.headers["x-api-key"] === "string" ? "anthropic" : "openai";
    const principal = gatewayAuth.authenticate(request, protocol, request.params.id);
    try {
      const model = pool.resolveModel(request.params.id);
      return protocol === "openai"
        ? { id: model.public_id, object: "model", created: Math.floor(Date.parse(model.created_at) / 1000), owned_by: "claude-web2" }
        : { type: "model", id: model.public_id, display_name: model.display_name, created_at: model.created_at };
    } finally {
      principal.release();
    }
  });

  app.post("/api/admin/v1/playground", async (request, reply) => {
    const session = adminAuth.require(request, true);
    const body = z.object({ protocol: z.enum(["openai", "anthropic"]), request: z.unknown() }).parse(request.body);
    db.audit(session.username, "playground.run", "inference", request.id, { protocol: body.protocol });
    return executeInference(request, reply, db, pool, body.protocol, body.request, null, () => undefined, () => 0);
  });
}
