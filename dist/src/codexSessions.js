import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { ConfigError, saveConfigPatch } from "./config.js";
const execFileAsync = promisify(execFile);
const MAX_SUMMARY_ITEM_LENGTH = 240;
const MAX_SUMMARY_ITEMS = 3;
export function parseCodexSessionControlCommand(text) {
    const trimmed = text.trim();
    if (/^(?:current-session|session-status|session-current)$/i.test(trimmed)) {
        return { type: "current-session" };
    }
    const listMatch = trimmed.match(/^list-sessions?(?:\s+(.+))?$/i);
    if (listMatch) {
        const selector = listMatch[1]?.trim();
        return selector ? { type: "select-session", selector } : { type: "list-session" };
    }
    const selectMatch = trimmed.match(/^(?:use-session|select-session|switch-session|attach-session)\s+(.+)$/i);
    if (selectMatch?.[1]) {
        return { type: "select-session", selector: selectMatch[1].trim() };
    }
    return undefined;
}
export async function handleCodexSessionControlCommand(control, config, configPath) {
    try {
        if (control.type === "current-session") {
            return {
                ackState: "done",
                control: "current-session",
                title: "Current Codex session",
                summary: await formatCurrentSession(config.codex)
            };
        }
        if (control.type === "list-session") {
            const sessions = await listCodexSessions(config.codex);
            return {
                ackState: "done",
                control: "list-session",
                title: "Codex sessions",
                summary: formatSessionList(sessions, config.codex.sessionListLimit)
            };
        }
        const session = await findCodexSession(config.codex, control.selector);
        if (!session) {
            return {
                ackState: "failed",
                control: "select-session",
                title: "Codex session not found",
                summary: `没有找到可介入的 Codex 会话：${control.selector}\n\n请先发送 list-session 查看可用会话。`
            };
        }
        await saveConfigPatch({
            codex: {
                enabled: true,
                sessionId: session.id,
                sessionTitle: session.title || "(untitled)",
                sessionSource: session.source,
                sessionUpdatedAt: session.updatedAt,
                sessionGitBranch: session.gitBranch,
                useLast: false,
                cwd: session.cwd
            }
        }, configPath);
        return {
            ackState: "done",
            control: "select-session",
            title: "Codex session selected",
            summary: await formatSelectedSessionWithSummary(session)
        };
    }
    catch (error) {
        return {
            ackState: "failed",
            control: control.type,
            title: "Codex session command failed",
            summary: formatError(error)
        };
    }
}
export async function listCodexSessions(config, options = {}) {
    const dbPath = config.stateDbPath;
    if (!dbPath) {
        throw new ConfigError("codex.stateDbPath is required for list-session");
    }
    const limit = positiveInteger(options.limit ?? config.sessionListLimit, "limit");
    const sql = `
select
  id,
  title,
  cwd,
  source,
  updated_at as updatedAt,
  created_at as createdAt,
  model,
  git_branch as gitBranch,
  rollout_path as rolloutPath,
  first_user_message as firstUserMessage
from threads
where archived = 0
order by updated_at desc, id desc
limit ${limit};
`;
    const { stdout } = await execFileAsync(options.sqliteCommand ?? "sqlite3", [
        "-json",
        dbPath,
        sql
    ]);
    return parseSessionRows(stdout);
}
export async function findCodexSession(config, selector, options = {}) {
    const sessions = await listCodexSessions(config, {
        sqliteCommand: options.sqliteCommand,
        limit: Math.max(config.sessionListLimit, 100)
    });
    const normalized = selector.trim();
    const index = Number(normalized);
    if (Number.isInteger(index) && index >= 1) {
        return sessions[index - 1];
    }
    return sessions.find((session) => session.id === normalized || session.id.startsWith(normalized));
}
export function formatSessionList(sessions, limit) {
    if (sessions.length === 0) {
        return "没有找到可用的 Codex 会话。";
    }
    const lines = [
        `可用 Codex 会话（最近 ${Math.min(limit, sessions.length)} 个）：`,
        ""
    ];
    for (const [index, session] of sessions.entries()) {
        lines.push(`${index + 1}. ${session.title || "(untitled)"}`);
        lines.push(`   id: ${session.id}`);
        lines.push(`   cwd: ${session.cwd}`);
        lines.push(`   source: ${session.source}  updated: ${formatTime(session.updatedAt)}`);
        if (session.gitBranch) {
            lines.push(`   branch: ${session.gitBranch}`);
        }
        lines.push("");
    }
    lines.push("选择介入：");
    lines.push("list-session <序号>");
    lines.push("switch-session <序号>");
    lines.push("或");
    lines.push("list-session <sessionId>");
    lines.push("switch-session <sessionId>");
    lines.push("");
    lines.push("查看当前会话：current-session");
    return lines.join("\n");
}
export function formatSelectedSession(session) {
    return [
        "已介入 Codex 会话：",
        "",
        `title: ${session.title || "(untitled)"}`,
        `id: ${session.id}`,
        `cwd: ${session.cwd}`,
        `source: ${session.source}`,
        `updated: ${formatTime(session.updatedAt)}`
    ].join("\n");
}
export async function formatSelectedSessionWithSummary(session) {
    const summary = await summarizeCodexSession(session);
    if (!summary) {
        return `${formatSelectedSession(session)}\n\n会话摘要：\n未找到可同步的本地会话内容。`;
    }
    return `${formatSelectedSession(session)}\n\n会话摘要：\n${summary}`;
}
export async function formatCurrentSession(config) {
    if (config.sessionId) {
        const session = await findCodexSession(config, config.sessionId);
        if (session) {
            return [
                "当前 Codex 会话：",
                "",
                `enabled: ${config.enabled}`,
                `title: ${session.title || "(untitled)"}`,
                `id: ${session.id}`,
                `cwd: ${session.cwd}`,
                `source: ${session.source}`,
                `updated: ${formatTime(session.updatedAt)}`,
                session.gitBranch ? `branch: ${session.gitBranch}` : undefined
            ].filter((line) => line !== undefined).join("\n");
        }
        return [
            "当前 Codex 会话已配置，但最近会话列表中没有找到对应记录：",
            "",
            `enabled: ${config.enabled}`,
            `id: ${config.sessionId}`,
            config.cwd ? `cwd: ${config.cwd}` : undefined,
            "",
            "可以发送 list-session 重新选择一个可用会话。"
        ].filter((line) => line !== undefined).join("\n");
    }
    if (config.useLast) {
        return [
            "当前 Codex 会话未显式绑定。",
            "",
            "useLast: true",
            "后续普通指令会使用 Codex CLI 解析到的最新会话。建议发送 list-session 明确选择。"
        ].join("\n");
    }
    return "当前没有绑定 Codex 会话。请先发送 list-session 选择一个会话。";
}
function parseSessionRows(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return [];
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
        throw new ConfigError("sqlite3 session query returned non-array JSON");
    }
    return parsed.map((row, index) => parseSessionRow(row, index));
}
function parseSessionRow(row, index) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new ConfigError(`sqlite3 session row ${index} must be an object`);
    }
    const value = row;
    return {
        id: requiredString(value.id, `session[${index}].id`),
        title: optionalString(value.title, `session[${index}].title`) ?? "",
        cwd: requiredString(value.cwd, `session[${index}].cwd`),
        source: optionalString(value.source, `session[${index}].source`) ?? "",
        updatedAt: requiredNumber(value.updatedAt, `session[${index}].updatedAt`),
        createdAt: requiredNumber(value.createdAt, `session[${index}].createdAt`),
        model: optionalString(value.model, `session[${index}].model`),
        gitBranch: optionalString(value.gitBranch, `session[${index}].gitBranch`),
        rolloutPath: optionalString(value.rolloutPath, `session[${index}].rolloutPath`),
        firstUserMessage: optionalString(value.firstUserMessage, `session[${index}].firstUserMessage`)
    };
}
async function summarizeCodexSession(session) {
    const messages = await readRolloutMessages(session.rolloutPath);
    const userMessages = messages.filter((message) => message.role === "user");
    const assistantMessages = messages.filter((message) => message.role === "assistant");
    const firstUser = cleanUserSummaryText(session.firstUserMessage || userMessages[0]?.text);
    const recentUsers = userMessages
        .slice(-MAX_SUMMARY_ITEMS)
        .map((message) => cleanUserSummaryText(message.text))
        .filter((text) => Boolean(text));
    const recentAssistants = assistantMessages
        .slice(-2)
        .map((message) => cleanSummaryText(message.text))
        .filter((text) => Boolean(text));
    const lines = [];
    if (firstUser) {
        lines.push(`首条需求：${firstUser}`);
    }
    if (recentUsers.length > 0) {
        lines.push("最近用户指令：");
        for (const [index, text] of recentUsers.entries()) {
            lines.push(`${index + 1}. ${text}`);
        }
    }
    if (recentAssistants.length > 0) {
        lines.push("最近 Agent 回复：");
        for (const [index, text] of recentAssistants.entries()) {
            lines.push(`${index + 1}. ${text}`);
        }
    }
    return lines.length > 0 ? lines.join("\n") : undefined;
}
async function readRolloutMessages(rolloutPath) {
    if (!rolloutPath)
        return [];
    let content;
    try {
        content = await readFile(rolloutPath, "utf8");
    }
    catch {
        return [];
    }
    const messages = [];
    for (const line of content.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue;
        }
        const message = extractRolloutMessage(parsed);
        if (message)
            messages.push(message);
    }
    return messages;
}
function extractRolloutMessage(entry) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        return undefined;
    const object = entry;
    if (object.type !== "response_item")
        return undefined;
    const payload = object.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload))
        return undefined;
    const value = payload;
    if (value.type !== "message" || (value.role !== "user" && value.role !== "assistant")) {
        return undefined;
    }
    const text = extractMessageText(value.content);
    return text ? { role: value.role, text } : undefined;
}
function extractMessageText(content) {
    if (!Array.isArray(content))
        return undefined;
    const parts = [];
    for (const item of content) {
        if (typeof item !== "object" || item === null || Array.isArray(item))
            continue;
        const value = item;
        if (typeof value.text === "string") {
            parts.push(value.text);
        }
    }
    return parts.join("\n").trim() || undefined;
}
function cleanSummaryText(value) {
    const normalized = value?.replace(/\s+/g, " ").trim();
    if (!normalized)
        return undefined;
    if (normalized.length <= MAX_SUMMARY_ITEM_LENGTH)
        return normalized;
    return `${normalized.slice(0, MAX_SUMMARY_ITEM_LENGTH - 1)}…`;
}
function cleanUserSummaryText(value) {
    const trimmed = value?.trim();
    if (!trimmed || trimmed.startsWith("<environment_context>"))
        return undefined;
    const feishuInstructionMarker = "用户原始指令：";
    const markerIndex = trimmed.indexOf(feishuInstructionMarker);
    if (markerIndex >= 0) {
        return cleanSummaryText(trimmed.slice(markerIndex + feishuInstructionMarker.length));
    }
    return cleanSummaryText(trimmed);
}
function positiveInteger(value, label) {
    if (!Number.isInteger(value) || value < 1) {
        throw new ConfigError(`${label} must be a positive integer`);
    }
    return value;
}
function requiredString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new ConfigError(`${label} must be a non-empty string`);
    }
    return value;
}
function optionalString(value, label) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "string") {
        throw new ConfigError(`${label} must be a string`);
    }
    return value;
}
function requiredNumber(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ConfigError(`${label} must be a number`);
    }
    return value;
}
function formatTime(seconds) {
    return new Date(seconds * 1000).toISOString();
}
function formatError(error) {
    if (error instanceof ConfigError) {
        return error.message;
    }
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}
