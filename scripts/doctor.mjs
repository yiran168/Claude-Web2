#!/usr/bin/env node

import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { relative, resolve } from "node:path";
import { parseEnv } from "node:util";

const REQUIRED_NODE_MAJOR = 24;

function usage() {
  console.log(`Claude Web2 deployment doctor

Usage:
  npm run doctor
  npm run doctor -- --env path/to/.env
  npm run doctor -- --json

Options:
  --env <path>  Read this environment file (default: .env)
  --json        Emit machine-readable JSON without secrets
  --help        Show this help`);
}

function parseArgs(argv) {
  const options = { envPath: ".env", json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--env") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--env requires a path");
      options.envPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function isLoopback(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
    || (isIP(host) === 4 && host.startsWith("127."));
}

function isValidMasterKey(value) {
  if (value.startsWith("base64:")) return Buffer.from(value.slice(7), "base64").length === 32;
  if (value.startsWith("hex:")) return Buffer.from(value.slice(4), "hex").length === 32;
  return false;
}

function readEnvironment(envPath) {
  if (existsSync(envPath)) {
    const fromFile = parseEnv(readFileSync(envPath, "utf8"));
    return { values: { ...fromFile, ...process.env }, source: envPath };
  }
  if (process.env.CW2_MASTER_KEY) {
    return { values: { ...process.env }, source: "process environment" };
  }
  return null;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  add(
    "runtime",
    nodeMajor >= REQUIRED_NODE_MAJOR ? "pass" : "fail",
    `Node ${process.versions.node} on ${process.platform}/${process.arch}; Node ${REQUIRED_NODE_MAJOR}+ required`,
  );

  const envPath = resolve(process.cwd(), options.envPath);
  const loadedEnvironment = readEnvironment(envPath);
  const env = loadedEnvironment?.values;
  const runningInContainer = env?.CW2_RUNTIME === "container" || existsSync("/.dockerenv");
  const shownEnvPath = relative(process.cwd(), envPath) || ".env";
  if (!env) {
    add("environment", "fail", `${shownEnvPath} not found; run npm run setup`);
  } else {
    const environmentSource = loadedEnvironment.source === envPath ? shownEnvPath : loadedEnvironment.source;
    add("environment", "pass", `${environmentSource} loaded; secret values were not printed`);
    add(
      "master_key",
      isValidMasterKey(env.CW2_MASTER_KEY ?? "") ? "pass" : "fail",
      isValidMasterKey(env.CW2_MASTER_KEY ?? "")
        ? "valid 32-byte encrypted-credential key is present"
        : "CW2_MASTER_KEY must decode to exactly 32 bytes from a base64: or hex: value",
    );

    const rawPort = env.CW2_PORT ?? "8787";
    const port = Number(rawPort);
    add(
      "listen_port",
      Number.isInteger(port) && port >= 1 && port <= 65535 ? "pass" : "fail",
      Number.isInteger(port) && port >= 1 && port <= 65535 ? `port ${port}` : `invalid CW2_PORT: ${rawPort}`,
    );

    const dataDir = resolve(process.cwd(), env.CW2_DATA_DIR || "./data");
    try {
      mkdirSync(dataDir, { recursive: true });
      accessSync(dataDir, constants.R_OK | constants.W_OK);
      add("data_directory", "pass", `${relative(process.cwd(), dataDir) || dataDir} is readable and writable`);
    } catch (error) {
      add("data_directory", "fail", error instanceof Error ? error.message : String(error));
    }

    const databaseExists = existsSync(resolve(dataDir, "claude-web2.db"));
    const adminPassword = env.CW2_ADMIN_PASSWORD;
    const bootstrapReady = databaseExists || (typeof adminPassword === "string" && adminPassword.length >= 12);
    add(
      "administrator_bootstrap",
      bootstrapReady ? "pass" : "fail",
      databaseExists
        ? "database exists; a bootstrap password is no longer required"
        : bootstrapReady
          ? "bootstrap password is present and meets the minimum length"
          : "new database requires CW2_ADMIN_PASSWORD with at least 12 characters",
    );

    const host = env.CW2_HOST || "127.0.0.1";
    const bindAddress = env.CW2_BIND_ADDRESS || "127.0.0.1";
    const publiclyBound = runningInContainer
      ? !isLoopback(bindAddress)
      : !isLoopback(host) || !isLoopback(bindAddress);
    add(
      "network_exposure",
      publiclyBound ? "warn" : "pass",
      publiclyBound
        ? "a listener is non-loopback; protect it with a firewall and trusted HTTPS reverse proxy"
        : "host and container publishing default to loopback",
    );

    const publicUrl = env.CW2_PUBLIC_URL;
    if (publicUrl) {
      try {
        const parsed = new URL(publicUrl);
        const validProtocol = parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback(parsed.hostname));
        const validOrigin = !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.pathname === "/";
        add(
          "public_url",
          validProtocol && validOrigin ? "pass" : "fail",
          validProtocol && validOrigin ? `${parsed.origin} is a valid external origin` : "CW2_PUBLIC_URL must be an HTTPS origin without a path, query, fragment, or credentials",
        );
      } catch {
        add("public_url", "fail", "CW2_PUBLIC_URL is not a valid absolute URL");
      }
    } else {
      add("public_url", publiclyBound ? "warn" : "pass", publiclyBound ? "set CW2_PUBLIC_URL before enabling OIDC" : "optional for loopback-only use");
    }

    const trustProxy = env.CW2_TRUST_PROXY || "false";
    add(
      "proxy_trust",
      trustProxy === "true" || trustProxy === "false" ? "pass" : "fail",
      trustProxy === "true" ? "enabled; ensure only a trusted proxy can reach the service" : "disabled",
    );

    const secureCookies = env.CW2_SECURE_COOKIES || "auto";
    add(
      "secure_cookies",
      ["true", "false", "auto"].includes(secureCookies) ? "pass" : "fail",
      `mode: ${secureCookies}`,
    );
  }

  const containerFiles = ["Dockerfile", "docker-compose.yml"].filter((file) => !existsSync(resolve(process.cwd(), file)));
  add(
    "container_definition",
    containerFiles.length === 0 || runningInContainer ? "pass" : "warn",
    runningInContainer
      ? "running inside a container image"
      : containerFiles.length === 0
        ? "Dockerfile and Compose definition are present"
        : `missing: ${containerFiles.join(", ")}`,
  );
  add(
    "production_build",
    existsSync(resolve(process.cwd(), "dist/server/index.js")) ? "pass" : "warn",
    existsSync(resolve(process.cwd(), "dist/server/index.js")) ? "compiled server is present" : "run npm run build before npm start",
  );

  const failed = checks.some((check) => check.status === "fail");
  const warned = checks.some((check) => check.status === "warn");
  const report = {
    status: failed ? "failed" : warned ? "ready_with_warnings" : "ready",
    platform: process.platform,
    architecture: process.arch,
    node: process.versions.node,
    checks,
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const symbols = { pass: "PASS", warn: "WARN", fail: "FAIL" };
    console.log(`Claude Web2 doctor — ${process.platform}/${process.arch}, Node ${process.versions.node}\n`);
    for (const check of checks) console.log(`[${symbols[check.status]}] ${check.name}: ${check.detail}`);
    console.log(`\nResult: ${report.status}`);
  }
  if (failed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`Doctor failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
