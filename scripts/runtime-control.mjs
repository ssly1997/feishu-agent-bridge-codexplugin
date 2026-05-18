#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const configPath = join(homedir(), ".feishu-agent-bridge", "config.json");
const runtimeStatusPath = join(homedir(), ".feishu-agent-bridge", "listener-runtime.json");
const runtimeLogPath = join(homedir(), ".feishu-agent-bridge", "runtime.log");
const runtimeEntry = join(repoRoot, "dist", "src", "runtime.js");
const args = process.argv.slice(2);
const action = args.find((arg) => !arg.startsWith("--")) ?? "ensure";
const quiet = args.includes("--quiet");
const skipLegacyMigration = args.includes("--no-migrate-legacy");
const force = args.includes("--force");
const waitIdle = args.includes("--wait-idle");
const restartDelayMs = readNumberOption("delay-ms", 0);
const idleTimeoutMs = readNumberOption("idle-timeout-ms", 120_000);
const idlePollMs = readNumberOption("idle-poll-ms", 1_000);

try {
  switch (action) {
    case "ensure":
      await ensureRuntime();
      break;
    case "start":
      await startRuntime({ restart: false });
      break;
    case "restart":
      if (!(await prepareRestart())) {
        break;
      }
      await startRuntime({ restart: true });
      break;
    case "stop":
      await stopRuntime();
      await stopLegacyProcesses();
      log({ action, stopped: true });
      break;
    case "status":
      log({ action, runtime: await readRuntimeStatus(), processes: await listRuntimeProcesses() });
      break;
    default:
      throw new Error(`Unknown runtime-control action: ${action}`);
  }
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
}

async function ensureRuntime() {
  const config = await readConfig();
  if (!config) {
    log({ action, started: false, reason: "missing_config", configPath });
    return;
  }
  if (config.inbound?.enabled !== true) {
    log({ action, started: false, reason: "inbound_disabled", configPath });
    return;
  }

  if (!skipLegacyMigration) {
    await stopLegacyProcesses();
  }

  const status = await readRuntimeStatus();
  if (status?.managedBy === "runtime" && status.pid && isProcessAlive(status.pid)) {
    log({ action, started: false, alreadyRunning: true, pid: status.pid });
    return;
  }

  await startRuntime({ restart: true });
}

async function prepareRestart() {
  if (restartDelayMs > 0) {
    await sleep(restartDelayMs);
  }

  if (force) {
    return true;
  }

  if (waitIdle) {
    const idle = await waitForRuntimeIdle({
      timeoutMs: idleTimeoutMs,
      pollMs: idlePollMs
    });
    if (idle.ok) {
      return true;
    }
    log({
      action,
      started: false,
      reason: "active_sessions",
      activeSessions: idle.activeSessions,
      timeoutMs: idleTimeoutMs,
      hint: "runtime restart skipped; retry after tasks finish or pass --force"
    });
    return false;
  }

  const activeSessions = activeSessionsFromStatus(await readRuntimeStatus());
  if (activeSessions.length > 0) {
    log({
      action,
      started: false,
      reason: "active_sessions",
      activeSessions,
      hint: "runtime restart skipped; use --wait-idle for a safe refresh or --force to interrupt"
    });
    return false;
  }

  return true;
}

async function waitForRuntimeIdle(options) {
  const deadline = Date.now() + options.timeoutMs;
  let activeSessions = activeSessionsFromStatus(await readRuntimeStatus());
  while (activeSessions.length > 0 && Date.now() < deadline) {
    await sleep(options.pollMs);
    activeSessions = activeSessionsFromStatus(await readRuntimeStatus());
  }
  return {
    ok: activeSessions.length === 0,
    activeSessions
  };
}

async function startRuntime(options) {
  await access(runtimeEntry);
  const config = await readConfig();
  if (config?.inbound?.enabled !== true) {
    log({
      action,
      started: false,
      reason: config ? "inbound_disabled" : "missing_config",
      configPath
    });
    return;
  }

  if (options.restart) {
    await stopRuntime();
  }
  if (!skipLegacyMigration) {
    await stopLegacyProcesses();
  }

  await mkdir(dirname(runtimeLogPath), { recursive: true });
  const command = [
    "cd",
    shellQuote(repoRoot),
    "&&",
    shellQuote(process.execPath),
    "dist/src/runtime.js",
    ">>",
    shellQuote(runtimeLogPath),
    "2>&1"
  ].join(" ");

  try {
    await execFileAsync("screen", ["-dmS", "fab-runtime", "zsh", "-lc", command]);
  } catch {
    await execFileAsync("zsh", ["-lc", `${command} &`]);
  }

  const status = await waitForRuntimeStatus();
  log({
    action,
    started: true,
    repoRoot,
    logPath: runtimeLogPath,
    runtime: status
  });
}

function activeSessionsFromStatus(status) {
  const activeSessions = status?.scheduler?.activeSessions;
  if (!Array.isArray(activeSessions)) return [];
  return activeSessions.filter((item) => typeof item === "string" && item);
}

function readNumberOption(name, fallback) {
  const prefix = `--${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  if (!value) return fallback;
  const parsed = Number(value.slice(prefix.length));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopRuntime() {
  const status = await readRuntimeStatus();
  if (status?.managedBy === "runtime" && status.pid && isProcessAlive(status.pid)) {
    safeKill(status.pid);
  }
  await screenQuit("fab-runtime");
  await pkillPattern("node dist/src/runtime.js");
}

async function stopLegacyProcesses() {
  await pkillPattern("node dist/src/listen.js");
  await pkillPattern("node dist/src/codexWorkerCli.js --watch");
  await screenQuit("fab-listener");
  await screenQuit("fab-codex-worker");
}

async function waitForRuntimeStatus() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await readRuntimeStatus();
    if (status?.managedBy === "runtime" && status.pid && isProcessAlive(status.pid)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return await readRuntimeStatus();
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    return undefined;
  }
}

async function readRuntimeStatus() {
  try {
    const status = JSON.parse(await readFile(runtimeStatusPath, "utf8"));
    if (!status || typeof status !== "object") return undefined;
    return {
      ...status,
      processAlive: typeof status.pid === "number" ? isProcessAlive(status.pid) : false
    };
  } catch {
    return undefined;
  }
}

async function listRuntimeProcesses() {
  try {
    const { stdout } = await execFileAsync("pgrep", [
      "-af",
      "dist/src/(runtime|listen|codexWorkerCli)\\.js|fab-runtime|fab-listener|fab-codex-worker"
    ]);
    return stdout.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function screenQuit(name) {
  try {
    await execFileAsync("screen", ["-S", name, "-X", "quit"]);
  } catch {
    // No matching screen session, or screen is unavailable.
  }
}

async function pkillPattern(pattern) {
  try {
    await execFileAsync("pkill", ["-f", pattern]);
  } catch {
    // No matching process.
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

function safeKill(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function log(payload) {
  if (quiet) return;
  console.log(JSON.stringify(payload, null, 2));
}
