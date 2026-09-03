export interface Session {
  username: string;
  csrfToken: string;
  expiresAt: string;
}

export interface OidcPublicConfig {
  enabled: boolean;
  providerName: string;
  callbackUrl: string | null;
}

export interface OidcConfig extends OidcPublicConfig {
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  tokenAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
  scopes: string[];
  usernameClaim: string;
  groupsClaim: string;
  allowedGroups: string[];
  autoProvision: boolean;
}

export interface Upstream {
  id: string;
  name: string;
  kind: "anthropic" | "compatible";
  baseUrl: string;
  priority: number;
  weight: number;
  maxConcurrency: number;
  enabled: boolean;
  modelPrefix: string;
  timeoutMs: number;
  healthStatus: "unknown" | "healthy" | "degraded" | "cooldown";
  failureCount: number;
  cooldownUntil: string | null;
  lastError: string | null;
  hasCredential: boolean;
  authScheme: "x-api-key" | "bearer";
  createdAt: string;
  updatedAt: string;
}

export interface GatewayKey {
  id: string;
  name: string;
  prefix: string;
  suffix: string;
  mode: "openai" | "anthropic" | "dual";
  allowedModels: string[];
  allowedIps: string[];
  rpm: number;
  tpm: number;
  maxConcurrency: number;
  dailyBudgetMicros: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ModelAlias {
  id: string;
  publicId: string;
  upstreamModel: string;
  upstreamId: string | null;
  displayName: string;
  capabilities: string[];
  inputPriceMicrosPerMillion: number;
  outputPriceMicrosPerMillion: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardData {
  period: string;
  requests: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  averageLatencyMs: number;
  series: Array<{ hour: string; requests: number; failures: number }>;
  upstreams: Upstream[];
}

export interface RequestLog {
  id: number;
  request_id: string;
  key_id: string | null;
  upstream_id: string | null;
  protocol: "openai" | "anthropic";
  model: string;
  status: string;
  http_status: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micros: number | null;
  latency_ms: number;
  ttft_ms: number | null;
  error_code: string | null;
  created_at: string;
}

export interface AuditEvent {
  id: number;
  actor: string;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}
