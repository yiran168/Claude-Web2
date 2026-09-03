import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, verifyBackup } from "../scripts/backup.mjs";
import type { AppConfig } from "../src/server/config.js";
import { AppDatabase } from "../src/server/db/database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function config(directory: string): AppConfig {
  return {
    masterKey: randomBytes(32),
    adminPassword: "correct horse battery staple",
    adminUsername: "admin",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "claude-web2.db"),
    trustProxy: false,
    secureCookies: false,
    allowedOrigins: new Set(),
    logLevel: "silent",
  };
}

describe("verified online backup", () => {
  it("captures committed WAL data and writes a matching manifest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cw2-backup-test-"));
    temporaryDirectories.push(directory);
    const appConfig = config(directory);
    const database = new AppDatabase(appConfig);
    try {
      database.run(
        "INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?)",
        "backup.test",
        JSON.stringify("included-from-wal"),
        database.now(),
      );
      const result = await createBackup(appConfig.databasePath, join(directory, "backups"));
      expect(result.ok).toBe(true);
      expect(result.schemaVersion).toBe(4);
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(result.manifestPath)).toBe(true);
      expect(verifyBackup(result.path).quickCheck).toBe("ok");

      const restored = new DatabaseSync(result.path, { readOnly: true });
      try {
        const row = restored.prepare("SELECT value_json FROM settings WHERE key=?").get("backup.test");
        expect(row?.value_json).toBe(JSON.stringify("included-from-wal"));
      } finally {
        restored.close();
      }

      const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as { sha256: string; masterKeyIncluded: boolean };
      expect(manifest.sha256).toBe(result.sha256);
      expect(manifest.masterKeyIncluded).toBe(false);
    } finally {
      database.close();
    }
  });
});
