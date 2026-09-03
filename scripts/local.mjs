#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REQUIRED_NODE_MAJOR = 24;

function usage() {
  console.log(`Claude Web2 local Web launcher

Usage:
  npm run local
  npm run local -- --build
  npm run local -- --no-build

Options:
  --build     Force a fresh production build before starting
  --no-build  Use the existing production build without checking source timestamps
  --help      Show this help

Docker is not required. The launcher prepares .env when missing, validates the
installation, builds the React Web console when needed, and starts the local server.`);
}

function parseArgs(argv) {
  const options = { forceBuild: false, skipBuild: false, help: false };
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--build") options.forceBuild = true;
    else if (argument === "--no-build") options.skipBuild = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.forceBuild && options.skipBuild) throw new Error("--build and --no-build cannot be used together");
  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${result.status ?? "unknown"}`);
}

function runNpm(args) {
  if (process.env.npm_execpath) {
    run(process.execPath, [process.env.npm_execpath, ...args]);
    return;
  }
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with code ${result.status ?? "unknown"}`);
}

function runServer() {
  const result = spawnSync(process.execPath, ["dist/server/index.js"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  const interrupted = result.signal || result.status === 130 || result.status === 4_294_967_295;
  if (!interrupted && result.status !== 0) {
    throw new Error(`Web server exited with code ${result.status ?? "unknown"}`);
  }
}

function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const entry = statSync(path);
  if (!entry.isDirectory()) return entry.mtimeMs;
  return readdirSync(path, { withFileTypes: true }).reduce((latest, child) => {
    return Math.max(latest, newestMtime(resolve(path, child.name)));
  }, entry.mtimeMs);
}

function buildIsStale() {
  const serverEntry = resolve(process.cwd(), "dist/server/index.js");
  const webEntry = resolve(process.cwd(), "dist/web/index.html");
  if (!existsSync(serverEntry) || !existsSync(webEntry)) return true;
  const buildTime = Math.min(statSync(serverEntry).mtimeMs, statSync(webEntry).mtimeMs);
  const inputs = [
    "src",
    "web",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.server.json",
    "tsconfig.web.json",
    "vite.config.ts",
  ];
  return inputs.some((path) => newestMtime(resolve(process.cwd(), path)) > buildTime);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isInteger(major) || major < REQUIRED_NODE_MAJOR) {
    throw new Error(`Node.js ${REQUIRED_NODE_MAJOR}+ is required; current version is ${process.versions.node}`);
  }
  if (!existsSync(resolve(process.cwd(), "node_modules"))) {
    throw new Error("Dependencies are missing. Run npm ci once, then run npm run local again.");
  }

  if (!existsSync(resolve(process.cwd(), ".env"))) {
    console.log("No .env was found. Creating a secure local configuration first.\n");
    run(process.execPath, ["scripts/setup.mjs"]);
  }

  if (!options.skipBuild && (options.forceBuild || buildIsStale())) {
    console.log("\nBuilding the production Web application…\n");
    runNpm(["run", "build"]);
  }

  console.log("\nChecking the local deployment…\n");
  run(process.execPath, ["scripts/doctor.mjs"]);
  process.loadEnvFile(resolve(process.cwd(), ".env"));
  const port = process.env.CW2_PORT || "8787";
  console.log(`\nStarting Claude Web2. Open http://127.0.0.1:${port} in a browser.\n`);
  runServer();
}

try {
  main();
} catch (error) {
  console.error(`Local launch failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
