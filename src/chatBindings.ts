import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { CodexSession } from "./codexSessions.js";
import type { NewAgentCommand } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ChatSessionBinding {
  chatId: string;
  chatType?: string;
  chatName?: string;
  sessionId: string;
  sessionTitle?: string;
  sessionCwd?: string;
  sessionSource?: string;
  sessionGitBranch?: string;
  sessionUpdatedAt?: number;
  createdAt: string;
  updatedAt: string;
}

export async function getChatSessionBinding(
  queuePath: string,
  chatId: string
): Promise<ChatSessionBinding | undefined> {
  await ensureChatSessionBindingSchema(queuePath);
  const rows = await sqliteJson<ChatSessionBindingRow>(
    queuePath,
    `select * from chat_session_bindings where chat_id = ${sqlValue(chatId)} limit 1;`
  );
  return rows[0] ? rowToBinding(rows[0]) : undefined;
}

export async function listChatSessionBindingsBySession(
  queuePath: string,
  sessionId: string,
  options: { excludeChatId?: string; limit?: number } = {}
): Promise<ChatSessionBinding[]> {
  await ensureChatSessionBindingSchema(queuePath);
  const filters = [
    `session_id = ${sqlValue(sessionId)}`,
    options.excludeChatId ? `chat_id <> ${sqlValue(options.excludeChatId)}` : undefined
  ].filter((item): item is string => Boolean(item));
  const limit = positiveInteger(options.limit) ? `limit ${options.limit}` : "";
  const rows = await sqliteJson<ChatSessionBindingRow>(
    queuePath,
    `select * from chat_session_bindings
     where ${filters.join(" and ")}
     order by updated_at desc
     ${limit};`
  );
  return rows.map(rowToBinding);
}

export async function upsertChatSessionBinding(
  queuePath: string,
  input: {
    chatId: string;
    chatType?: string;
    chatName?: string;
    session: CodexSession;
  }
): Promise<ChatSessionBinding> {
  await ensureChatSessionBindingSchema(queuePath);
  const now = new Date().toISOString();
  const sessionTitle = input.session.title || "(untitled)";
  const rows = await sqliteJson<ChatSessionBindingRow>(
    queuePath,
    `insert into chat_session_bindings (
       chat_id, chat_type, chat_name, session_id, session_title, session_cwd, session_source,
       session_git_branch, session_updated_at, created_at, updated_at
     ) values (
       ${sqlValue(input.chatId)}, ${sqlValue(input.chatType)}, ${sqlValue(input.chatName)},
       ${sqlValue(input.session.id)}, ${sqlValue(sessionTitle)}, ${sqlValue(input.session.cwd)},
       ${sqlValue(input.session.source)}, ${sqlValue(input.session.gitBranch)}, ${sqlNumber(input.session.updatedAt)},
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
       updated_at = excluded.updated_at
     returning *;`
  );
  return rowToBinding(rows[0]);
}

export async function deleteChatSessionBinding(
  queuePath: string,
  chatId: string
): Promise<ChatSessionBinding | undefined> {
  await ensureChatSessionBindingSchema(queuePath);
  const binding = await getChatSessionBinding(queuePath, chatId);
  if (!binding) return undefined;
  await sqliteExec(
    queuePath,
    `delete from chat_session_bindings where chat_id = ${sqlValue(chatId)};`
  );
  return binding;
}

export async function updateChatSessionBindingChatName(
  queuePath: string,
  chatId: string,
  chatName: string
): Promise<void> {
  await ensureChatSessionBindingSchema(queuePath);
  await sqliteExec(
    queuePath,
    `update chat_session_bindings
     set chat_name = ${sqlValue(chatName)}
     where chat_id = ${sqlValue(chatId)};`
  );
}

export function bindingToCommandSession(binding: ChatSessionBinding): Pick<
  NewAgentCommand,
  "sessionId" | "sessionTitle" | "sessionCwd" | "sessionSource" | "sessionGitBranch" | "sessionUpdatedAt"
