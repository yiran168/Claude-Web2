export interface Migration {
  version: number;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id_hash TEXT PRIMARY KEY,
        admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        csrf_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS gateway_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        key_suffix TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('openai','anthropic','dual')),
        scopes_json TEXT NOT NULL DEFAULT '["inference"]',
        allowed_models_json TEXT NOT NULL DEFAULT '[]',
        allowed_ips_json TEXT NOT NULL DEFAULT '[]',
        rpm INTEGER NOT NULL DEFAULT 60,
        tpm INTEGER NOT NULL DEFAULT 100000,
        max_concurrency INTEGER NOT NULL DEFAULT 4,
        daily_budget_micros INTEGER,
        expires_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS upstreams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('anthropic','compatible')),
        base_url TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        weight INTEGER NOT NULL DEFAULT 1,
        max_concurrency INTEGER NOT NULL DEFAULT 4,
        enabled INTEGER NOT NULL DEFAULT 1,
        model_prefix TEXT NOT NULL DEFAULT '',
        timeout_ms INTEGER NOT NULL DEFAULT 120000,
        health_status TEXT NOT NULL DEFAULT 'unknown',
        failure_count INTEGER NOT NULL DEFAULT 0,
        cooldown_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_aliases (
        id TEXT PRIMARY KEY,
        public_id TEXT NOT NULL UNIQUE,
        upstream_model TEXT NOT NULL,
        upstream_id TEXT REFERENCES upstreams(id) ON DELETE SET NULL,
        display_name TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '["text","streaming"]',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        key_id TEXT REFERENCES gateway_keys(id) ON DELETE SET NULL,
        upstream_id TEXT REFERENCES upstreams(id) ON DELETE SET NULL,
        protocol TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        http_status INTEGER NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        latency_ms INTEGER NOT NULL,
        ttft_ms INTEGER,
        error_code TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_logs_key ON request_logs(key_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE upstreams ADD COLUMN auth_scheme TEXT NOT NULL DEFAULT 'x-api-key'
      CHECK(auth_scheme IN ('x-api-key','bearer'));
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS oidc_config (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        provider_name TEXT NOT NULL DEFAULT 'Single sign-on',
        issuer TEXT NOT NULL,
        client_id TEXT NOT NULL,
        encrypted_client_secret TEXT,
        token_auth_method TEXT NOT NULL DEFAULT 'client_secret_basic'
          CHECK(token_auth_method IN ('client_secret_basic','client_secret_post','none')),
        scopes_json TEXT NOT NULL DEFAULT '["openid","profile","email"]',
        username_claim TEXT NOT NULL DEFAULT 'preferred_username',
        groups_claim TEXT NOT NULL DEFAULT 'groups',
        allowed_groups_json TEXT NOT NULL DEFAULT '[]',
        auto_provision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oidc_flows (
        state_hash TEXT PRIMARY KEY,
        encrypted_payload TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oidc_flows_expires ON oidc_flows(expires_at);

      CREATE TABLE IF NOT EXISTS oidc_identities (
        issuer TEXT NOT NULL,
        subject TEXT NOT NULL,
        admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        username_snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_login_at TEXT NOT NULL,
        PRIMARY KEY(issuer, subject)
      );
      CREATE INDEX IF NOT EXISTS idx_oidc_identities_admin ON oidc_identities(admin_id);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE model_aliases
        ADD COLUMN input_price_micros_per_million INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE model_aliases
        ADD COLUMN output_price_micros_per_million INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE request_logs
        ADD COLUMN cost_micros INTEGER;
      CREATE INDEX IF NOT EXISTS idx_request_logs_key_cost
        ON request_logs(key_id, created_at, cost_micros);
    `,
  },
];
