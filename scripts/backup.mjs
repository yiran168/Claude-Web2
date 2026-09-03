#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";

function usage() {
  console.log(`Claude Web2 verified SQLite backup

Usage:
  npm run backup
  npm run backup -- --output path/to/backups
  npm run backup -- --output path/to/backup.db --json
  npm run backup -- --verify path/to/backup.db

Options:
  --database <path>  Source database (default: CW2_DATA_DIR/claude-web2.db)
  --output <path>    Output directory or a new .db file
  --verify <path>    Verify an existing backup without creating one
  --json             Emit machine-readable output
  --help             Show this help

The online backup API safely includes committed WAL data while the Web service is running.
The backup contains encrypted credentials and still requires the original CW2_MASTER_KEY.`);
}

function parseArgs(argv) {
  const options = { database: undefined, output: undefined, verify: undefined, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--json") options.json = true;
    else if (["--database", "--output", "--verify"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
      if (argument === "--database") options.database = value;
      if (argument === "--output") options.output = value;
      if (argument === "--verify") options.verify = value;
      index += 1;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.verify && (options.database || options.output)) throw new Error("--verify cannot be combined with --database or --output");
  return options;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d{3}Z$/, "Z");
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function verifyBackup(databasePath) {
  const path = resolve(databasePath);
  if (!existsSync(path)) throw new Error(`Backup does not exist: ${path}`);
  const database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try {
    const check = database.prepare("PRAGMA quick_check").get();
    const quickCheck = check ? String(Object.values(check)[0]) : "missing";
    if (quickCheck !== "ok") throw new Error(`SQLite quick_check failed: ${quickCheck}`);
    const required = new Set(["admins", "gateway_keys", "upstreams", "model_aliases", "request_logs", "schema_migrations"]);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name));
    for (const table of required) {
      if (!tables.includes(table)) throw new Error(`Backup is not a Claude Web2 database; missing table: ${table}`);
    }
    const schema = database.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get();
    return {
      ok: true,
      path,
      bytes: statSync(path).size,
      schemaVersion: Number(schema?.version ?? 0),
      quickCheck,
    };
  } finally {
    database.close();
  }
}

export async function createBackup(databasePath, requestedOutput) {
  const sourcePath = resolve(databasePath);
  if (!existsSync(sourcePath)) throw new Error(`Database does not exist: ${sourcePath}`);
  const rawOutput = resolve(requestedOutput);
  const outputPath = extname(rawOutput).toLowerCase() === ".db"
    ? rawOutput
    : resolve(rawOutput, `claude-web2-${timestamp()}.db`);
  const manifestPath = `${outputPath}.json`;
  if (existsSync(outputPath) || existsSync(manifestPath)) throw new Error(`Backup output already exists: ${outputPath}`);
  mkdirSync(dirname(outputPath), { recursive: true });

  const source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
  let pages = 0;
  try {
    pages = await backup(source, outputPath, { rate: 128 });
  } catch (error) {
    rmSync(outputPath, { force: true });
    throw error;
  } finally {
    source.close();
  }

  try {
    const verified = verifyBackup(outputPath);
    const digest = await sha256(outputPath);
    const result = {
      ...verified,
      file: basename(outputPath),
      pages,
      sha256: digest,
      createdAt: new Date().toISOString(),
      masterKeyIncluded: false,
      manifestPath,
    };
    writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") {
      chmodSync(outputPath, 0o600);
      chmodSync(manifestPath, 0o600);
    }
    return result;
  } catch (error) {
    rmSync(outputPath, { force: true });
    rmSync(manifestPath, { force: true });
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (options.verify) {
    const result = { ...verifyBackup(options.verify), sha256: await sha256(resolve(options.verify)) };
    console.log(options.json ? JSON.stringify(result, null, 2) : `Backup verified: ${result.path}\nSchema: v${result.schemaVersion} · ${result.bytes} bytes\nSHA-256: ${result.sha256}`);
    return;
  }

  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const dataDir = resolve(process.cwd(), process.env.CW2_DATA_DIR || "./data");
  const databasePath = resolve(options.database || resolve(dataDir, "claude-web2.db"));
  const output = resolve(options.output || resolve(dataDir, "backups"));
  const result = await createBackup(databasePath, output);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Verified backup created: ${result.path}`);
    console.log(`Schema: v${result.schemaVersion} · ${result.bytes} bytes · ${result.pages} pages`);
    console.log(`SHA-256: ${result.sha256}`);
    console.log(`Manifest: ${result.manifestPath}`);
    console.log("Keep the backup private and retain the matching CW2_MASTER_KEY separately.");
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
