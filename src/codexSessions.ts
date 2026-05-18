import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { BridgeConfig, CodexCliConfig } from "./types.js";
import { ConfigError, saveConfigPatch } from "./config.js";

const execFileAsync = promisify(execFile);
const MAX_SUMMARY_ITEM_LENGTH = 240;
const MAX_SUMMARY_ITEMS = 3;
const DEFAULT_PROJECT_KIND: CodexProjectKind = "workspace";
const TEMPORARY_PROJECT_KIND: CodexProjectKind = "temporary";
const DEFAULT_SESSION_PAGE_SIZE = 10;
const DOCUMENTS_CODEX_ROOT = join(homedir(), "Documents", "Codex");

export type CodexProjectKind = "workspace" | "temporary";
export type CodexSessionListMode = "project" | "all" | "temp";

export interface CodexSession {
  id: string;
  title: string;
  cwd: string;
  source: string;
  updatedAt: number;
  createdAt: number;
  model?: string;
  gitBranch?: string;
  gitOriginUrl?: string;
  rolloutPath?: string;
  firstUserMessage?: string;
  projectId?: string;
  projectKind?: CodexProjectKind;
  projectRootPath?: string;
  projectDisplayName?: string;
  projectSecondaryName?: string;
  projectDisplayLabel?: string;
  projectLabelSource?: string;
  isTemporary?: boolean;
}

export interface CodexProject {
  id: string;
  kind: CodexProjectKind;
  rootPath: string;
  displayName: string;
  secondaryName: string;
  displayLabel: string;
  labelSource: string;
  isTemporary: boolean;
  sessionCount: number;
  latestUpdatedAt: number;
  latestSession: CodexSession;
  sessions: CodexSession[];
}

export type CodexSessionControlCommand =
  | { type: "help" }
  | { type: "features" }
  | { type: "feature-detail"; feature: string }
  | { type: "status"; full: boolean }
  | { type: "current-project" }
  | { type: "current-session" }
  | { type: "list-project"; page: number }
  | { type: "select-project"; selector: string }
  | { type: "new-session"; prompt?: string }
  | { type: "list-session"; mode: CodexSessionListMode; page: number }
  | { type: "unbind-project" }
  | { type: "unbind-session" }
  | { type: "select-session"; selector: string };

export interface CodexSessionControlResult {
  ackState: "done" | "failed";
  control: CodexSessionControlCommand["type"];
  title: string;
  summary: string;
}

export interface ListCodexSessionsOptions {
  limit?: number;
  offset?: number;
  all?: boolean;
  sqliteCommand?: string;
  includeTemporary?: boolean;
  temporaryOnly?: boolean;
  projectId?: string;
}

export interface ListCodexProjectsOptions {
  includeTemporary?: boolean;
  sqliteCommand?: string;
}

