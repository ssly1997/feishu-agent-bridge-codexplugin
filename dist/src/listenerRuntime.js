import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const DEFAULT_STALE_AFTER_MS = 30_000;
export function listenerRuntimeStatusPath(configPath) {
    return join(dirname(configPath), "listener-runtime.json");
}
export async function writeStandaloneListenerRuntimeStatus(configPath, status) {
    await writeListenerRuntimeStatus(configPath, status, { managedBy: "standalone" });
}
export async function writeListenerRuntimeStatus(configPath, status, options) {
    const runtimeStatusPath = listenerRuntimeStatusPath(configPath);
    const payload = {
        ...status,
        managedBy: options.managedBy,
        pid: process.pid,
        processAlive: true,
        updatedAt: new Date().toISOString(),
        runtimeStatusPath,
        scheduler: options.scheduler
    };
    await mkdir(dirname(runtimeStatusPath), { recursive: true });
    await writeFile(runtimeStatusPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
export async function readStandaloneListenerRuntimeStatus(configPath, options = {}) {
    const runtimeStatusPath = listenerRuntimeStatusPath(configPath);
    let raw;
    try {
        raw = await readFile(runtimeStatusPath, "utf8");
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return undefined;
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (!isRecord(parsed) ||
        (parsed.managedBy !== "standalone" && parsed.managedBy !== "runtime")) {
        return undefined;
    }
    const pid = optionalNumber(parsed.pid);
    const updatedAt = optionalString(parsed.updatedAt);
    if (!pid || !updatedAt)
        return undefined;
    const updatedAtMs = Date.parse(updatedAt);
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > staleAfterMs) {
        return undefined;
    }
    const processAlive = isProcessAlive(pid);
    if (!processAlive)
        return undefined;
    return {
        managedBy: parsed.managedBy,
        pid,
        processAlive,
        updatedAt,
        runtimeStatusPath,
        running: optionalBoolean(parsed.running) ?? false,
        ready: optionalBoolean(parsed.ready) ?? false,
        configPath: optionalString(parsed.configPath) ?? configPath,
        queuePath: optionalString(parsed.queuePath),
        startedAt: optionalString(parsed.startedAt),
        lastEventAt: optionalString(parsed.lastEventAt),
        lastCommandAt: optionalString(parsed.lastCommandAt),
        enqueuedCount: optionalNumber(parsed.enqueuedCount) ?? 0,
        ignoredCount: optionalNumber(parsed.ignoredCount) ?? 0,
        lastError: optionalString(parsed.lastError),
        reconnectInfo: parseReconnectInfo(parsed.reconnectInfo),
        scheduler: parseSchedulerStatus(parsed.scheduler)
    };
}
export async function removeStandaloneListenerRuntimeStatus(configPath) {
    await rm(listenerRuntimeStatusPath(configPath), { force: true });
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return isNodeError(error) && error.code === "EPERM";
    }
}
function parseReconnectInfo(value) {
    if (!isRecord(value))
        return undefined;
    const lastConnectTime = optionalNumber(value.lastConnectTime);
    const nextConnectTime = optionalNumber(value.nextConnectTime);
    if (lastConnectTime === undefined || nextConnectTime === undefined)
        return undefined;
    return { lastConnectTime, nextConnectTime };
}
function parseSchedulerStatus(value) {
    if (!isRecord(value) || !Array.isArray(value.activeSessions))
        return undefined;
    const activeSessions = value.activeSessions.filter((item) => typeof item === "string");
    return {
        activeSessions,
        recoveryRunning: optionalBoolean(value.recoveryRunning) ?? false,
        lastRecoveryAt: optionalString(value.lastRecoveryAt),
        lastRecoveredCount: optionalNumber(value.lastRecoveredCount),
        lastRecoveryError: optionalString(value.lastRecoveryError)
    };
}
function optionalString(value) {
    return typeof value === "string" ? value : undefined;
}
function optionalBoolean(value) {
    return typeof value === "boolean" ? value : undefined;
}
function optionalNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isNodeError(error) {
    return error !== null && typeof error === "object" && "code" in error;
}
