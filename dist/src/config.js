import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
export const CONFIG_DIR = join(homedir(), ".feishu-agent-bridge");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const DEFAULT_CONFIG = {
    receiveIdType: "chat_id",
    enabled: false,
    defaultTitle: "Agent notification",
    messageStyle: "card",
    inbound: {
        enabled: false,
        mode: "long_connection",
        requireMention: true,
        acknowledgeOnReceive: true,
        acknowledgementText: "收到，已加入 Agent 队列。"
    },
    codex: {
        enabled: false,
        command: "codex",
        stateDbPath: join(homedir(), ".codex", "state_5.sqlite"),
        useLast: false,
        extraArgs: ["--skip-git-repo-check"],
        timeoutMs: 30 * 60 * 1000,
        inProgressTimeoutMs: 60 * 60 * 1000,
        inProgressRecovery: "mark_failed",
        sessionListLimit: 10,
        outputMaxBytes: 12000,
        notifyResult: true
    }
};
const receiveIdTypes = new Set(["chat_id", "open_id", "email"]);
const inboundModes = new Set(["long_connection"]);
const codexSandboxModes = new Set([
    "read-only",
    "workspace-write",
    "danger-full-access"
]);
const codexApprovalPolicies = new Set([
    "untrusted",
    "on-request",
    "on-failure",
    "never"
]);
const codexInProgressRecoveries = new Set([
    "mark_failed",
    "reset_pending"
]);
export class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "ConfigError";
    }
}
export async function loadConfig(configPath = CONFIG_PATH) {
    let raw;
    try {
        raw = await readFile(configPath, "utf8");
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return {
                ...DEFAULT_CONFIG,
                inbound: { ...DEFAULT_CONFIG.inbound },
                codex: { ...DEFAULT_CONFIG.codex }
            };
        }
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new ConfigError(`Invalid JSON in ${configPath}: ${error.message}`);
    }
    if (!isObject(parsed)) {
        throw new ConfigError(`Config file must contain a JSON object: ${configPath}`);
    }
    const merged = {
        ...DEFAULT_CONFIG,
        ...parsed,
        inbound: {
            ...DEFAULT_CONFIG.inbound,
            ...(isObject(parsed.inbound) ? parsed.inbound : {})
        },
        codex: {
            ...DEFAULT_CONFIG.codex,
            ...(isObject(parsed.codex) ? parsed.codex : {})
        }
    };
    validateConfigShape(merged, configPath);
    return merged;
}
export async function saveConfigPatch(patch, configPath = CONFIG_PATH) {
    const current = await loadConfig(configPath);
    const next = {
        ...current,
        ...patch,
        inbound: {
            ...current.inbound,
            ...(isObject(patch.inbound) ? patch.inbound : {})
        },
        codex: {
            ...current.codex,
            ...(isObject(patch.codex) ? patch.codex : {})
        }
    };
    validateConfigShape(next, configPath);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
}
export function sanitizeConfig(config) {
    return {
        appId: mask(config.appId),
        appSecret: mask(config.appSecret),
        receiveIdType: config.receiveIdType,
        receiveId: mask(config.receiveId),
        enabled: config.enabled,
        defaultTitle: config.defaultTitle,
        messageStyle: config.messageStyle,
        inbound: sanitizeInboundConfig(config.inbound),
        codex: sanitizeCodexConfig(config.codex)
    };
}
export function getConfigReadiness(config) {
    return {
        enabled: config.enabled,
        hasAppId: Boolean(config.appId),
        hasAppSecret: Boolean(config.appSecret),
        hasReceiveId: Boolean(config.receiveId),
        inboundEnabled: config.inbound.enabled,
        codexEnabled: config.codex.enabled,
        codexHasResumeTarget: Boolean(config.codex.sessionId || config.codex.useLast)
    };
}
export function assertSendReady(config) {
    assertAppCredentialsReady(config);
    if (!config.receiveId) {
        throw new ConfigError("Missing required config fields: receiveId");
    }
}
export function assertAppCredentialsReady(config) {
    const missing = [];
    if (!config.appId)
        missing.push("appId");
    if (!config.appSecret)
        missing.push("appSecret");
    if (missing.length > 0) {
        throw new ConfigError(`Missing required config fields: ${missing.join(", ")}`);
    }
}
function validateConfigShape(config, configPath) {
    if (!receiveIdTypes.has(config.receiveIdType)) {
        throw new ConfigError(`Invalid receiveIdType in ${configPath}: ${String(config.receiveIdType)}`);
    }
    if (typeof config.enabled !== "boolean") {
        throw new ConfigError(`enabled must be a boolean in ${configPath}`);
    }
    if (config.messageStyle !== "card") {
        throw new ConfigError(`messageStyle must be "card" in ${configPath}`);
    }
    for (const key of ["appId", "appSecret", "receiveId", "defaultTitle"]) {
        if (config[key] !== undefined && typeof config[key] !== "string") {
            throw new ConfigError(`${key} must be a string in ${configPath}`);
        }
    }
    validateInboundConfig(config.inbound, configPath);
    validateCodexConfig(config.codex, configPath);
}
function validateInboundConfig(config, configPath) {
    if (!isObject(config)) {
        throw new ConfigError(`inbound must be an object in ${configPath}`);
    }
    if (typeof config.enabled !== "boolean") {
        throw new ConfigError(`inbound.enabled must be a boolean in ${configPath}`);
    }
    if (!inboundModes.has(config.mode)) {
        throw new ConfigError(`inbound.mode must be "long_connection" in ${configPath}`);
    }
    for (const key of ["requireMention", "acknowledgeOnReceive"]) {
        if (typeof config[key] !== "boolean") {
            throw new ConfigError(`inbound.${key} must be a boolean in ${configPath}`);
        }
    }
    for (const key of ["queuePath", "queueDbPath", "botOpenId", "acknowledgementText"]) {
        if (config[key] !== undefined && typeof config[key] !== "string") {
            throw new ConfigError(`inbound.${key} must be a string in ${configPath}`);
        }
    }
    for (const key of ["allowedChatIds", "allowedOpenIds"]) {
        if (config[key] !== undefined &&
            (!Array.isArray(config[key]) || config[key]?.some((item) => typeof item !== "string"))) {
            throw new ConfigError(`inbound.${key} must be an array of strings in ${configPath}`);
        }
    }
}
function validateCodexConfig(config, configPath) {
    if (!isObject(config)) {
        throw new ConfigError(`codex must be an object in ${configPath}`);
    }
    for (const key of ["enabled", "useLast", "notifyResult"]) {
        if (typeof config[key] !== "boolean") {
            throw new ConfigError(`codex.${key} must be a boolean in ${configPath}`);
        }
    }
    for (const key of [
        "command",
        "sessionId",
        "sessionTitle",
        "sessionSource",
        "sessionGitBranch",
        "cwd",
        "outputDir",
        "stateDbPath",
        "model",
        "profile"
    ]) {
        if (config[key] !== undefined && typeof config[key] !== "string") {
            throw new ConfigError(`codex.${key} must be a string in ${configPath}`);
        }
    }
    for (const key of [
        "timeoutMs",
        "inProgressTimeoutMs",
        "sessionListLimit",
        "outputMaxBytes"
    ]) {
        if (typeof config[key] !== "number" ||
            !Number.isFinite(config[key]) ||
            config[key] < 1) {
            throw new ConfigError(`codex.${key} must be a number >= 1 in ${configPath}`);
        }
    }
    if (!codexInProgressRecoveries.has(config.inProgressRecovery)) {
        throw new ConfigError(`codex.inProgressRecovery must be one of: ${Array.from(codexInProgressRecoveries).join(", ")}`);
    }
    if (config.sessionUpdatedAt !== undefined &&
        (typeof config.sessionUpdatedAt !== "number" ||
            !Number.isFinite(config.sessionUpdatedAt) ||
            config.sessionUpdatedAt < 0)) {
        throw new ConfigError(`codex.sessionUpdatedAt must be a number >= 0 in ${configPath}`);
    }
    if (config.sandbox !== undefined && !codexSandboxModes.has(config.sandbox)) {
        throw new ConfigError(`codex.sandbox must be one of: ${Array.from(codexSandboxModes).join(", ")}`);
    }
    if (config.approvalPolicy !== undefined &&
        !codexApprovalPolicies.has(config.approvalPolicy)) {
        throw new ConfigError(`codex.approvalPolicy must be one of: ${Array.from(codexApprovalPolicies).join(", ")}`);
    }
    if (config.extraArgs !== undefined &&
        (!Array.isArray(config.extraArgs) || config.extraArgs.some((item) => typeof item !== "string"))) {
        throw new ConfigError(`codex.extraArgs must be an array of strings in ${configPath}`);
    }
}
function sanitizeInboundConfig(config) {
    return {
        enabled: config.enabled,
        mode: config.mode,
        queuePath: config.queuePath,
        queueDbPath: config.queueDbPath,
        requireMention: config.requireMention,
        botOpenId: mask(config.botOpenId),
        allowedOpenIds: config.allowedOpenIds?.map(mask),
        acknowledgeOnReceive: config.acknowledgeOnReceive,
        acknowledgementText: config.acknowledgementText
    };
}
function sanitizeCodexConfig(config) {
    return {
        enabled: config.enabled,
        command: config.command,
        sessionId: mask(config.sessionId),
        sessionTitle: config.sessionTitle,
        sessionSource: config.sessionSource,
        sessionUpdatedAt: config.sessionUpdatedAt,
        sessionGitBranch: config.sessionGitBranch,
        useLast: config.useLast,
        cwd: config.cwd,
        outputDir: config.outputDir,
        stateDbPath: config.stateDbPath,
        model: config.model,
        profile: config.profile,
        sandbox: config.sandbox,
        approvalPolicy: config.approvalPolicy,
        extraArgs: config.extraArgs,
        timeoutMs: config.timeoutMs,
        inProgressTimeoutMs: config.inProgressTimeoutMs,
        inProgressRecovery: config.inProgressRecovery,
        sessionListLimit: config.sessionListLimit,
        outputMaxBytes: config.outputMaxBytes,
        notifyResult: config.notifyResult
    };
}
function mask(value) {
    if (!value)
        return undefined;
    if (value.length <= 8)
        return "****";
    return `${value.slice(0, 4)}****${value.slice(-4)}`;
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