> {
  return {
    sessionId: binding.sessionId,
    sessionTitle: binding.sessionTitle,
    sessionCwd: binding.sessionCwd,
    sessionSource: binding.sessionSource,
    sessionGitBranch: binding.sessionGitBranch,
    sessionUpdatedAt: binding.sessionUpdatedAt
  };
}

export function formatCurrentChatSession(binding: ChatSessionBinding | undefined): string {
  if (!binding) {
    return "当前群没有绑定 Codex 会话。请先发送 list-session 选择一个会话。";
  }

  return [
    "当前群绑定的 Codex 会话：",
    "",
    binding.chatName ? `chat: ${binding.chatName}` : undefined,
    `title: ${binding.sessionTitle || "(untitled)"}`,
    `id: ${binding.sessionId}`,
    binding.sessionCwd ? `cwd: ${binding.sessionCwd}` : undefined,
    binding.sessionSource ? `source: ${binding.sessionSource}` : undefined,
    binding.sessionGitBranch ? `branch: ${binding.sessionGitBranch}` : undefined,
    binding.sessionUpdatedAt ? `session updated: ${formatTime(binding.sessionUpdatedAt)}` : undefined,
    `binding updated: ${binding.updatedAt}`
  ].filter((line): line is string => line !== undefined).join("\n");
}

export async function ensureChatSessionBindingSchema(queuePath: string): Promise<void> {
  await mkdir(dirname(queuePath), { recursive: true });
  await sqliteExec(
    queuePath,
    `create table if not exists chat_session_bindings (
       chat_id text primary key,
       chat_type text,
       chat_name text,
       session_id text not null,
       session_title text,
       session_cwd text,
       session_source text,
       session_git_branch text,
       session_updated_at integer,
       created_at text not null,
       updated_at text not null
     );
     create index if not exists chat_session_bindings_session_idx
       on chat_session_bindings(session_id, updated_at);`
  );
  await ensureChatSessionBindingColumns(queuePath);
}

async function sqliteExec(queuePath: string, sql: string): Promise<void> {
  await execFileAsync("sqlite3", [queuePath, sql], { maxBuffer: 10 * 1024 * 1024 });
}

async function sqliteJson<T>(queuePath: string, sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync("sqlite3", ["-json", queuePath, sql], {
    maxBuffer: 10 * 1024 * 1024
  });
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) as T[] : [];
}

function rowToBinding(row: ChatSessionBindingRow): ChatSessionBinding {
  return {
    chatId: row.chat_id,
    chatType: row.chat_type ?? undefined,
    chatName: row.chat_name ?? undefined,
    sessionId: row.session_id,
    sessionTitle: row.session_title ?? undefined,
    sessionCwd: row.session_cwd ?? undefined,
    sessionSource: row.session_source ?? undefined,
    sessionGitBranch: row.session_git_branch ?? undefined,
    sessionUpdatedAt: row.session_updated_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function ensureChatSessionBindingColumns(queuePath: string): Promise<void> {
  const existing = new Set(
    (await sqliteJson<{ name: string }>(queuePath, "pragma table_info(chat_session_bindings);"))
      .map((row) => row.name)
  );
  const missing = [
    ["chat_name", "text"]
  ].filter(([name]) => !existing.has(name));
  for (const [name, type] of missing) {
    await sqliteExec(queuePath, `alter table chat_session_bindings add column ${name} ${type};`);
  }
}

function positiveInteger(value: number | undefined): boolean {
  return Number.isInteger(value) && value !== undefined && value > 0;
}

function sqlValue(value: string | undefined | null): string {
  if (value === undefined || value === null) return "null";
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNumber(value: number | undefined): string {
  return value === undefined ? "null" : String(value);
}

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

interface ChatSessionBindingRow {
  chat_id: string;
  chat_type: string | null;
  chat_name: string | null;
  session_id: string;
  session_title: string | null;
  session_cwd: string | null;
  session_source: string | null;
  session_git_branch: string | null;
  session_updated_at: number | null;
  created_at: string;
  updated_at: string;
}
