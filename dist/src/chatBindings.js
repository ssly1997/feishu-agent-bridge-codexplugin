import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { buildCodexProjectId, formatProjectDisplayLabel } from "./codexSessions.js";
const execFileAsync = promisify(execFile);
const SQLITE_BUSY_TIMEOUT_MS = 5000;
export async function getChatSessionBinding(queuePath, chatId) {
    await ensureChatSessionBindingSchema(queuePath);
    const rows = await sqliteJson(queuePath, `select * from chat_session_bindings where chat_id = ${sqlValue(chatId)} limit 1;`);
    return rows[0] ? rowToBinding(rows[0]) : undefined;
}
export async function listChatSessionBindingsBySession(queuePath, sessionId, options = {}) {
    await ensureChatSessionBindingSchema(queuePath);
    const filters = [
        `session_id = ${sqlValue(sessionId)}`,
        options.excludeChatId ? `chat_id <> ${sqlValue(options.excludeChatId)}` : undefined
    ].filter((item) => Boolean(item));
    const limit = positiveInteger(options.limit) ? `limit ${options.limit}` : "";
    const rows = await sqliteJson(queuePath, `select * from chat_session_bindings
     where ${filters.join(" and ")}
     order by updated_at desc
     ${limit};`);
    return rows.map(rowToBinding);
}
export async function upsertChatSessionBinding(queuePath, input) {
    await ensureChatSessionBindingSchema(queuePath);
    const now = new Date().toISOString();
    const sessionTitle = input.session.title || "(untitled)";
    const rows = await sqliteJson(queuePath, `insert into chat_session_bindings (
       chat_id, chat_type, chat_name, session_id, session_title, session_cwd, session_source,
       session_git_branch, session_updated_at, project_id, project_kind, project_root_path,
       project_display_name, project_secondary_name, project_display_label, project_label_source,
       created_at, updated_at
     ) values (
       ${sqlValue(input.chatId)}, ${sqlValue(input.chatType)}, ${sqlValue(input.chatName)},
       ${sqlValue(input.session.id)}, ${sqlValue(sessionTitle)}, ${sqlValue(input.session.cwd)},
       ${sqlValue(input.session.source)}, ${sqlValue(input.session.gitBranch)}, ${sqlNumber(input.session.updatedAt)},
       ${sqlValue(input.session.projectId)}, ${sqlValue(input.session.projectKind)},
       ${sqlValue(input.session.projectRootPath)}, ${sqlValue(input.session.projectDisplayName)},
       ${sqlValue(input.session.projectSecondaryName)}, ${sqlValue(input.session.projectDisplayLabel)},
       ${sqlValue(input.session.projectLabelSource)},
       ${sqlValue(now)}, ${sqlValue(now)}
     )
     on conflict(chat_id) do update set
       chat_type = excluded.chat_type,
       chat_name = coalesce(excluded.chat_name, chat_session_bindings.chat_name),
       session_id = excluded.session_id,
       session_title = excluded.session_title,
       session_cwd = excluded.session_cwd,
       session_source = excluded.session_source,
       session_git_branch = excluded.session_git_branch,
       session_updated_at = excluded.session_updated_at,
       project_id = excluded.project_id,
       project_kind = excluded.project_kind,
       project_root_path = excluded.project_root_path,
       project_display_name = excluded.project_display_name,
       project_secondary_name = excluded.project_secondary_name,
       project_display_label = excluded.project_display_label,
       project_label_source = excluded.project_label_source,
       updated_at = excluded.updated_at
     returning *;`);
    return rowToBinding(rows[0]);
}
export async function deleteChatSessionBinding(queuePath, chatId) {
    await ensureChatSessionBindingSchema(queuePath);
    const binding = await getChatSessionBinding(queuePath, chatId);
    if (!binding)
        return undefined;
    await sqliteExec(queuePath, `delete from chat_session_bindings where chat_id = ${sqlValue(chatId)};`);
    return binding;
}
export async function clearChatActiveSession(queuePath, chatId) {
    await ensureChatSessionBindingSchema(queuePath);
    const binding = await getChatSessionBinding(queuePath, chatId);
    if (!binding)
        return undefined;
    if (!binding.sessionId)
        return binding;
    await sqliteExec(queuePath, `update chat_session_bindings
     set session_id = null,
         session_title = null,
         session_cwd = null,
         session_source = null,
         session_git_branch = null,
         session_updated_at = null,
         updated_at = ${sqlValue(new Date().toISOString())}
     where chat_id = ${sqlValue(chatId)};`);
    return getChatSessionBinding(queuePath, chatId);
}
export async function updateChatSessionBindingChatName(queuePath, chatId, chatName) {
    await ensureChatSessionBindingSchema(queuePath);
    await sqliteExec(queuePath, `update chat_session_bindings
     set chat_name = ${sqlValue(chatName)}
     where chat_id = ${sqlValue(chatId)};`);
}
export function bindingToCommandSession(binding) {
    if (!binding.sessionId)
        return undefined;
    return {
        sessionId: binding.sessionId,
        sessionTitle: binding.sessionTitle,
        sessionCwd: binding.sessionCwd,
        sessionSource: binding.sessionSource,
        sessionGitBranch: binding.sessionGitBranch,
        sessionUpdatedAt: binding.sessionUpdatedAt,
        projectId: binding.projectId,
        projectKind: binding.projectKind,
        projectRootPath: binding.projectRootPath,
        projectDisplayName: binding.projectDisplayName,
        projectSecondaryName: binding.projectSecondaryName,
        projectDisplayLabel: binding.projectDisplayLabel,
        projectLabelSource: binding.projectLabelSource
    };
}
export function formatCurrentChatSession(binding) {
    if (!binding) {
        return "当前群没有绑定 Codex project。请先发送 list-project 选择一个 project。";
    }
    const activeSessionLines = binding.sessionId
        ? [
            "Active session:",
            `title: ${binding.sessionTitle || "(untitled)"}`,
            `id: ${binding.sessionId}`,
            binding.sessionCwd ? `cwd: ${binding.sessionCwd}` : undefined,
            binding.sessionSource ? `source: ${binding.sessionSource}` : undefined,
            binding.sessionGitBranch ? `branch: ${binding.sessionGitBranch}` : undefined,
            binding.sessionUpdatedAt ? `session updated: ${formatTime(binding.sessionUpdatedAt)}` : undefined
        ]
        : [
            "Active session:",
            "未绑定 active session。请发送 list-session 选择会话，或发送 new-session 在当前 project 下开启新会话。"
        ];
    return [
        "当前群绑定的 Codex project：",
        "",
        binding.chatName ? `chat: ${binding.chatName}` : undefined,
        binding.projectDisplayLabel ? `project: ${binding.projectDisplayLabel}` : undefined,
        binding.projectId ? `project id: ${binding.projectId}` : undefined,
        binding.projectRootPath ? `project root: ${binding.projectRootPath}` : undefined,
        "",
        ...activeSessionLines,
        `binding updated: ${binding.updatedAt}`
    ].filter((line) => line !== undefined).join("\n");
}
export function formatCurrentChatProject(binding) {
    if (!binding) {
        return "当前群没有绑定 Codex project。请先发送 list-project 选择一个 project。";
    }
    const activeSessionLines = binding.sessionId
        ? [
            "Active session:",
            `title: ${binding.sessionTitle || "(untitled)"}`,
            `id: ${binding.sessionId}`,
            binding.sessionUpdatedAt ? `session updated: ${formatTime(binding.sessionUpdatedAt)}` : undefined
        ]
        : [
            "Active session:",
            "未绑定 active session。"
        ];
    return [
        "当前群绑定的 Codex project：",
        "",
        binding.chatName ? `chat: ${binding.chatName}` : undefined,
        binding.projectDisplayLabel ? `project: ${binding.projectDisplayLabel}` : undefined,
        binding.projectId ? `project id: ${binding.projectId}` : undefined,
        binding.projectKind ? `project kind: ${binding.projectKind}` : undefined,
        binding.projectRootPath ? `project root: ${binding.projectRootPath}` : undefined,
        binding.projectLabelSource ? `label source: ${binding.projectLabelSource}` : undefined,
        "",
        ...activeSessionLines,
        `binding updated: ${binding.updatedAt}`
    ].filter((line) => line !== undefined).join("\n");
}
export async function ensureChatSessionBindingSchema(queuePath) {
    await mkdir(dirname(queuePath), { recursive: true });
    await sqliteExec(queuePath, `create table if not exists chat_session_bindings (
       chat_id text primary key,
       chat_type text,
       chat_name text,
       session_id text,
       session_title text,
       session_cwd text,
       session_source text,
       session_git_branch text,
       session_updated_at integer,
       project_id text,
       project_kind text,
       project_root_path text,
       project_display_name text,
       project_secondary_name text,
       project_display_label text,
       project_label_source text,
       created_at text not null,
       updated_at text not null
     );
     create index if not exists chat_session_bindings_session_idx
       on chat_session_bindings(session_id, updated_at);`);
    await ensureChatSessionBindingColumns(queuePath);
    await ensureChatSessionBindingSessionNullable(queuePath);
    await backfillLegacyProjectColumns(queuePath);
    await sqliteExec(queuePath, `create index if not exists chat_session_bindings_project_idx
       on chat_session_bindings(project_id, updated_at);`);
}
async function sqliteExec(queuePath, sql) {
    await execFileAsync("sqlite3", sqliteArgs(queuePath, sql), { maxBuffer: 10 * 1024 * 1024 });
}
async function sqliteJson(queuePath, sql) {
    const { stdout } = await execFileAsync("sqlite3", ["-json", ...sqliteArgs(queuePath, sql)], {
        maxBuffer: 10 * 1024 * 1024
    });
    const trimmed = stdout.trim();
    return trimmed ? JSON.parse(trimmed) : [];
}
function sqliteArgs(queuePath, sql) {
    return ["-cmd", `.timeout ${SQLITE_BUSY_TIMEOUT_MS}`, queuePath, sql];
}
function rowToBinding(row) {
    const legacyProject = row.project_id ? undefined : fallbackProjectFromSessionCwd(row.session_cwd);
    return {
        chatId: row.chat_id,
        chatType: row.chat_type ?? undefined,
        chatName: row.chat_name ?? undefined,
        sessionId: row.session_id ?? undefined,
        sessionTitle: row.session_title ?? undefined,
        sessionCwd: row.session_cwd ?? undefined,
        sessionSource: row.session_source ?? undefined,
        sessionGitBranch: row.session_git_branch ?? undefined,
        sessionUpdatedAt: row.session_updated_at ?? undefined,
        projectId: row.project_id ?? legacyProject?.projectId,
        projectKind: row.project_kind ?? legacyProject?.projectKind,
        projectRootPath: row.project_root_path ?? legacyProject?.projectRootPath,
        projectDisplayName: row.project_display_name ?? legacyProject?.projectDisplayName,
        projectSecondaryName: row.project_secondary_name ?? legacyProject?.projectSecondaryName,
        projectDisplayLabel: row.project_display_label ?? legacyProject?.projectDisplayLabel,
        projectLabelSource: row.project_label_source ?? legacyProject?.projectLabelSource,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}
async function ensureChatSessionBindingColumns(queuePath) {
    const existing = new Set((await sqliteJson(queuePath, "pragma table_info(chat_session_bindings);"))
        .map((row) => row.name));
    const missing = [
        ["chat_name", "text"],
        ["project_id", "text"],
        ["project_kind", "text"],
        ["project_root_path", "text"],
        ["project_display_name", "text"],
        ["project_secondary_name", "text"],
        ["project_display_label", "text"],
        ["project_label_source", "text"]
    ].filter(([name]) => !existing.has(name));
    for (const [name, type] of missing) {
        await sqliteExec(queuePath, `alter table chat_session_bindings add column ${name} ${type};`);
    }
}
async function ensureChatSessionBindingSessionNullable(queuePath) {
    const columns = await sqliteJson(queuePath, "pragma table_info(chat_session_bindings);");
    const sessionIdColumn = columns.find((column) => column.name === "session_id");
    if (!sessionIdColumn || Number(sessionIdColumn.notnull) === 0)
        return;
    await sqliteExec(queuePath, `pragma foreign_keys = off;
     begin immediate;
     create table chat_session_bindings_new (
       chat_id text primary key,
       chat_type text,
       chat_name text,
       session_id text,
       session_title text,
       session_cwd text,
       session_source text,
       session_git_branch text,
       session_updated_at integer,
       project_id text,
       project_kind text,
       project_root_path text,
       project_display_name text,
       project_secondary_name text,
       project_display_label text,
       project_label_source text,
       created_at text not null,
       updated_at text not null
     );
     insert into chat_session_bindings_new (
       chat_id, chat_type, chat_name, session_id, session_title, session_cwd,
       session_source, session_git_branch, session_updated_at, project_id, project_kind,
       project_root_path, project_display_name, project_secondary_name, project_display_label,
       project_label_source, created_at, updated_at
     )
     select
       chat_id, chat_type, chat_name, session_id, session_title, session_cwd,
       session_source, session_git_branch, session_updated_at, project_id, project_kind,
       project_root_path, project_display_name, project_secondary_name, project_display_label,
       project_label_source, created_at, updated_at
     from chat_session_bindings;
     drop table chat_session_bindings;
     alter table chat_session_bindings_new rename to chat_session_bindings;
     commit;
     pragma foreign_keys = on;`);
}
async function backfillLegacyProjectColumns(queuePath) {
    const rows = await sqliteJson(queuePath, `select chat_id, session_cwd
     from chat_session_bindings
     where project_id is null and session_cwd is not null and session_cwd <> '';`);
    for (const row of rows) {
        const project = fallbackProjectFromSessionCwd(row.session_cwd);
        if (!project)
            continue;
        await sqliteExec(queuePath, `update chat_session_bindings
       set project_id = ${sqlValue(project.projectId)},
           project_kind = ${sqlValue(project.projectKind)},
           project_root_path = ${sqlValue(project.projectRootPath)},
           project_display_name = ${sqlValue(project.projectDisplayName)},
           project_secondary_name = ${sqlValue(project.projectSecondaryName)},
           project_display_label = ${sqlValue(project.projectDisplayLabel)},
           project_label_source = ${sqlValue(project.projectLabelSource)}
       where chat_id = ${sqlValue(row.chat_id)}
         and project_id is null;`);
    }
}
function fallbackProjectFromSessionCwd(sessionCwd) {
    if (!sessionCwd)
        return undefined;
    const projectRootPath = resolve(sessionCwd);
    const name = basename(projectRootPath) || projectRootPath;
    return {
        projectId: buildCodexProjectId("workspace", projectRootPath),
        projectKind: "workspace",
        projectRootPath,
        projectDisplayName: name,
        projectSecondaryName: name,
        projectDisplayLabel: formatProjectDisplayLabel(name, name),
        projectLabelSource: "legacy-cwd"
    };
}
function positiveInteger(value) {
    return Number.isInteger(value) && value !== undefined && value > 0;
}
function sqlValue(value) {
    if (value === undefined || value === null)
        return "null";
    return `'${value.replaceAll("'", "''")}'`;
}
function sqlNumber(value) {
    return value === undefined ? "null" : String(value);
}
function formatTime(seconds) {
    return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}
