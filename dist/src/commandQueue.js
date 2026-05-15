import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ensureChatSessionBindingSchema } from "./chatBindings.js";
import { CONFIG_DIR } from "./config.js";
const execFileAsync = promisify(execFile);
export const DEFAULT_COMMAND_QUEUE_DB_PATH = join(CONFIG_DIR, "commands.db");
export const DEFAULT_LEGACY_COMMAND_QUEUE_PATH = join(CONFIG_DIR, "commands.json");
export const DEFAULT_COMMAND_QUEUE_PATH = DEFAULT_COMMAND_QUEUE_DB_PATH;
export function resolveCommandQueuePath(config) {
    return config.inbound.queueDbPath ?? DEFAULT_COMMAND_QUEUE_DB_PATH;
}
export function resolveLegacyCommandQueuePath(config) {
    return config.inbound.queuePath ?? DEFAULT_LEGACY_COMMAND_QUEUE_PATH;
}
export async function initializeCommandQueue(queuePath = DEFAULT_COMMAND_QUEUE_DB_PATH, options = {}) {
    await ensureSchema(queuePath);
    if (options.migrateLegacyJson ?? true) {
        await migrateLegacyJsonQueue(queuePath, options.legacyJsonPath ?? DEFAULT_LEGACY_COMMAND_QUEUE_PATH);
    }
}
export async function enqueueCommand(input, queuePath = DEFAULT_COMMAND_QUEUE_DB_PATH) {
    await ensureSchema(queuePath);
    const existing = await findCommandByMessageId(queuePath, input.messageId);
    if (existing) {
        return { command: existing, inserted: false };
    }
    const now = new Date().toISOString();
    const command = {
        id: `fcmd_${randomUUID()}`,
        state: "pending",
        text: input.text,
        rawText: input.rawText,
        messageId: input.messageId,
        chatId: input.chatId,
        chatType: input.chatType,
        sender: input.sender,
        source: "feishu",
        eventId: input.eventId,
        tenantKey: input.tenantKey,
        createdAt: input.createdAt,
        receivedAt: now,
        sessionId: input.sessionId,
        sessionTitle: input.sessionTitle,
        sessionCwd: input.sessionCwd,
        sessionSource: input.sessionSource,
        sessionGitBranch: input.sessionGitBranch,
        sessionUpdatedAt: input.sessionUpdatedAt,
        attachments: input.attachments,
        attempts: 0
    };
    await sqliteExec(queuePath, `insert into commands (
      id, state, text, raw_text, message_id, chat_id, chat_type, sender_json, source,
      event_id, tenant_key, created_at, received_at, session_id, session_title, session_cwd,
      session_source, session_git_branch, session_updated_at, attachments_json, attempts
    ) values (
      ${sqlValue(command.id)}, ${sqlValue(command.state)}, ${sqlValue(command.text)},
      ${sqlValue(command.rawText)}, ${sqlValue(command.messageId)}, ${sqlValue(command.chatId)},
      ${sqlValue(command.chatType)}, ${sqlValue(JSON.stringify(command.sender))},
      ${sqlValue(command.source)}, ${sqlValue(command.eventId)}, ${sqlValue(command.tenantKey)},
      ${sqlValue(command.createdAt)}, ${sqlValue(command.receivedAt)}, ${sqlValue(command.sessionId)},
      ${sqlValue(command.sessionTitle)}, ${sqlValue(command.sessionCwd)}, ${sqlValue(command.sessionSource)},
      ${sqlValue(command.sessionGitBranch)}, ${sqlNumber(command.sessionUpdatedAt)},
      ${sqlValue(JSON.stringify(command.attachments ?? []))}, ${command.attempts}
    );`);
    return { command, inserted: true };
}
export async function getNextCommand(queuePath = DEFAULT_COMMAND_QUEUE_DB_PATH, options = {}) {
    await ensureSchema(queuePath);
    const where = pendingWhere(options.sessionId);
    if (options.claim ?? true) {
        const now = new Date().toISOString();
        const rows = await sqliteJson(queuePath, `begin immediate;
       update commands
       set state = 'in_progress',
           claimed_at = ${sqlValue(now)},
           attempts = attempts + 1
       where id = (
         select id from commands
         where ${where}
         order by received_at asc, id asc
         limit 1
       )
       returning *;
       commit;`);
        return rows[0] ? rowToCommand(rows[0]) : undefined;
    }
    const rows = await sqliteJson(queuePath, `select * from commands where ${where} order by received_at asc, id asc limit 1;`);
    return rows[0] ? rowToCommand(rows[0]) : undefined;
}
export async function listCommands(queuePath = DEFAULT_COMMAND_QUEUE_DB_PATH, options = {}) {
    await ensureSchema(queuePath);
    const filters = [
        options.state ? `state = ${sqlValue(options.state)}` : undefined,
        options.sessionId ? `session_id = ${sqlValue(options.sessionId)}` : undefined
    ].filter((item) => Boolean(item));
    const where = filters.length ? `where ${filters.join(" and ")}` : "";
    const limit = positiveInteger(options.limit) ? `limit ${options.limit}` : "";
    const rows = await sqliteJson(queuePath, `select * from commands ${where} order by received_at asc, id asc ${limit};`);
    return rows.map(rowToCommand);
}
export async function ackCommand(id, state, queuePath = DEFAULT_COMMAND_QUEUE_DB_PATH, resultSummary) {
    await ensureSchema(queuePath);
    const rows = await sqliteJson(queuePath, `update commands
     set state = ${sqlValue(state)},
         completed_at = ${sqlValue(new Date().toISOString())},
         result_summary = ${sqlValue(resultSummary)}
     where id = ${sqlValue(id)}
     returning *;`);
    return rows[0] ? rowToCommand(rows[0]) : undefined;
}
export async function updateCommandStatusMetadata(id, queuePath = DEFAULT_COMMAND_QUEUE_DB_PATH, patch) {
    await ensureSchema(queuePath);
    const assignments = [
        hasOwn(patch, "statusMessageId")
            ? `status_message_id = ${sqlValue(patch.statusMessageId)}`
            : undefined,
        hasOwn(patch, "statusUpdatedAt")
            ? `status_updated_at = ${sqlValue(patch.statusUpdatedAt)}`
            : undefined,
        hasOwn(patch, "statusNotifyError")
            ? `status_notify_error = ${sqlValue(patch.statusNotifyError)}`
            : undefined,
        hasOwn(patch, "statusSummary")
            ? `status_summary = ${sqlValue(patch.statusSummary)}`
            : undefined
    ].filter((item) => Boolean(item));
    if (assignments.length === 0) {
        return findCommandById(queuePath, id);
    }
    const rows = await sqliteJson(queuePath, `update commands
     set ${assignments.join(",\n         ")}
     where id = ${sqlValue(id)}
     returning *;`);
    return rows[0] ? rowToCommand(rows[0]) : undefined;
}
export async function getCommandQueueStats(queuePath = DEFAULT_COMMAND_QUEUE_DB_PATH) {
    await ensureSchema(queuePath);
    const totals = await sqliteJson(queuePath, `select
       count(*) as total,
       sum(case when state = 'pending' then 1 else 0 end) as pending,
       sum(case when state = 'in_progress' then 1 else 0 end) as inProgress,
       sum(case when state = 'done' then 1 else 0 end) as done,
       sum(case when state = 'failed' then 1 else 0 end) as failed
     from commands;`);
    const sessions = await sqliteJson(queuePath, `select
       session_id as sessionId,
       max(session_title) as sessionTitle,
       count(*) as total,
       sum(case when state = 'pending' then 1 else 0 end) as pending,
       sum(case when state = 'in_progress' then 1 else 0 end) as inProgress,
       sum(case when state = 'done' then 1 else 0 end) as done,
       sum(case when state = 'failed' then 1 else 0 end) as failed
     from commands
     where session_id is not null and session_id <> ''
     group by session_id
     order by max(received_at) desc;`);
    const total = totals[0];
    return {
        queuePath,
        total: total?.total ?? 0,
        pending: total?.pending ?? 0,
        inProgress: total?.inProgress ?? 0,
        done: total?.done ?? 0,
        failed: total?.failed ?? 0,
        sessions: sessions.map((row) => ({
            sessionId: row.sessionId,
            sessionTitle: row.sessionTitle ?? undefined,
            total: row.total ?? 0,
            pending: row.pending ?? 0,
            inProgress: row.inProgress ?? 0,
            done: row.done ?? 0,
            failed: row.failed ?? 0
        }))
    };
}
export async function readCommandQueue(queuePath = DEFAULT_COMMAND_QUEUE_DB_PATH) {
    return listCommands(queuePath);
}
export async function getPendingSessionIds(queuePath = DEFAULT_COMMAND_QUEUE_DB_PATH) {
    await ensureSchema(queuePath);
    const rows = await sqliteJson(queuePath, `select distinct session_id as sessionId
     from commands
     where state = 'pending' and session_id is not null and session_id <> ''
     order by session_id asc;`);
    return rows.map((row) => row.sessionId);
}
export async function recoverInProgressCommands(queuePath = DEFAULT_COMMAND_QUEUE_DB_PATH, options) {
    await ensureSchema(queuePath);
    const cutoff = new Date((options.now?.() ?? Date.now()) - options.timeoutMs).toISOString();
    const nextState = options.recovery === "reset_pending" ? "pending" : "failed";
    const completedAt = options.recovery === "reset_pending" ? "null" : sqlValue(new Date().toISOString());
    const claimedAt = options.recovery === "reset_pending" ? "null" : "claimed_at";
    const summary = options.recovery === "reset_pending"
        ? "result_summary"
        : sqlValue(`Recovered stale in_progress command after ${options.timeoutMs}ms`);
    const rows = await sqliteJson(queuePath, `begin immediate;
     update commands
     set state = ${sqlValue(nextState)},
         claimed_at = ${claimedAt},
         completed_at = ${completedAt},
         result_summary = ${summary}
     where state = 'in_progress'
       and claimed_at is not null
       and claimed_at < ${sqlValue(cutoff)};
     select changes() as changed;
     commit;`);
    return rows[0]?.changed ?? 0;
}
async function migrateLegacyJsonQueue(queuePath, legacyJsonPath) {
    let raw;
    try {
        raw = await readFile(legacyJsonPath, "utf8");
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT")
            return;
        throw error;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed))
        return;
    for (const item of parsed) {
        const command = normalizeLegacyCommand(item);
        if (!command || await findCommandByMessageId(queuePath, command.messageId))
            continue;
        await insertCommand(queuePath, command);
    }
}
async function insertCommand(queuePath, command) {
    await sqliteExec(queuePath, `insert or ignore into commands (
      id, state, text, raw_text, message_id, chat_id, chat_type, sender_json, source,
      event_id, tenant_key, created_at, received_at, session_id, session_title, session_cwd,
      session_source, session_git_branch, session_updated_at, claimed_at, completed_at,
      attempts, result_summary, status_message_id, status_updated_at, status_notify_error,
      status_summary, attachments_json
    ) values (
      ${sqlValue(command.id)}, ${sqlValue(command.state)}, ${sqlValue(command.text)},
      ${sqlValue(command.rawText)}, ${sqlValue(command.messageId)}, ${sqlValue(command.chatId)},
      ${sqlValue(command.chatType)}, ${sqlValue(JSON.stringify(command.sender))},
      ${sqlValue(command.source)}, ${sqlValue(command.eventId)}, ${sqlValue(command.tenantKey)},
      ${sqlValue(command.createdAt)}, ${sqlValue(command.receivedAt)}, ${sqlValue(command.sessionId)},
      ${sqlValue(command.sessionTitle)}, ${sqlValue(command.sessionCwd)}, ${sqlValue(command.sessionSource)},
      ${sqlValue(command.sessionGitBranch)}, ${sqlNumber(command.sessionUpdatedAt)},
      ${sqlValue(command.claimedAt)}, ${sqlValue(command.completedAt)}, ${command.attempts},
      ${sqlValue(command.resultSummary)}, ${sqlValue(command.statusMessageId)},
      ${sqlValue(command.statusUpdatedAt)}, ${sqlValue(command.statusNotifyError)},
      ${sqlValue(command.statusSummary)}, ${sqlValue(JSON.stringify(command.attachments ?? []))}
    );`);
}
async function findCommandById(queuePath, id) {
    const rows = await sqliteJson(queuePath, `select * from commands where id = ${sqlValue(id)} limit 1;`);
    return rows[0] ? rowToCommand(rows[0]) : undefined;
}
async function findCommandByMessageId(queuePath, messageId) {
    const rows = await sqliteJson(queuePath, `select * from commands where message_id = ${sqlValue(messageId)} limit 1;`);
    return rows[0] ? rowToCommand(rows[0]) : undefined;
}
async function ensureSchema(queuePath) {
    await mkdir(dirname(queuePath), { recursive: true });
    await sqliteExec(queuePath, `pragma journal_mode = wal;
     create table if not exists commands (
       id text primary key,
       state text not null check (state in ('pending', 'in_progress', 'done', 'failed')),
       text text not null,
       raw_text text not null,
       message_id text not null unique,
       chat_id text not null,
       chat_type text,
       sender_json text not null,
       source text not null,
       event_id text,
       tenant_key text,
       created_at text,
       received_at text not null,
       session_id text,
       session_title text,
       session_cwd text,
       session_source text,
       session_git_branch text,
       session_updated_at integer,
       claimed_at text,
       completed_at text,
       attempts integer not null default 0,
       result_summary text,
       status_message_id text,
       status_updated_at text,
       status_notify_error text,
       status_summary text,
       attachments_json text
     );
     create index if not exists commands_state_session_idx
       on commands(state, session_id, received_at, id);
     create index if not exists commands_session_idx
       on commands(session_id, received_at, id);`);
    await ensureCommandStatusColumns(queuePath);
    await ensureChatSessionBindingSchema(queuePath);
}
async function ensureCommandStatusColumns(queuePath) {
    const columns = await sqliteJson(queuePath, "pragma table_info(commands);");
    const existing = new Set(columns.map((column) => column.name));
    const missing = [
        ["status_message_id", "text"],
        ["status_updated_at", "text"],
        ["status_notify_error", "text"],
        ["status_summary", "text"],
        ["attachments_json", "text"]
    ].filter(([name]) => !existing.has(name));
    for (const [name, type] of missing) {
        try {
            await sqliteExec(queuePath, `alter table commands add column ${name} ${type};`);
        }
        catch (error) {
            if (!isDuplicateColumnError(error))
                throw error;
        }
    }
}
async function sqliteExec(queuePath, sql) {
    await execFileAsync("sqlite3", [queuePath, sql], { maxBuffer: 10 * 1024 * 1024 });
}
async function sqliteJson(queuePath, sql) {
    const { stdout } = await execFileAsync("sqlite3", ["-json", queuePath, sql], {
        maxBuffer: 10 * 1024 * 1024
    });
    const trimmed = stdout.trim();
    return trimmed ? JSON.parse(trimmed) : [];
}
function pendingWhere(sessionId) {
    const base = "state = 'pending'";
    if (sessionId) {
        return [
            base,
            `session_id = ${sqlValue(sessionId)}`,
            `not exists (
        select 1 from commands active
        where active.session_id = ${sqlValue(sessionId)}
          and active.state = 'in_progress'
      )`
        ].join(" and ");
    }
    return [
        base,
        `(
      session_id is null
      or session_id = ''
      or not exists (
        select 1 from commands active
        where active.session_id = commands.session_id
          and active.state = 'in_progress'
      )
    )`
    ].join(" and ");
}
function rowToCommand(row) {
    return {
        id: row.id,
        state: row.state,
        text: row.text,
        rawText: row.raw_text,
        messageId: row.message_id,
        chatId: row.chat_id,
        chatType: row.chat_type ?? undefined,
        sender: parseSender(row.sender_json),
        source: "feishu",
        eventId: row.event_id ?? undefined,
        tenantKey: row.tenant_key ?? undefined,
        createdAt: row.created_at ?? undefined,
        receivedAt: row.received_at,
        sessionId: row.session_id ?? undefined,
        sessionTitle: row.session_title ?? undefined,
        sessionCwd: row.session_cwd ?? undefined,
        sessionSource: row.session_source ?? undefined,
        sessionGitBranch: row.session_git_branch ?? undefined,
        sessionUpdatedAt: row.session_updated_at ?? undefined,
        claimedAt: row.claimed_at ?? undefined,
        completedAt: row.completed_at ?? undefined,
        attempts: row.attempts,
        resultSummary: row.result_summary ?? undefined,
        statusMessageId: row.status_message_id ?? undefined,
        statusUpdatedAt: row.status_updated_at ?? undefined,
        statusNotifyError: row.status_notify_error ?? undefined,
        statusSummary: row.status_summary ?? undefined,
        attachments: parseAttachments(row.attachments_json)
    };
}
function normalizeLegacyCommand(value) {
    if (!isRecord(value))
        return undefined;
    const id = stringValue(value.id);
    const state = commandState(value.state);
    const text = stringValue(value.text);
    const rawText = stringValue(value.rawText);
    const messageId = stringValue(value.messageId);
    const chatId = stringValue(value.chatId);
    const receivedAt = stringValue(value.receivedAt);
    if (!id || !state || !text || !rawText || !messageId || !chatId || !receivedAt) {
        return undefined;
    }
    return {
        id,
        state,
        text,
        rawText,
        messageId,
        chatId,
        chatType: stringValue(value.chatType),
        sender: isRecord(value.sender) ? value.sender : {},
        source: "feishu",
        eventId: stringValue(value.eventId),
        tenantKey: stringValue(value.tenantKey),
        createdAt: stringValue(value.createdAt),
        receivedAt,
        sessionId: stringValue(value.sessionId),
        sessionTitle: stringValue(value.sessionTitle),
        sessionCwd: stringValue(value.sessionCwd),
        sessionSource: stringValue(value.sessionSource),
        sessionGitBranch: stringValue(value.sessionGitBranch),
        sessionUpdatedAt: numberValue(value.sessionUpdatedAt),
        claimedAt: stringValue(value.claimedAt),
        completedAt: stringValue(value.completedAt),
        attempts: numberValue(value.attempts) ?? 0,
        resultSummary: stringValue(value.resultSummary),
        statusMessageId: stringValue(value.statusMessageId),
        statusUpdatedAt: stringValue(value.statusUpdatedAt),
        statusNotifyError: stringValue(value.statusNotifyError),
        statusSummary: stringValue(value.statusSummary),
        attachments: Array.isArray(value.attachments)
            ? value.attachments.filter((item) => (isRecord(item) && item.type === "image")).map((item) => ({
                type: "image",
                path: stringValue(item.path) ?? "",
                source: "feishu",
                messageId: stringValue(item.messageId) ?? messageId,
                resourceKey: stringValue(item.resourceKey) ?? "",
                mimeType: stringValue(item.mimeType),
                sizeBytes: numberValue(item.sizeBytes),
                sha256: stringValue(item.sha256)
            })).filter((item) => item.path && item.resourceKey)
            : undefined
    };
}
function parseSender(value) {
    try {
        const parsed = JSON.parse(value);
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function parseAttachments(value) {
    if (!value)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        return undefined;
    }
    if (!Array.isArray(parsed))
        return undefined;
    const attachments = parsed
        .filter((item) => (isRecord(item) && item.type === "image"))
        .map((item) => ({
        type: "image",
        path: stringValue(item.path) ?? "",
        source: "feishu",
        messageId: stringValue(item.messageId) ?? "",
        resourceKey: stringValue(item.resourceKey) ?? "",
        mimeType: stringValue(item.mimeType),
        sizeBytes: numberValue(item.sizeBytes),
        sha256: stringValue(item.sha256)
    }))
        .filter((item) => item.path && item.messageId && item.resourceKey);
    return attachments.length > 0 ? attachments : undefined;
}
function sqlValue(value) {
    if (value === undefined || value === null)
        return "null";
    return `'${value.replaceAll("'", "''")}'`;
}
function sqlNumber(value) {
    return value === undefined ? "null" : String(value);
}
function positiveInteger(value) {
    return Number.isInteger(value) && Number(value) > 0;
}
function commandState(value) {
    return value === "pending" || value === "in_progress" || value === "done" || value === "failed"
        ? value
        : undefined;
}
function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
function isDuplicateColumnError(error) {
    return error instanceof Error && /duplicate column name/i.test(error.message);
}
