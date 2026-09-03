import type { AppDatabase } from "../db/database.js";
import type { ModelAliasRow, UpstreamRow } from "../domain.js";
import { HttpError } from "../http-error.js";
import { decryptSecret, type Keyring } from "../security/crypto.js";
import { assertPublicDestination, joinUpstreamPath } from "../security/network.js";

export interface UpstreamLease {
  upstream: UpstreamRow;
  upstreamModel: string;
  release: () => void;
}

export interface UpstreamFetchResult extends UpstreamLease {
  response: Response;
  attempts: number;
}

export class UpstreamResponseError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly requestId?: string,
  ) {
    super(`Upstream responded with HTTP ${status}`);
    this.name = "UpstreamResponseError";
  }
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function safeErrorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 400) : "Unknown upstream failure";
}

async function readUpstreamError(response: Response): Promise<unknown> {
  const text = (await response.text()).slice(0, 64 * 1024);
  try { return JSON.parse(text); } catch { return { error: { type: "upstream_error", message: text || `HTTP ${response.status}` } }; }
}

function cooldownFromResponse(response: Response, failures: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(15 * 60_000, Math.max(1_000, seconds * 1_000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(15 * 60_000, Math.max(1_000, date - Date.now()));
  }
  return Math.min(5 * 60_000, 2 ** Math.min(failures, 8) * 1_000);
}

export class UpstreamPool {
  private readonly active = new Map<string, number>();
  private readonly roundRobinCursor = new Map<string, number>();

  constructor(
    private readonly db: AppDatabase,
    private readonly keys: Keyring,
    private readonly fetcher: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  resolveModel(publicModel: string): ModelAliasRow {
    const alias = this.db.get<ModelAliasRow>("SELECT * FROM model_aliases WHERE public_id=? AND enabled=1", publicModel);
    if (!alias) throw new HttpError(404, `Unknown or disabled model: ${publicModel}`, "model_not_found");
    return alias;
  }

  listModels(): ModelAliasRow[] {
    return this.db.all<ModelAliasRow>("SELECT * FROM model_aliases WHERE enabled=1 ORDER BY public_id");
  }

  acquire(alias: ModelAliasRow, excluded = new Set<string>()): UpstreamLease {
    const now = Date.now();
    const candidates = this.db.all<UpstreamRow>(
      `SELECT * FROM upstreams
       WHERE enabled=1 AND (? IS NULL OR id=?)
       ORDER BY priority ASC,name ASC`,
      alias.upstream_id,
      alias.upstream_id,
    ).filter((row) => {
      if (excluded.has(row.id)) return false;
      if (row.cooldown_until && Date.parse(row.cooldown_until) > now) return false;
      return (this.active.get(row.id) ?? 0) < row.max_concurrency;
    });
    if (candidates.length === 0) throw new HttpError(503, "No healthy upstream has available capacity", "upstream_unavailable");
    const bestPriority = Math.min(...candidates.map((row) => row.priority));
    const tier = candidates.filter((row) => row.priority === bestPriority);
    const strategy = this.setting<string>("routing.strategy", "weighted_least_loaded");
    let upstream: UpstreamRow;
    if (strategy === "priority_only") {
      upstream = tier[0]!;
    } else if (strategy === "round_robin") {
      const weighted = tier.flatMap((row) => Array.from({ length: Math.min(row.weight, 100) }, () => row));
      const cursor = this.roundRobinCursor.get(alias.public_id) ?? 0;
      upstream = weighted[cursor % weighted.length]!;
      this.roundRobinCursor.set(alias.public_id, cursor + 1);
    } else {
      tier.sort((a, b) => {
        const scoreA = ((this.active.get(a.id) ?? 0) + Math.random() * 0.1) / Math.max(a.weight, 1);
        const scoreB = ((this.active.get(b.id) ?? 0) + Math.random() * 0.1) / Math.max(b.weight, 1);
        return scoreA - scoreB;
      });
      upstream = tier[0]!;
    }
    this.active.set(upstream.id, (this.active.get(upstream.id) ?? 0) + 1);
    let released = false;
    return {
      upstream,
      upstreamModel: `${upstream.model_prefix}${alias.upstream_model}`,
      release: () => {
        if (released) return;
        released = true;
        this.active.set(upstream.id, Math.max(0, (this.active.get(upstream.id) ?? 1) - 1));
      },
    };
  }

  async fetchWithFailover(
    alias: ModelAliasRow,
    body: Record<string, unknown> | ((upstreamModel: string) => Record<string, unknown>),
    path: "/v1/messages" | "/v1/messages/count_tokens",
    clientSignal: AbortSignal,
    anthropicBeta?: string,
  ): Promise<UpstreamFetchResult> {
    const excluded = new Set<string>();
    let lastError: unknown;
    const maximumAttempts = Math.max(1, Math.min(5, this.setting<number>("routing.max_attempts", 2)));
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      let lease: UpstreamLease;
      try {
        lease = this.acquire(alias, excluded);
      } catch (error) {
        if (lastError) throw lastError;
        throw error;
      }
      excluded.add(lease.upstream.id);
      const url = joinUpstreamPath(lease.upstream.base_url, path);
      try {
        await assertPublicDestination(url);
        const timeoutSignal = AbortSignal.timeout(lease.upstream.timeout_ms);
        const signal = AbortSignal.any([clientSignal, timeoutSignal]);
        const credential = decryptSecret(this.keys.encryption, lease.upstream.encrypted_api_key, `upstream:${lease.upstream.id}`);
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "user-agent": "Claude-Web2/0.1",
        };
        if (lease.upstream.auth_scheme === "bearer") headers.authorization = `Bearer ${credential}`;
        else headers["x-api-key"] = credential;
        if (anthropicBeta) headers["anthropic-beta"] = anthropicBeta;
        const response = await this.fetcher(url, {
          method: "POST",
          headers,
          body: JSON.stringify(typeof body === "function" ? body(lease.upstreamModel) : body),
          redirect: "error",
          signal,
        });
        if (response.ok) {
          this.markSuccess(lease.upstream.id);
          const result: UpstreamFetchResult = { ...lease, response, attempts: attempt };
          return result;
        }
        const errorBody = await readUpstreamError(response);
        const responseError = new UpstreamResponseError(response.status, errorBody, response.headers.get("request-id") ?? undefined);
        this.markFailure(lease.upstream, safeErrorText(responseError), cooldownFromResponse(response, lease.upstream.failure_count + 1));
        lease.release();
        lastError = responseError;
        if (!isRetryable(response.status) || attempt === maximumAttempts || clientSignal.aborted) throw responseError;
      } catch (error) {
        lease.release();
        if (error instanceof UpstreamResponseError) {
          if (!isRetryable(error.status) || attempt === maximumAttempts) throw error;
          lastError = error;
          continue;
        }
        if (clientSignal.aborted) throw new HttpError(499, "Client closed the request", "client_aborted");
        const message = safeErrorText(error);
        this.markFailure(lease.upstream, message, cooldownFromResponse(new Response(null, { status: 503 }), lease.upstream.failure_count + 1));
        lastError = new HttpError(502, "Unable to reach an available upstream", "upstream_connection_error");
        if (attempt === maximumAttempts) throw lastError;
      }
    }
    throw lastError ?? new HttpError(503, "No upstream available", "upstream_unavailable");
  }

  private markSuccess(id: string): void {
    this.db.run(
      "UPDATE upstreams SET health_status='healthy',failure_count=0,cooldown_until=NULL,last_error=NULL,updated_at=? WHERE id=?",
      this.db.now(),
      id,
    );
  }

  private markFailure(upstream: UpstreamRow, error: string, cooldownMs: number): void {
    const failures = upstream.failure_count + 1;
    const shouldCool = failures >= 3;
    this.db.run(
      "UPDATE upstreams SET health_status=?,failure_count=?,cooldown_until=?,last_error=?,updated_at=? WHERE id=?",
      shouldCool ? "cooldown" : "degraded",
      failures,
      shouldCool ? new Date(Date.now() + cooldownMs).toISOString() : null,
      error,
      this.db.now(),
      upstream.id,
    );
  }

  private setting<T>(key: string, fallback: T): T {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key=?", key);
    if (!row) return fallback;
    try { return JSON.parse(row.value_json) as T; } catch { return fallback; }
  }
}
