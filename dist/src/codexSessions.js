import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { ConfigError, saveConfigPatch } from "./config.js";
const execFileAsync = promisify(execFile);
const MAX_SUMMARY_ITEM_LENGTH = 240;
const MAX_SUMMARY_ITEMS = 3;
const DEFAULT_PROJECT_KIND = "workspace";
const TEMPORARY_PROJECT_KIND = "temporary";
const DEFAULT_SESSION_PAGE_SIZE = 10;
const DOCUMENTS_CODEX_ROOT = join(homedir(), "Documents", "Codex");
export function parseCodexSessionControlCommand(text) {
    const trimmed = text.trim();
    if (/^(?:help|帮助)$/i.test(trimmed)) {
        return { type: "help" };
    }
    if (/^(?:current-session|session-status|session-current)$/i.test(trimmed)) {
        return { type: "current-session" };
    }
    if (/^(?:current-project|project-status|project-current)$/i.test(trimmed)) {
        return { type: "current-project" };
    }
    if (/^(?:unbind-project|detach-project|clear-project)$/i.test(trimmed)) {
        return { type: "unbind-project" };
    }
    if (/^(?:unbind-session|detach-session|clear-session)$/i.test(trimmed)) {
        return { type: "unbind-session" };
    }
    const projectListMatch = trimmed.match(/^list-projects?(?:\s+(\d+))?$/i);
    if (projectListMatch) {
        return { type: "list-project", page: parsePage(projectListMatch[1]) };
    }
    const projectMatch = trimmed.match(/^(?:bind-project|switch-project)\s+(.+)$/i);
    if (projectMatch?.[1]) {
        return { type: "select-project", selector: projectMatch[1].trim() };
    }
    const newSessionMatch = trimmed.match(/^(?:new-session|create-session|start-session|new-chat|新会话|新建会话|开启新会话)(?:\s+([\s\S]+))?$/i);
    if (newSessionMatch) {
        const prompt = newSessionMatch[1]?.trim();
        return prompt ? { type: "new-session", prompt } : { type: "new-session" };
    }
    const listMatch = trimmed.match(/^list-sessions?(?:\s+(.+))?$/i);
    if (listMatch) {
        const argument = listMatch[1]?.trim();
        if (!argument) {
            return { type: "list-session", mode: "project", page: 1 };
        }
        const allMatch = argument.match(/^--all(?:\s+(\d+))?$/i);
        if (allMatch) {
            return { type: "list-session", mode: "all", page: parsePage(allMatch[1]) };
        }
        const tempMatch = argument.match(/^--temp(?:\s+(\d+))?$/i);
        if (tempMatch) {
            return { type: "list-session", mode: "temp", page: parsePage(tempMatch[1]) };
        }
        return { type: "select-session", selector: argument };
    }
    const selectMatch = trimmed.match(/^(?:use-session|select-session|switch-session|attach-session)\s+(.+)$/i);
    if (selectMatch?.[1]) {
        return { type: "select-session", selector: selectMatch[1].trim() };
    }
    return undefined;
}
export async function handleCodexSessionControlCommand(control, config, configPath) {
    try {
        if (control.type === "help") {
            return {
                ackState: "done",
                control: "help",
                title: "Codex session help",
                summary: formatGlobalHelp()
            };
        }
        if (control.type === "current-session") {
            return {
                ackState: "done",
                control: "current-session",
                title: "Current Codex session",
                summary: await formatCurrentSession(config.codex)
            };
        }
        if (control.type === "current-project") {
            return {
                ackState: "failed",
                control: "current-project",
                title: "Current Codex project requires chat context",
                summary: "current-project 需要当前飞书群上下文，请在群里发送该命令，由 listener 直接处理。"
            };
        }
        if (control.type === "list-project") {
            const projects = await listCodexProjects(config.codex);
            return {
                ackState: "done",
                control: "list-project",
                title: "Codex projects",
                summary: formatProjectList(projects, config.codex.sessionListLimit)
            };
        }
        if (control.type === "list-session") {
            const sessions = await listSessionsForMode(config.codex, control.mode);
            return {
                ackState: "done",
                control: "list-session",
                title: "Codex sessions",
                summary: formatSessionList(sessions, config.codex.sessionListLimit)
            };
        }
        if (control.type === "new-session") {
            return {
                ackState: "failed",
                control: "new-session",
                title: "Codex new session requires chat project",
                summary: "new-session 需要当前飞书群已绑定 Codex project，请在群里发送该命令，由 listener 直接处理。"
            };
        }
        if (control.type === "unbind-project") {
            return {
                ackState: "failed",
                control: "unbind-project",
                title: "Codex project unbind requires chat context",
                summary: "unbind-project 需要当前飞书群上下文，请在对应群里发送该命令，由 listener 直接处理。"
            };
        }
        if (control.type === "unbind-session") {
            await saveConfigPatch({
                codex: {
                    enabled: false,
                    sessionId: undefined,
                    sessionTitle: undefined,
                    sessionSource: undefined,
                    sessionUpdatedAt: undefined,
                    sessionGitBranch: undefined,
                    useLast: false,
                    cwd: undefined
                }
            }, configPath);
            return {
                ackState: "done",
                control: "unbind-session",
                title: "Codex session unbound",
                summary: "已解除当前全局 Codex 会话配置。飞书群维度绑定请在对应群里发送 unbind-session。"
            };
        }
        const session = control.type === "select-project"
            ? (await findCodexProject(config.codex, control.selector))?.latestSession
            : await findCodexSession(config.codex, control.selector);
        if (!session) {
            return {
                ackState: "failed",
                control: control.type,
                title: control.type === "select-project" ? "Codex project not found" : "Codex session not found",
                summary: `没有找到可介入的 Codex ${control.type === "select-project" ? "project" : "会话"}：${control.selector}\n\n请先发送 list-project 或 list-session 查看可用项。`
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
            control: control.type,
            title: control.type === "select-project" ? "Codex project selected" : "Codex session selected",
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
    const needsPostFiltering = Boolean(options.projectId ||
        options.temporaryOnly ||
        options.includeTemporary === false ||
        options.offset);
    const limit = options.all
        ? undefined
        : positiveInteger(options.limit ?? config.sessionListLimit, "limit");
    const sqlLimit = needsPostFiltering || options.all ? undefined : limit;
    const rows = await queryCodexSessionRows(dbPath, {
        limit: sqlLimit,
        sqliteCommand: options.sqliteCommand
    });
    let sessions = await decorateSessions(rows, config);
    if (options.temporaryOnly) {
        sessions = sessions.filter((session) => session.isTemporary);
    }
    else if (options.includeTemporary === false) {
        sessions = sessions.filter((session) => !session.isTemporary);
    }
    if (options.projectId) {
        sessions = sessions.filter((session) => session.projectId === options.projectId);
    }
    if (!options.all && needsPostFiltering && limit !== undefined) {
        const offset = options.offset ? positiveInteger(options.offset, "offset") : 0;
        sessions = sessions.slice(offset, offset + limit);
    }
    return sessions;
}
export async function listCodexProjects(config, options = {}) {
    const sessions = await listCodexSessions(config, {
        all: true,
        includeTemporary: options.includeTemporary ?? false,
        sqliteCommand: options.sqliteCommand
    });
    const projects = new Map();
    for (const session of sessions) {
        if (!session.projectId || !session.projectRootPath)
            continue;
        const existing = projects.get(session.projectId);
        if (!existing) {
            projects.set(session.projectId, {
                id: session.projectId,
                kind: session.projectKind ?? DEFAULT_PROJECT_KIND,
                rootPath: session.projectRootPath,
                displayName: session.projectDisplayName ?? basename(session.projectRootPath),
                secondaryName: session.projectSecondaryName ?? basename(session.projectRootPath),
                displayLabel: session.projectDisplayLabel ?? basename(session.projectRootPath),
                labelSource: session.projectLabelSource ?? "basename",
                isTemporary: Boolean(session.isTemporary),
                sessionCount: 1,
                latestUpdatedAt: session.updatedAt,
                latestSession: session,
                sessions: [session]
            });
            continue;
        }
        existing.sessionCount += 1;
        existing.sessions.push(session);
        if (session.updatedAt > existing.latestUpdatedAt) {
            existing.latestUpdatedAt = session.updatedAt;
            existing.latestSession = session;
        }
    }
    return Array.from(projects.values()).sort((a, b) => (b.latestUpdatedAt - a.latestUpdatedAt || a.displayLabel.localeCompare(b.displayLabel)));
}
export async function findCodexProject(config, selector, options = {}) {
    const projects = await listCodexProjects(config, options);
    const normalized = selector.trim();
    const index = Number(normalized);
    if (Number.isInteger(index) && index >= 1) {
        return projects[index - 1];
    }
    return projects.find((project) => (project.id === normalized ||
        project.id.startsWith(normalized) ||
        project.displayLabel === normalized));
}
export async function findCodexSession(config, selector, options = {}) {
    const sessions = await listCodexSessions(config, {
        ...options,
        all: true
    });
    const normalized = selector.trim();
    const index = Number(normalized);
    if (Number.isInteger(index) && index >= 1) {
        return sessions[index - 1];
    }
    return sessions.find((session) => session.id === normalized || session.id.startsWith(normalized));
}
export function buildCodexProjectId(kind, realRootPath) {
    return `proj_${createHash("sha256")
        .update(`fab-project-v1:${kind}:${realRootPath}`)
        .digest("hex")
        .slice(0, 16)}`;
}
export function formatProjectDisplayLabel(primaryName, secondaryName) {
    return primaryName === secondaryName ? primaryName : `${primaryName}  ${secondaryName}`;
}
export function formatProjectList(projects, limit) {
    if (projects.length === 0) {
        return "没有找到可绑定的 Codex project。临时对话默认不展示，可发送 list-session --temp 查看。";
    }
    const visible = projects.slice(0, limit);
    const lines = [
        `可绑定 Codex project（最近 ${visible.length} 个）：`,
        ""
    ];
    for (const [index, project] of visible.entries()) {
        lines.push(`${index + 1}. ${project.displayLabel}`);
        lines.push(`   id: ${project.id}`);
        lines.push(`   sessions: ${project.sessionCount}  updated: ${formatTime(project.latestUpdatedAt)}`);
        lines.push(`   latest: ${project.latestSession.title || "(untitled)"}`);
        lines.push(`   root: ${project.rootPath}`);
        lines.push("");
    }
    lines.push("绑定项目：bind-project <序号|projectId>");
    lines.push("切换项目：switch-project <序号|projectId>");
    return lines.join("\n");
}
export function formatSessionList(sessions, limit) {
    if (sessions.length === 0) {
        return "没有找到可用的 Codex 会话。";
    }
    const visible = sessions.slice(0, limit);
    const lines = [
        `可用 Codex 会话（最近 ${visible.length} 个）：`,
        ""
    ];
    for (const [index, session] of visible.entries()) {
        lines.push(`${index + 1}. ${session.title || "(untitled)"}`);
        lines.push(`   id: ${session.id}`);
        if (session.projectDisplayLabel) {
            lines.push(`   project: ${session.projectDisplayLabel}`);
        }
        lines.push(`   cwd: ${session.cwd}`);
        lines.push(`   source: ${session.source}  updated: ${formatTime(session.updatedAt)}`);
        if (session.gitBranch) {
            lines.push(`   branch: ${session.gitBranch}`);
        }
        lines.push("");
    }
    lines.push("选择介入：");
    lines.push("list-session <序号|sessionId>");
    lines.push("switch-session <序号|sessionId>");
    lines.push("");
    lines.push("查看当前会话：current-session");
    lines.push("解绑当前绑定：unbind-session");
    return lines.join("\n");
}
export function formatSelectedSession(session) {
    return [
        "已介入 Codex 会话：",
        "",
        session.projectDisplayLabel ? `project: ${session.projectDisplayLabel}` : undefined,
        session.isTemporary ? "project kind: temporary" : undefined,
        `title: ${session.title || "(untitled)"}`,
        `id: ${session.id}`,
        `cwd: ${session.cwd}`,
        `source: ${session.source}`,
        `updated: ${formatTime(session.updatedAt)}`
    ].filter((line) => line !== undefined).join("\n");
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
                session.projectDisplayLabel ? `project: ${session.projectDisplayLabel}` : undefined,
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
            "后续普通指令会使用 Codex CLI 解析到的最新会话。建议发送 list-project 明确选择。"
        ].join("\n");
    }
    return "当前没有绑定 Codex 会话。请先发送 list-project 选择一个 project。";
}
async function listSessionsForMode(config, mode) {
    if (mode === "temp") {
        return listCodexSessions(config, { all: true, temporaryOnly: true });
    }
    return listCodexSessions(config, { all: true, includeTemporary: true });
}
async function queryCodexSessionRows(dbPath, options) {
    const sqliteCommand = options.sqliteCommand ?? "sqlite3";
    const columns = await getThreadColumns(dbPath, sqliteCommand);
    const limitClause = options.limit ? `limit ${options.limit}` : "";
    const sql = `
select
  id,
  title,
  cwd,
  source,
  updated_at as updatedAt,
  created_at as createdAt,
  ${columnExpression(columns, "model", "model")},
  ${columnExpression(columns, "git_branch", "gitBranch")},
  ${columnExpression(columns, "git_origin_url", "gitOriginUrl")},
  ${columnExpression(columns, "rollout_path", "rolloutPath")},
  ${columnExpression(columns, "first_user_message", "firstUserMessage")}
from threads
where archived = 0
order by updated_at desc, id desc
${limitClause};
`;
    const { stdout } = await execFileAsync(sqliteCommand, ["-json", dbPath, sql]);
    return parseSessionRows(stdout);
}
async function getThreadColumns(dbPath, sqliteCommand) {
    const { stdout } = await execFileAsync(sqliteCommand, ["-json", dbPath, "pragma table_info(threads);"]);
    const rows = parseJsonArray(stdout, "sqlite3 threads schema");
    return new Set(rows.map((row) => row.name).filter((name) => typeof name === "string"));
}
function columnExpression(columns, column, alias) {
    return columns.has(column) ? `${column} as ${alias}` : `null as ${alias}`;
}
async function decorateSessions(sessions, config) {
    const globalState = await loadCodexGlobalState(config.globalStatePath);
    const secondaryNameCache = new Map();
    return Promise.all(sessions.map((session) => (decorateSession(session, globalState, secondaryNameCache))));
}
async function decorateSession(session, globalState, secondaryNameCache) {
    const realRootPath = await resolveRealPath(session.cwd);
    const label = globalState.workspaceLabels.get(realRootPath) ??
        globalState.workspaceLabels.get(resolve(session.cwd));
    const hasWorkspaceLabel = Boolean(label);
    const isTemporary = globalState.projectlessThreadIds.has(session.id) ||
        (!hasWorkspaceLabel && isPathInside(realRootPath, DOCUMENTS_CODEX_ROOT));
    const projectKind = isTemporary ? TEMPORARY_PROJECT_KIND : DEFAULT_PROJECT_KIND;
    const projectId = buildCodexProjectId(projectKind, realRootPath);
    const secondaryName = await cachedSecondaryName(session, realRootPath, secondaryNameCache);
    const primaryName = label ?? (basename(realRootPath) || realRootPath);
    const projectDisplayLabel = formatProjectDisplayLabel(primaryName, secondaryName);
    return {
        ...session,
        projectId,
        projectKind,
        projectRootPath: realRootPath,
        projectDisplayName: primaryName,
        projectSecondaryName: secondaryName,
        projectDisplayLabel,
        projectLabelSource: label ? "codex-global-state" : "basename",
        isTemporary
    };
}
async function cachedSecondaryName(session, realRootPath, cache) {
    const key = `${session.gitOriginUrl ?? ""}\0${realRootPath}`;
    let value = cache.get(key);
    if (!value) {
        value = resolveSecondaryName(session.cwd, realRootPath, session.gitOriginUrl);
        cache.set(key, value);
    }
    return value;
}
async function resolveSecondaryName(cwd, realRootPath, gitOriginUrl) {
    const originName = gitOriginUrl ? repoNameFromGitOrigin(gitOriginUrl) : undefined;
    if (originName)
        return originName;
    try {
        const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
        const gitRoot = stdout.trim();
        if (gitRoot)
            return basename(gitRoot) || basename(realRootPath) || realRootPath;
    }
    catch {
        // Missing git context is fine; Codex cwd remains the project root.
    }
    return basename(realRootPath) || realRootPath;
}
function repoNameFromGitOrigin(origin) {
    const trimmed = origin.trim().replace(/\.git$/i, "");
    if (!trimmed)
        return undefined;
    const normalized = trimmed.replaceAll("\\", "/");
    const separators = [normalized.lastIndexOf("/"), normalized.lastIndexOf(":")];
    const index = Math.max(...separators);
    const name = index >= 0 ? normalized.slice(index + 1) : normalized;
    return name || undefined;
}
async function resolveRealPath(value) {
    try {
        return await realpath(value);
    }
    catch {
        return resolve(value);
    }
}
async function loadCodexGlobalState(statePath) {
    const resolvedStatePath = statePath ?? join(homedir(), ".codex", ".codex-global-state.json");
    let raw;
    try {
        raw = await readFile(resolvedStatePath, "utf8");
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return {
                workspaceLabels: new Map(),
                projectlessThreadIds: new Set()
            };
        }
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new ConfigError(`Invalid JSON in ${resolvedStatePath}: ${error.message}`);
    }
    const object = isRecord(parsed) ? parsed : {};
    const labels = isRecord(object["electron-workspace-root-labels"])
        ? object["electron-workspace-root-labels"]
        : {};
    const workspaceLabels = new Map();
    for (const [path, value] of Object.entries(labels)) {
        if (typeof value !== "string" || value.length === 0)
            continue;
        workspaceLabels.set(resolve(path), value);
        try {
            workspaceLabels.set(await realpath(path), value);
        }
        catch {
            // The label can point at a removed worktree; resolved path is still useful.
        }
    }
    const projectlessThreadIds = new Set();
    const ids = object["projectless-thread-ids"];
    if (Array.isArray(ids)) {
        for (const id of ids) {
            if (typeof id === "string" && id.length > 0) {
                projectlessThreadIds.add(id);
            }
        }
    }
    return {
        workspaceLabels,
        projectlessThreadIds
    };
}
function isPathInside(childPath, parentPath) {
    const normalizedChild = resolve(childPath);
    const normalizedParent = resolve(parentPath);
    const rel = relative(normalizedParent, normalizedChild);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function parseSessionRows(stdout) {
    return parseJsonArray(stdout, "sqlite3 session query")
        .map((row, index) => parseSessionRow(row, index));
}
function parseJsonArray(stdout, label) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return [];
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
        throw new ConfigError(`${label} returned non-array JSON`);
    }
    return parsed;
}
function parseSessionRow(row, index) {
    if (!isRecord(row)) {
        throw new ConfigError(`sqlite3 session row ${index} must be an object`);
    }
    return {
        id: requiredString(row.id, `session[${index}].id`),
        title: optionalString(row.title, `session[${index}].title`) ?? "",
        cwd: requiredString(row.cwd, `session[${index}].cwd`),
        source: optionalString(row.source, `session[${index}].source`) ?? "",
        updatedAt: requiredNumber(row.updatedAt, `session[${index}].updatedAt`),
        createdAt: requiredNumber(row.createdAt, `session[${index}].createdAt`),
        model: optionalString(row.model, `session[${index}].model`),
        gitBranch: optionalString(row.gitBranch, `session[${index}].gitBranch`),
        gitOriginUrl: optionalString(row.gitOriginUrl, `session[${index}].gitOriginUrl`),
        rolloutPath: optionalString(row.rolloutPath, `session[${index}].rolloutPath`),
        firstUserMessage: optionalString(row.firstUserMessage, `session[${index}].firstUserMessage`)
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
    if (!isRecord(entry))
        return undefined;
    if (entry.type !== "response_item")
        return undefined;
    const payload = entry.payload;
    if (!isRecord(payload))
        return undefined;
    if (payload.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) {
        return undefined;
    }
    const text = extractMessageText(payload.content);
    return text ? { role: payload.role, text } : undefined;
}
function extractMessageText(content) {
    if (!Array.isArray(content))
        return undefined;
    const parts = [];
    for (const item of content) {
        if (!isRecord(item))
            continue;
        if (typeof item.text === "string") {
            parts.push(item.text);
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
function formatGlobalHelp() {
    return [
        "可用指令：",
        "",
        "help / 帮助：查看帮助。",
        "list-project [页码]：列出可绑定 project。",
        "current-project：查看当前群绑定的 project。",
        "bind-project <序号|projectId>：绑定 project。",
        "new-session [初始说明]：在当前 project 下开启并绑定一个新会话。",
        "list-session：列出当前 project 下会话。",
        "switch-session <序号|sessionId>：切换当前 project 下会话。",
        "list-session --all [页码]：全局会话分页。",
        "list-session --temp [页码]：临时对话分页。",
        "current-session：查看当前绑定。",
        "unbind-project：解除当前群 project / session 绑定。",
        "unbind-session：兼容旧命令，等同于 unbind-project。",
        "",
        `分页默认每页 ${DEFAULT_SESSION_PAGE_SIZE} 个。临时对话默认不进入 project 绑定。`
    ].join("\n");
}
function parsePage(value) {
    if (!value)
        return 1;
    const page = Number(value);
    return Number.isInteger(page) && page >= 1 ? page : 1;
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
    return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
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
