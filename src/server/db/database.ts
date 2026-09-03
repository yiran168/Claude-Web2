import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AppConfig } from "../config.js";
import { hashPassword } from "../security/crypto.js";
import { migrations } from "./migrations.js";

export class AppDatabase {
  readonly sqlite: DatabaseSync;

  constructor(private readonly config: AppConfig) {
    mkdirSync(config.dataDir, { recursive: true });
    this.sqlite = new DatabaseSync(config.databasePath);
    this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;");
    this.migrate();
    this.seedAdmin();
  }

  close(): void {
    this.sqlite.close();
  }

  now(): string {
    return new Date().toISOString();
  }

  get<T extends object>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.sqlite.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends object>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.sqlite.prepare(sql).run(...params);
  }

  transaction<T>(work: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  audit(actor: string, action: string, targetType: string, targetId?: string, metadata: Record<string, unknown> = {}): void {
    this.run(
      "INSERT INTO audit_events(actor,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,?,?,?)",
      actor,
      action,
      targetType,
      targetId ?? null,
      JSON.stringify(metadata),
      this.now(),
    );
  }

  private migrate(): void {
    this.sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(this.all<{ version: number }>("SELECT version FROM schema_migrations").map((row) => row.version));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.sqlite.exec(migration.sql);
        this.run("INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)", migration.version, this.now());
      });
    }
  }

  private seedAdmin(): void {
    const existing = this.get<{ count: number }>("SELECT COUNT(*) AS count FROM admins")?.count ?? 0;
    if (existing > 0) return;
    if (!this.config.adminPassword) {
      throw new Error("CW2_ADMIN_PASSWORD is required when initializing a new database (minimum 12 characters)");
    }
    const now = this.now();
    this.run(
      "INSERT INTO admins(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)",
      randomUUID(),
      this.config.adminUsername,
      hashPassword(this.config.adminPassword),
      now,
      now,
    );
    this.audit("system", "admin.bootstrap", "admin", this.config.adminUsername);
  }
}
