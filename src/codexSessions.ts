import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { BridgeConfig, CodexCliConfig } from "./types.js";
import { ConfigError, saveConfigPatch } from "./config.js";

const execFileAsync = promisify(execFile);
const MAX_SUMMARY_ITEM_LENGTH = 240;
const MAX_SUMMARY_ITEMS = 3;

export interface CodexSession {
  id: string;
  title: string;
  cwd: string;
  source: string;
  updatedAt: number;
  createdAt: number;
  model?: string;
  gitBranch?: string;
  rolloutPath?: string;
  firstUserMessage?: string;
}

export type CodexSessionControlCommand =
  | { type: "current-session" }
  | { type: "list-session" }
  | { type: "select-session"; selector: string };

export interface CodexSessionControlResult {
  ackState: "done" | "failed";
  control: "current-session" | "list-session" | "select-session";
  title: string;
  summary: string;
}

export function parseCodexSessionControlCommand(
  text: string
): CodexSessionControlCommand | undefined {
  const trimmed = text.trim();
  if (/^(?:current-session|session-status|session-current)$/i.test(trimmed)) {
    return { type: "current-session" };
  }

  const listMatch = trimmed.match(/^list-sessions?(?:\s+(.+))?$/i);
  if (listMatch) {
    const selector = listMatch[1]?.trim();
    return selector ? { type: "select-session", selector } : { type: "list-session" };
  }

  const selectMatch = trimmed.match(
    /^(?:use-session|select-session|switch-session|attach-session)\s+(.+)$/i
  );
  if (selectMatch?.[1]) {
    return { type: "select-session", selector: selectMatch[1].trim() };
  }

  return undefined;
}

export async function handleCodexSessionControlCommand(
  control: CodexSessionControlCommand,
  config: BridgeConfig,
  configPath: string
): Promise<CodexSessionControlResult> {
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

    await saveConfigPatch(
      {
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
      },
      configPath
    );
    return {
      ackState: "done",
      control: "select-session",
      title: "Codex session selected",
      summary: await formatSelectedSessionWithSummary(session)
    };
  } catch (error) {
    return {
      ackState: "failed",
      control: control.type,
      title: "Codex session command failed",
      summary: formatError(error)
    };
  }
}

export async function listCodexSessions(
  config: CodexCliConfig,
  options: { limit?: number; sqliteCommand?: string } = {}
): Promise<CodexSession[]> {
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

export async function findCodexSession(
  config: CodexCliConfig,
  selector: string,
  options: { sqliteCommand?: string } = {}
): Promise<CodexSession | undefined> {
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

export function formatSessionList(sessions: CodexSession[], limit: number): string {
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

export function formatSelectedSession(session: CodexSession): string {
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

export async function formatSelectedSessionWithSummary(session: CodexSession): Promise<string> {
  const summary = await summarizeCodexSession(session);
  if (!summary) {
    return `${formatSelectedSession(session)}\n\n会话摘要：\n未找到可同步的本地会话内容。`;
  }
  return `${formatSelectedSession(session)}\n\n会话摘要：\n${summary}`;
}

export async function formatCurrentSession(config: CodexCliConfig): Promise<string> {
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
      ].filter((line): line is string => line !== undefined).join("\n");
    }

    return [
      "当前 Codex 会话已配置，但最近会话列表中没有找到对应记录：",
      "",
      `enabled: ${config.enabled}`,
      `id: ${config.sessionId}`,
      config.cwd ? `cwd: ${config.cwd}` : undefined,
      "",
      "可以发送 list-session 重新选择一个可用会话。"
    ].filter((line): line is string => line !== undefined).join("\n");
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

function parseSessionRows(stdout: string): CodexSession[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    throw new ConfigError("sqlite3 session query returned non-array JSON");
  }
  return parsed.map((row, index) => parseSessionRow(row, index));
}

function parseSessionRow(row: unknown, index: number): CodexSession {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new ConfigError(`sqlite3 session row ${index} must be an object`);
  }
  const value = row as Record<string, unknown>;
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

async function summarizeCodexSession(session: CodexSession): Promise<string | undefined> {
  const messages = await readRolloutMessages(session.rolloutPath);
  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const firstUser = cleanUserSummaryText(session.firstUserMessage || userMessages[0]?.text);
  const recentUsers = userMessages
    .slice(-MAX_SUMMARY_ITEMS)
    .map((message) => cleanUserSummaryText(message.text))
    .filter((text): text is string => Boolean(text));
  const recentAssistants = assistantMessages
    .slice(-2)
    .map((message) => cleanSummaryText(message.text))
    .filter((text): text is string => Boolean(text));

  const lines: string[] = [];
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

async function readRolloutMessages(
  rolloutPath: string | undefined
): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
  if (!rolloutPath) return [];
  let content: string;
  try {
    content = await readFile(rolloutPath, "utf8");
  } catch {
    return [];
  }

  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const message = extractRolloutMessage(parsed);
    if (message) messages.push(message);
  }
  return messages;
}

function extractRolloutMessage(
  entry: unknown
): { role: "user" | "assistant"; text: string } | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const object = entry as Record<string, unknown>;
  if (object.type !== "response_item") return undefined;
  const payload = object.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const value = payload as Record<string, unknown>;
  if (value.type !== "message" || (value.role !== "user" && value.role !== "assistant")) {
    return undefined;
  }
  const text = extractMessageText(value.content);
  return text ? { role: value.role, text } : undefined;
}

function extractMessageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    if (typeof value.text === "string") {
      parts.push(value.text);
    }
  }
  return parts.join("\n").trim() || undefined;
}

function cleanSummaryText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_SUMMARY_ITEM_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_SUMMARY_ITEM_LENGTH - 1)}…`;
}

function cleanUserSummaryText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("<environment_context>")) return undefined;
  const feishuInstructionMarker = "用户原始指令：";
  const markerIndex = trimmed.indexOf(feishuInstructionMarker);
  if (markerIndex >= 0) {
    return cleanSummaryText(trimmed.slice(markerIndex + feishuInstructionMarker.length));
  }
  return cleanSummaryText(trimmed);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${label} must be a positive integer`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(`${label} must be a string`);
  }
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${label} must be a number`);
  }
  return value;
}

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function formatError(error: unknown): string {
  if (error instanceof ConfigError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
