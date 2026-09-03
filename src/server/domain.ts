export type ProtocolMode = "openai" | "anthropic" | "dual";
export type UpstreamKind = "anthropic" | "compatible";

export interface GatewayKeyRow {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  key_suffix: string;
  mode: ProtocolMode;
  scopes_json: string;
  allowed_models_json: string;
  allowed_ips_json: string;
  rpm: number;
  tpm: number;
  max_concurrency: number;
  daily_budget_micros: number | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface UpstreamRow {
  id: string;
  name: string;
  kind: UpstreamKind;
  base_url: string;
  encrypted_api_key: string;
  auth_scheme: "x-api-key" | "bearer";
  priority: number;
  weight: number;
  max_concurrency: number;
  enabled: number;
  model_prefix: string;
  timeout_ms: number;
  health_status: "unknown" | "healthy" | "degraded" | "cooldown";
  failure_count: number;
  cooldown_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelAliasRow {
  id: string;
  public_id: string;
  upstream_model: string;
  upstream_id: string | null;
  display_name: string;
  capabilities_json: string;
  input_price_micros_per_million: number;
  output_price_micros_per_million: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export type CanonicalRole = "user" | "assistant";

export type CanonicalBlock = (
  | { type: "text"; text: string }
  | { type: "image"; source: Record<string, unknown> }
  | { type: "document"; source: Record<string, unknown>; title?: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | CanonicalBlock[]; is_error?: boolean }
  | { type: "native"; value: Record<string, unknown> }
) & { cacheControl?: Record<string, unknown>; extras?: Record<string, unknown> };

export interface CanonicalMessage {
  role: CanonicalRole;
  content: CanonicalBlock[];
}

export interface CanonicalTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cacheControl?: Record<string, unknown>;
}

export interface CanonicalRequest {
  model: string;
  system: CanonicalBlock[];
  messages: CanonicalMessage[];
  tools: CanonicalTool[];
  toolChoice?: unknown;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  stream: boolean;
  metadata?: Record<string, unknown>;
  thinking?: unknown;
  outputConfig?: Record<string, unknown>;
  serviceTier?: string;
}
