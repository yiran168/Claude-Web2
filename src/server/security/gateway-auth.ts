import type { FastifyRequest } from "fastify";
import type { AppDatabase } from "../db/database.js";
import type { GatewayKeyRow, ModelAliasRow, ProtocolMode } from "../domain.js";
import { HttpError } from "../http-error.js";
import { hmacHex, type Keyring } from "./crypto.js";

interface UsageBucket {
  minute: number;
  requests: number;
  active: number;
  tokens: number;
}

interface DailyBudgetBucket {
  day: string;
  persisted: number;
  committed: number;
  reserved: number;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface GatewayPrincipal {
  key: GatewayKeyRow;
  release: () => void;
  commitUsage: (actualUsage: TokenUsage, billable?: boolean) => number;
}

export class GatewayAuthService {
  private readonly usage = new Map<string, UsageBucket>();
  private readonly dailyBudgets = new Map<string, DailyBudgetBucket>();

  constructor(
    private readonly db: AppDatabase,
    private readonly keys: Keyring,
  ) {}

  authenticate(
    request: FastifyRequest,
    protocol: Exclude<ProtocolMode, "dual">,
    model: string,
    estimatedUsage: TokenUsage = { input: 0, output: 0 },
  ): GatewayPrincipal {
    const bearer = this.readBearer(request);
    const anthropic = typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : undefined;
    const raw = protocol === "openai" ? bearer : anthropic;
    if (!raw) {
      throw new HttpError(401, protocol === "openai" ? "Missing bearer token" : "Missing x-api-key", "invalid_api_key");
    }
    const keyHash = hmacHex(this.keys.gatewayHmac, raw);
    const key = this.db.get<GatewayKeyRow>("SELECT * FROM gateway_keys WHERE key_hash=?", keyHash);
    if (!key || key.revoked_at || (key.expires_at && Date.parse(key.expires_at) <= Date.now())) {
      throw new HttpError(401, "Invalid or expired API key", "invalid_api_key");
    }
    if (key.mode !== "dual" && key.mode !== protocol) {
      throw new HttpError(403, `This key is restricted to the ${key.mode} protocol`, "protocol_not_allowed");
    }
    const allowedModels = JSON.parse(key.allowed_models_json) as string[];
    if (model !== "*" && allowedModels.length > 0 && !allowedModels.includes(model)) {
      throw new HttpError(403, "Model is not allowed for this API key", "model_not_allowed");
    }
    const allowedIps = JSON.parse(key.allowed_ips_json) as string[];
    if (allowedIps.length > 0 && !allowedIps.includes(request.ip)) {
      throw new HttpError(403, "Source IP is not allowed for this API key", "ip_not_allowed");
    }

    const minute = Math.floor(Date.now() / 60_000);
    const existing = this.usage.get(key.id);
    const bucket = !existing || existing.minute !== minute ? { minute, requests: 0, active: 0, tokens: 0 } : existing;
    const reservation = Math.max(0, Math.ceil(estimatedUsage.input + estimatedUsage.output));
    if (bucket.requests >= key.rpm) throw new HttpError(429, "Request-per-minute limit exceeded", "rate_limit_exceeded");
    if (bucket.tokens + reservation > key.tpm) throw new HttpError(429, "Token-per-minute limit exceeded", "token_rate_limit_exceeded");
    if (bucket.active >= key.max_concurrency) throw new HttpError(429, "Concurrent request limit exceeded", "concurrency_limit_exceeded");

    const pricing = model === "*"
      ? undefined
      : this.db.get<Pick<ModelAliasRow, "input_price_micros_per_million" | "output_price_micros_per_million">>(
        "SELECT input_price_micros_per_million,output_price_micros_per_million FROM model_aliases WHERE public_id=?",
        model,
      );
    const budgetReservation = this.calculateCost(pricing, estimatedUsage);
    const dailyBudget = key.daily_budget_micros === null ? undefined : this.dailyBudget(key.id);
    if (dailyBudget && dailyBudget.persisted + dailyBudget.committed + dailyBudget.reserved + budgetReservation > key.daily_budget_micros!) {
      throw new HttpError(429, "Daily cost budget exceeded", "daily_budget_exceeded");
    }

    bucket.requests += 1;
    bucket.active += 1;
    bucket.tokens += reservation;
    this.usage.set(key.id, bucket);
    if (dailyBudget) dailyBudget.reserved += budgetReservation;
    this.db.run("UPDATE gateway_keys SET last_used_at=? WHERE id=?", this.db.now(), key.id);
    let released = false;
    let committed = false;
    return {
      key,
      commitUsage: (actualUsage, billable = true) => {
        if (committed) return 0;
        committed = true;
        const latest = this.usage.get(key.id);
        if (latest && latest.minute === minute) {
          const actualTokens = Math.max(0, Math.ceil(actualUsage.input + actualUsage.output));
          latest.tokens = Math.max(0, latest.tokens + actualTokens - reservation);
        }
        const actualCost = billable ? this.calculateCost(pricing, actualUsage) : 0;
        if (dailyBudget) {
          dailyBudget.reserved = Math.max(0, dailyBudget.reserved - budgetReservation);
          dailyBudget.committed += actualCost;
        }
        return actualCost;
      },
      release: () => {
        if (released) return;
        released = true;
        const latest = this.usage.get(key.id);
        if (latest) latest.active = Math.max(0, latest.active - 1);
      },
    };
  }

  private calculateCost(
    pricing: Pick<ModelAliasRow, "input_price_micros_per_million" | "output_price_micros_per_million"> | undefined,
    usage: TokenUsage,
  ): number {
    if (!pricing) return 0;
    const input = Math.max(0, Math.ceil(usage.input));
    const output = Math.max(0, Math.ceil(usage.output));
    return Math.ceil((
      input * pricing.input_price_micros_per_million
      + output * pricing.output_price_micros_per_million
    ) / 1_000_000);
  }

  private dailyBudget(keyId: string): DailyBudgetBucket {
    const day = new Date().toISOString().slice(0, 10);
    const existing = this.dailyBudgets.get(keyId);
    if (existing?.day === day) return existing;
    const dayStart = `${day}T00:00:00.000Z`;
    const persisted = this.db.get<{ total: number }>(
      "SELECT COALESCE(SUM(cost_micros),0) AS total FROM request_logs WHERE key_id=? AND created_at>=?",
      keyId,
      dayStart,
    )?.total ?? 0;
    const bucket: DailyBudgetBucket = { day, persisted, committed: 0, reserved: 0 };
    this.dailyBudgets.set(keyId, bucket);
    return bucket;
  }

  private readBearer(request: FastifyRequest): string | undefined {
    const authorization = request.headers.authorization;
    if (!authorization) return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    return match?.[1];
  }
}