export function parseCodexSessionControlCommand(
  text: string
): CodexSessionControlCommand | undefined {
  const trimmed = text.trim();
  if (/^(?:help|帮助)$/i.test(trimmed)) {
    return { type: "help" };
  }

  if (/^(?:features?|menu|commands?|功能|功能面板|菜单|能力|能力列表)$/i.test(trimmed)) {
    return { type: "features" };
  }

  if (/^(?:model|模型)$/i.test(trimmed)) {
    return { type: "feature-detail", feature: "model" };
  }

  const featureDetailMatch = trimmed.match(/^(?:feature|功能)\s+(.+)$/i);
  if (featureDetailMatch?.[1]) {
    const feature = normalizeFeatureKey(featureDetailMatch[1]);
    if (feature) return { type: "feature-detail", feature };
  }

  if (/^(?:status-full|full-status|work-status-full|task-status-full|完整状态|状态详情|任务状态详情)$/i.test(trimmed)) {
    return { type: "status", full: true };
  }

  if (/^(?:status|work-status|task-status|current-status|session-status|状态|工作状态|任务状态|当前状态)$/i.test(trimmed)) {
    return { type: "status", full: false };
  }

  if (/^(?:current-session|session-current)$/i.test(trimmed)) {
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

  const newSessionMatch = trimmed.match(
    /^(?:new-session|create-session|start-session|new-chat|新会话|新建会话|开启新会话)(?:\s+([\s\S]+))?$/i
  );
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
    if (control.type === "help") {
      return {
        ackState: "done",
        control: "help",
        title: "Codex session help",
        summary: formatGlobalHelp()
      };
    }

    if (control.type === "features") {
      return {
        ackState: "done",
        control: "features",
        title: "Codex feature panel",
        summary: formatGlobalFeaturePanel()
      };
    }

    if (control.type === "feature-detail") {
      return {
        ackState: "done",
        control: "feature-detail",
        title: `Codex feature: ${control.feature}`,
        summary: formatGlobalFeatureDetail(control.feature)
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

    if (control.type === "status") {
      return {
        ackState: "failed",
        control: "status",
        title: "Current work status requires chat context",
        summary: "status 需要当前飞书群上下文，请在群里发送该命令，由 listener 直接处理。"
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
      await saveConfigPatch(
        {
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
        },
        configPath
      );
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
      control: control.type,
      title: control.type === "select-project" ? "Codex project selected" : "Codex session selected",
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
  options: ListCodexSessionsOptions = {}
): Promise<CodexSession[]> {
  const dbPath = config.stateDbPath;
  if (!dbPath) {
    throw new ConfigError("codex.stateDbPath is required for list-session");
  }

  const needsPostFiltering = Boolean(
    options.projectId ||
      options.temporaryOnly ||
      options.includeTemporary === false ||
      options.offset
  );
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
  } else if (options.includeTemporary === false) {
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

export async function listCodexProjects(
  config: CodexCliConfig,
  options: ListCodexProjectsOptions = {}
): Promise<CodexProject[]> {
  const sessions = await listCodexSessions(config, {
    all: true,
    includeTemporary: options.includeTemporary ?? false,
    sqliteCommand: options.sqliteCommand
  });
  const projects = new Map<string, CodexProject>();
  for (const session of sessions) {
    if (!session.projectId || !session.projectRootPath) continue;
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

  return Array.from(projects.values()).sort((a, b) => (
    b.latestUpdatedAt - a.latestUpdatedAt || a.displayLabel.localeCompare(b.displayLabel)
  ));
}

export async function findCodexProject(
  config: CodexCliConfig,
  selector: string,
  options: ListCodexProjectsOptions = {}
): Promise<CodexProject | undefined> {
  const projects = await listCodexProjects(config, options);
  const normalized = selector.trim();
  const index = Number(normalized);
  if (Number.isInteger(index) && index >= 1) {
    return projects[index - 1];
  }
  return projects.find((project) => (
    project.id === normalized ||
    project.id.startsWith(normalized) ||
    project.displayLabel === normalized
  ));
}

export async function findCodexSession(
  config: CodexCliConfig,
  selector: string,
  options: ListCodexSessionsOptions = {}
): Promise<CodexSession | undefined> {
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

export function buildCodexProjectId(kind: CodexProjectKind | string, realRootPath: string): string {
  return `proj_${createHash("sha256")
    .update(`fab-project-v1:${kind}:${realRootPath}`)
    .digest("hex")
    .slice(0, 16)}`;
}

export function formatProjectDisplayLabel(primaryName: string, secondaryName: string): string {
  return primaryName === secondaryName ? primaryName : `${primaryName}  ${secondaryName}`;
}

export function formatProjectList(projects: CodexProject[], limit: number): string {
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

export function formatSessionList(sessions: CodexSession[], limit: number): string {
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
  lines.push("只解绑 active session：unbind-session");
  lines.push("解绑当前群 project：unbind-project");
  return lines.join("\n");
}

export function formatSelectedSession(session: CodexSession): string {
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
  ].filter((line): line is string => line !== undefined).join("\n");
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
        session.projectDisplayLabel ? `project: ${session.projectDisplayLabel}` : undefined,
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
      "后续普通指令会使用 Codex CLI 解析到的最新会话。建议发送 list-project 明确选择。"
    ].join("\n");
  }

  return "当前没有绑定 Codex 会话。请先发送 list-project 选择一个 project。";
}

async function listSessionsForMode(
  config: CodexCliConfig,
  mode: CodexSessionListMode
): Promise<CodexSession[]> {
  if (mode === "temp") {
    return listCodexSessions(config, { all: true, temporaryOnly: true });
  }
  return listCodexSessions(config, { all: true, includeTemporary: true });
}

async function queryCodexSessionRows(
  dbPath: string,
  options: { limit?: number; sqliteCommand?: string }
): Promise<CodexSession[]> {
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

async function getThreadColumns(dbPath: string, sqliteCommand: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync(sqliteCommand, ["-json", dbPath, "pragma table_info(threads);"]);
  const rows = parseJsonArray(stdout, "sqlite3 threads schema") as Array<{ name?: unknown }>;
  return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string"));
}

function columnExpression(columns: Set<string>, column: string, alias: string): string {
  return columns.has(column) ? `${column} as ${alias}` : `null as ${alias}`;
}

async function decorateSessions(
  sessions: CodexSession[],
  config: CodexCliConfig
): Promise<CodexSession[]> {
  const globalState = await loadCodexGlobalState(config.globalStatePath);
  const secondaryNameCache = new Map<string, Promise<string>>();
  return Promise.all(sessions.map((session) => (
    decorateSession(session, globalState, secondaryNameCache)
  )));
}

async function decorateSession(
  session: CodexSession,
  globalState: CodexGlobalState,
  secondaryNameCache: Map<string, Promise<string>>
): Promise<CodexSession> {
  const realRootPath = await resolveRealPath(session.cwd);
  const label = globalState.workspaceLabels.get(realRootPath) ??
    globalState.workspaceLabels.get(resolve(session.cwd));
  const hasWorkspaceLabel = Boolean(label);
  const isTemporary = globalState.projectlessThreadIds.has(session.id) ||
    (!hasWorkspaceLabel && isPathInside(realRootPath, DOCUMENTS_CODEX_ROOT));
  const projectKind = isTemporary ? TEMPORARY_PROJECT_KIND : DEFAULT_PROJECT_KIND;
  const projectId = buildCodexProjectId(projectKind, realRootPath);
  const secondaryName = await cachedSecondaryName(
    session,
    realRootPath,
    secondaryNameCache
  );
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

async function cachedSecondaryName(
  session: CodexSession,
  realRootPath: string,
  cache: Map<string, Promise<string>>
): Promise<string> {
  const key = `${session.gitOriginUrl ?? ""}\0${realRootPath}`;
  let value = cache.get(key);
  if (!value) {
    value = resolveSecondaryName(session.cwd, realRootPath, session.gitOriginUrl);
    cache.set(key, value);
  }
  return value;
}

async function resolveSecondaryName(
  cwd: string,
  realRootPath: string,
  gitOriginUrl: string | undefined
): Promise<string> {
  const originName = gitOriginUrl ? repoNameFromGitOrigin(gitOriginUrl) : undefined;
  if (originName) return originName;

  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    const gitRoot = stdout.trim();
    if (gitRoot) return basename(gitRoot) || basename(realRootPath) || realRootPath;
  } catch {
    // Missing git context is fine; Codex cwd remains the project root.
  }
  return basename(realRootPath) || realRootPath;
}

function repoNameFromGitOrigin(origin: string): string | undefined {
  const trimmed = origin.trim().replace(/\.git$/i, "");
  if (!trimmed) return undefined;
  const normalized = trimmed.replaceAll("\\", "/");
  const separators = [normalized.lastIndexOf("/"), normalized.lastIndexOf(":")];
  const index = Math.max(...separators);
  const name = index >= 0 ? normalized.slice(index + 1) : normalized;
  return name || undefined;
}

async function resolveRealPath(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return resolve(value);
  }
}

async function loadCodexGlobalState(statePath: string | undefined): Promise<CodexGlobalState> {
  const resolvedStatePath = statePath ?? join(homedir(), ".codex", ".codex-global-state.json");
  let raw: string;
  try {
    raw = await readFile(resolvedStatePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        workspaceLabels: new Map(),
        projectlessThreadIds: new Set()
      };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${resolvedStatePath}: ${(error as Error).message}`);
  }
  const object = isRecord(parsed) ? parsed : {};
  const labels = isRecord(object["electron-workspace-root-labels"])
    ? object["electron-workspace-root-labels"] as Record<string, unknown>
    : {};
  const workspaceLabels = new Map<string, string>();
  for (const [path, value] of Object.entries(labels)) {
    if (typeof value !== "string" || value.length === 0) continue;
    workspaceLabels.set(resolve(path), value);
    try {
      workspaceLabels.set(await realpath(path), value);
    } catch {
      // The label can point at a removed worktree; resolved path is still useful.
    }
  }

  const projectlessThreadIds = new Set<string>();
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

function isPathInside(childPath: string, parentPath: string): boolean {
  const normalizedChild = resolve(childPath);
  const normalizedParent = resolve(parentPath);
  const rel = relative(normalizedParent, normalizedChild);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function parseSessionRows(stdout: string): CodexSession[] {
  return parseJsonArray(stdout, "sqlite3 session query")
    .map((row, index) => parseSessionRow(row, index));
}

function parseJsonArray(stdout: string, label: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) {
    throw new ConfigError(`${label} returned non-array JSON`);
  }
  return parsed;
}

function parseSessionRow(row: unknown, index: number): CodexSession {
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
  if (!isRecord(entry)) return undefined;
  if (entry.type !== "response_item") return undefined;
  const payload = entry.payload;
  if (!isRecord(payload)) return undefined;
  if (payload.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) {
    return undefined;
  }
  const text = extractMessageText(payload.content);
  return text ? { role: payload.role, text } : undefined;
}

function extractMessageText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (typeof item.text === "string") {
      parts.push(item.text);
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

function formatGlobalHelp(): string {
  return [
    "可用指令：",
    "",
    "help / 帮助：查看帮助。",
    "features / 功能：用卡片查看常用功能入口。",
    "status：用精简卡片查看当前工作状态。",
    "status-full：用完整卡片查看 runtime 和任务队列明细。",
    "list-project [页码]：列出可绑定 project。",
    "current-project：查看当前群绑定的 project。",
    "bind-project <序号|projectId>：绑定 project。",
    "new-session [初始说明]：在当前 project 下开启并绑定一个新会话。",
    "list-session：列出当前 project 下会话。",
    "switch-session <序号|sessionId>：切换当前 project 下会话。",
    "list-session --all [页码]：全局会话分页。",
    "list-session --temp [页码]：临时对话分页。",
    "current-session：查看当前绑定。",
    "unbind-session：只解除当前群 active session，保留 project 绑定。",
    "unbind-project：解除当前群 project 绑定，并清空 active session。",
    "",
    `分页默认每页 ${DEFAULT_SESSION_PAGE_SIZE} 个。临时对话默认不进入 project 绑定。`
  ].join("\n");
}

function formatGlobalFeaturePanel(): string {
  return [
    "功能面板：",
    "",
    "触发方式：在飞书群里发送 功能 或 features。",
    "主卡会展示按钮式功能入口，不混入 help 里的项目/会话管理按钮。",
    "",
    "按钮：MCP、个性、代码审查、侧边、压缩、反馈、宠物、快速、推理模式、模型、派生。"
  ].join("\n");
}

function formatGlobalFeatureDetail(feature: string): string {
  const details: Record<string, string> = {
    mcp: "MCP：飞书卡片会读取 codex mcp list 并展示当前 MCP server 列表；CLI 也支持 get|add|remove|login|logout。",
    personality: "个性：feature flag personality，可通过 profile/config 承载。",
    review: "代码审查：codex review --uncommitted / --base <branch> / --commit <sha>；飞书里可发 cr 最近提交 或 代码审查 未提交改动 进入 Agent 队列。",
    side: "侧边：codex fork --last [prompt]。",
    compression: "压缩：enable_request_compression 是稳定 feature flag；当前 codex --help 未暴露立即压缩当前会话的独立子命令。",
    feedback: "反馈：当前 codex --help 未暴露稳定独立子命令。",
    pet: "宠物：本机 CLI help / feature flags 未看到公开入口，暂按桌面专属处理。",
    fast: "快速：--enable fast_mode / --disable fast_mode。",
    reasoning: "推理模式：codex -c model_reasoning_effort=\"xhigh\" 或配置 model_reasoning_effort。",
    model: "模型：codex -m <model> 或配置 model。",
    fork: "派生：codex fork <sessionId> [prompt]，也支持 --last、-m <model>、-p <profile>。"
  };
  return [
    details[feature] ?? "未知功能。",
    "",
    "校验依据：codex --help、codex mcp --help、codex review --help、codex fork --help、codex features list。"
  ].join("\n");
}

function normalizeFeatureKey(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, string> = {
    mcp: "mcp",
    personality: "personality",
    "个性": "personality",
    review: "review",
    cr: "review",
    "代码审查": "review",
    side: "side",
    "侧边": "side",
    compression: "compression",
    compress: "compression",
    "压缩": "compression",
    feedback: "feedback",
    "反馈": "feedback",
    pet: "pet",
    "宠物": "pet",
    fast: "fast",
    "快速": "fast",
    reasoning: "reasoning",
    "推理": "reasoning",
    "推理模式": "reasoning",
    model: "model",
    "模型": "model",
    fork: "fork",
    "派生": "fork"
  };
  return aliases[normalized];
}

function parsePage(value: string | undefined): number {
  if (!value) return 1;
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : 1;
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
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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

interface CodexGlobalState {
  workspaceLabels: Map<string, string>;
  projectlessThreadIds: Set<string>;
}
