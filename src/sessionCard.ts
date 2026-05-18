import type { CodexProject, CodexSession, CodexSessionListMode } from "./codexSessions.js";

const MAX_TITLE_LENGTH = 80;
const MAX_CWD_LENGTH = 120;
const MAX_PROJECT_LENGTH = 100;
const BRIDGE_ACTION_OWNER = "feishu-agent-bridge";

interface CodexFeatureActionDefinition {
  label: string;
  task: string;
  primary?: boolean;
}

const CODEX_FEATURE_DETAILS = {
  mcp: {
    label: "MCP",
    status: "CLI supported",
    detail: "管理 Codex MCP server。CLI 支持 `codex mcp list|get|add|remove|login|logout`。",
    actions: []
  },
  personality: {
    label: "个性",
    status: "Feature flag",
    detail: "本机 `codex features list` 已暴露 `personality`，可通过 profile/config 承载。",
    actions: [
      {
        label: "检查配置",
        task: "检查当前工作区的 Codex personality 功能：读取本机 Codex feature/config 状态，说明是否可用以及当前配置方式。",
        primary: true
      }
    ]
  },
  review: {
    label: "代码审查",
    status: "CLI supported",
    detail: "CLI 支持 `codex review --uncommitted`、`--base <branch>`、`--commit <sha>`；飞书里可发 `cr 最近提交` 或 `代码审查 未提交改动` 进入 Agent 队列。",
    actions: [
      {
        label: "审查未提交",
        task: "请对当前工作区的未提交改动做 code review，优先指出风险、回归和测试缺口。",
        primary: true
      },
      {
        label: "审查最近提交",
        task: "请 code review 最近一次提交，优先指出风险、回归和测试缺口。"
      }
    ]
  },
  side: {
    label: "侧边",
    status: "CLI supported",
    detail: "可用 `codex fork --last [prompt]` 从最近会话派生侧边对话。",
    actions: [
      {
        label: "派生侧边",
        task: "请尝试使用本机 Codex CLI 为当前会话派生一个 side conversation，报告派生结果和后续使用方式。",
        primary: true
      }
    ]
  },
  compression: {
    label: "压缩",
    status: "Feature flag",
    detail: "`enable_request_compression` 是稳定 feature flag；当前 `codex --help` 未暴露“立即压缩当前会话”的独立子命令。",
    actions: [
      {
        label: "检查压缩",
        task: "检查当前 Codex 请求压缩能力：读取 feature/config 状态，说明是否启用 enable_request_compression，以及是否需要调整。",
        primary: true
      }
    ]
  },
  feedback: {
    label: "反馈",
    status: "No stable CLI command",
    detail: "本机 `codex --help` 未暴露稳定独立子命令。",
    actions: [
      {
        label: "整理反馈",
        task: "整理一份针对当前任务或插件体验的反馈草稿，包含问题、影响和建议改进。",
        primary: true
      }
    ]
  },
  pet: {
    label: "宠物",
    status: "Desktop only",
    detail: "本机 CLI help / feature flags 未看到公开入口，暂按桌面专属处理。",
    actions: [
      {
        label: "检查入口",
        task: "检查当前本机 Codex 是否暴露宠物功能入口，结合 CLI/help/config 说明能否在飞书侧触发。",
        primary: true
      }
    ]
  },
  fast: {
    label: "快速",
    status: "CLI supported",
    detail: "CLI 支持 `--enable fast_mode` / `--disable fast_mode`。",
    actions: [
      {
        label: "检查 fast",
        task: "检查当前 Codex fast_mode 支持和配置状态，说明如何为后续任务开启或关闭。",
        primary: true
      }
    ]
  },
  reasoning: {
    label: "推理模式",
    status: "CLI supported",
    detail: "CLI 支持 `codex -c model_reasoning_effort=\"xhigh\"`，也可写入配置 `model_reasoning_effort`。",
    actions: [
      {
        label: "检查配置",
        task: "检查当前 Codex 推理模式配置，说明本 session 当前设置、可用取值，以及如何为后续任务切换。",
        primary: true
      },
      {
        label: "建议模式",
        task: "结合当前任务复杂度，建议后续使用的 Codex reasoning effort，并说明理由。"
      }
    ]
  },
  model: {
    label: "模型",
    status: "CLI supported",
    detail: "CLI 支持 `codex -m <model>`，也可配置 `model`。",
    actions: [
      {
        label: "检查模型",
        task: "检查当前 Codex 模型配置和本机可用模型入口，给出当前 session 的建议模型。",
        primary: true
      }
    ]
  },
  fork: {
    label: "派生",
    status: "CLI supported",
    detail: "CLI 支持 `codex fork <sessionId> [prompt]`，也支持 `--last`、`-m <model>`、`-p <profile>`。",
    actions: [
      {
        label: "派生当前会话",
        task: "请尝试使用 codex fork --last 派生当前会话，报告新会话信息和使用方式。",
        primary: true
      }
    ]
  }
} as const satisfies Record<string, {
  label: string;
  status: string;
  detail: string;
  actions: readonly CodexFeatureActionDefinition[];
}>;
type CodexFeatureKey = keyof typeof CODEX_FEATURE_DETAILS;
const CODEX_FEATURE_ORDER: CodexFeatureKey[] = [
  "mcp",
  "personality",
  "review",
  "side",
  "compression",
  "feedback",
  "pet",
  "fast",
  "reasoning",
  "model",
  "fork"
];

export type CodexCardAction =
  | { type: "select-session"; sessionId: string }
  | { type: "bind-project"; projectId: string }
  | { type: "list-project-page"; page: number }
  | { type: "list-session-page"; mode: CodexSessionListMode; page: number; projectId?: string }
  | { type: "run-command"; command: string }
  | { type: "enqueue-command"; command: string };

export interface CodexMcpServerSummary {
  name: string;
  transport: "stdio" | "http";
  status: string;
  auth: string;
  command?: string;
  args?: string;
  env?: string;
  cwd?: string;
  url?: string;
  bearerTokenEnvVar?: string;
}

export function buildCodexSessionListCard(
  sessions: CodexSession[],
  limit: number,
  options: {
    title?: string;
    notice?: string;
    projectLabel?: string;
    mode?: CodexSessionListMode;
    pageInfo?: PageInfo;
    projectId?: string;
  } = {}
): Record<string, unknown> {
  const visible = sessions.slice(0, limit);
  const elements: Array<Record<string, unknown>> = [];

  if (options.notice) {
    elements.push(markdownBlock(options.notice));
    elements.push({ tag: "hr" });
  }

  if (options.projectLabel) {
    elements.push(markdownBlock(`**Project**\n${escapeMd(options.projectLabel)}`));
    elements.push({ tag: "hr" });
  }

  if (visible.length === 0) {
    elements.push(markdownBlock("没有找到可用的 Codex 会话。"));
  } else {
    for (const [index, session] of visible.entries()) {
      elements.push(markdownBlock(formatSession(session, index + 1)));
      elements.push(sessionButtonRow(session.id, index + 1, index === 0));
      if (index < visible.length - 1) {
        elements.push({ tag: "hr" });
      }
    }
  }

  const pageRow = paginationRow(options.pageInfo, options.mode, options.projectId);
  if (pageRow) {
    elements.push({ tag: "hr" });
    elements.push(pageRow);
  }

  elements.push(markdownBlock(sessionFooter(options.mode)));

  return card(options.title ?? "选择要介入的 Codex 会话", "blue", elements);
}

export function buildCodexProjectListCard(
  projects: CodexProject[],
  limit: number,
  options: {
    title?: string;
    notice?: string;
    pageInfo?: PageInfo;
  } = {}
): Record<string, unknown> {
  const visible = projects.slice(0, limit);
  const elements: Array<Record<string, unknown>> = [];

  if (options.notice) {
    elements.push(markdownBlock(options.notice));
    elements.push({ tag: "hr" });
  }

  if (visible.length === 0) {
    elements.push(markdownBlock("没有找到可绑定的 Codex project。临时对话默认隐藏，可发送 `list-session --temp` 查看。"));
  } else {
    const startIndex = options.pageInfo
      ? (options.pageInfo.page - 1) * options.pageInfo.pageSize
      : 0;
    for (const [index, project] of visible.entries()) {
      const displayIndex = startIndex + index + 1;
      elements.push(markdownBlock(formatProject(project, displayIndex)));
      elements.push(projectButtonRow(project.id, displayIndex, index === 0));
      if (index < visible.length - 1) {
        elements.push({ tag: "hr" });
      }
    }
  }

  const pageRow = projectPaginationRow(options.pageInfo);
  if (pageRow) {
    elements.push({ tag: "hr" });
    elements.push(pageRow);
  }

  elements.push(markdownBlock("_按钮不可用时，可发送 `list-project <页码>`，或 `bind-project <序号|projectId>` / `switch-project <序号|projectId>`。_"));
  return card(options.title ?? "选择要绑定的 Codex project", "blue", elements);
}

export function buildCodexHelpCard(options: {
  projectLabel?: string;
  sessionTitle?: string;
  sessionId?: string;
  isTemporary?: boolean;
} = {}): Record<string, unknown> {
  const elements = [
    markdownBlock(`**当前绑定**\n${escapeMd(formatFeatureBindingSummary(options))}`),
    { tag: "hr" },
    markdownBlock("**常用命令**"),
    ...helpCommandRows([
      {
        command: "help / 帮助",
        description: "查看这张帮助卡",
        buttonCommand: "help"
      },
      {
        command: "features / 功能",
        description: "用卡片查看常用功能入口",
        buttonCommand: "features"
      },
      {
        command: "status",
        description: "精简卡片查看当前工作状态",
        buttonCommand: "status"
      },
      {
        command: "status-full",
        description: "完整卡片查看队列和 runtime 明细",
        buttonCommand: "status-full"
      },
      {
        command: "list-project",
        description: "列出可绑定 project",
        buttonCommand: "list-project"
      },
      {
        command: "current-project",
        description: "查看当前群绑定的 project",
        buttonCommand: "current-project"
      },
      {
        command: "bind-project <序号|projectId>",
        description: "绑定 project"
      },
      {
        command: "new-session [初始说明]",
        description: "在当前 project 下开启新会话；按钮不带初始说明",
        buttonCommand: "new-session"
      },
      {
        command: "list-session",
        description: "列出当前 project 下的会话",
        buttonCommand: "list-session"
      },
      {
        command: "switch-session <序号|sessionId>",
        description: "在当前 project 内切换会话"
      },
      {
        command: "current-session",
        description: "查看当前 active session",
        buttonCommand: "current-session"
      },
      {
        command: "unbind-project",
        description: "解绑 project",
        buttonCommand: "unbind-project"
      },
      {
        command: "unbind-session",
        description: "解绑 active session",
        buttonCommand: "unbind-session"
      }
    ]),
    markdownBlock("**解绑说明**\n`unbind-session` 保留 project，只清 active session；`unbind-project` 清 project 和 active session。"),
    { tag: "hr" },
    markdownBlock("**全局和临时会话**"),
    ...helpCommandRows([
      {
        command: "list-session --all [页码]",
        description: "全局会话分页，默认每页 10 个；按钮打开第 1 页",
        buttonCommand: "list-session --all"
      },
      {
        command: "list-session --temp [页码]",
        description: "只看临时对话；按钮打开第 1 页",
        buttonCommand: "list-session --temp"
      }
    ]),
    markdownBlock("临时对话默认不展示在 project 列表里，也不会作为普通 project 推荐绑定。")
  ];
  return card("Feishu Agent Bridge 帮助", "blue", elements);
}

export function buildCodexFeatureCard(options: {
  projectLabel?: string;
  sessionTitle?: string;
  sessionId?: string;
  isTemporary?: boolean;
  model?: string;
  profile?: string;
  sandbox?: string;
} = {}): Record<string, unknown> {
  const runtimeLines = [
    `Model: ${options.model || "(未配置，使用 Codex 默认)"}`,
    `Profile: ${options.profile || "(未配置)"}`,
    `Sandbox: ${options.sandbox || "(未配置)"}`
  ].join("\n");

  const elements = [
    markdownBlock(`**当前绑定**\n${escapeMd(formatFeatureBindingSummary(options))}`),
    { tag: "hr" },
    markdownBlock(`**运行配置**\n${escapeMd(runtimeLines)}`),
    { tag: "hr" },
    markdownBlock("**功能入口**\n点击按钮查看对应能力的 CLI 支持情况和飞书触发方式。"),
    { tag: "hr" },
    ...featureButtonRows(CODEX_FEATURE_ORDER)
  ];
  return card("Codex 功能面板", "blue", elements);
}

export function buildCodexFeatureDetailCard(feature: string, options: {
  projectLabel?: string;
  sessionTitle?: string;
  sessionId?: string;
  isTemporary?: boolean;
} = {}): Record<string, unknown> {
  const key = normalizeCodexFeatureKey(feature) ?? "mcp";
  const detail = CODEX_FEATURE_DETAILS[key];
  const elements: Array<Record<string, unknown>> = [
    markdownBlock(`**当前绑定**\n${escapeMd(formatFeatureBindingSummary(options))}`),
    { tag: "hr" },
    markdownBlock([
      `**${detail.label}**`,
      `状态：${detail.status}`,
      "",
      detail.detail,
      "",
      "校验依据：`codex --help`、`codex features list` 以及相关子命令 help。"
    ].join("\n"))
  ];
  if (detail.actions.length > 0) {
    elements.push({ tag: "hr" });
    elements.push(markdownBlock("**可执行操作**\n点击按钮会把对应任务加入当前群绑定的 Codex session 队列。"));
    elements.push(...featureActionRows(detail.actions));
  }
  elements.push({ tag: "hr" });
  elements.push(singleButtonRow({
    name: "feature_back",
    type: "default",
    content: "返回功能面板",
    value: buildRunCommandActionValue("features")
  }));
  return card(`Codex 功能：${detail.label}`, "blue", elements);
}

export function buildCodexMcpListCard(options: {
  projectLabel?: string;
  sessionTitle?: string;
  sessionId?: string;
  isTemporary?: boolean;
  servers: CodexMcpServerSummary[];
  command?: string;
  error?: string;
}): Record<string, unknown> {
  const enabledCount = options.servers.filter((server) => server.status.toLowerCase() === "enabled").length;
  const disabledCount = options.servers.filter((server) => server.status.toLowerCase() === "disabled").length;
  const summaryLines = [
    `Servers: ${options.servers.length}`,
    `Enabled: ${enabledCount}`,
    disabledCount > 0 ? `Disabled: ${disabledCount}` : undefined,
    options.command ? `Source: ${options.command}` : "Source: codex mcp list"
  ].filter((line): line is string => Boolean(line));

  const elements: Array<Record<string, unknown>> = [
    markdownBlock(`**当前绑定**\n${escapeMd(formatFeatureBindingSummary(options))}`),
    { tag: "hr" },
    markdownBlock(`**MCP server 列表**\n${escapeMd(summaryLines.join("\n"))}`)
  ];

  if (options.error) {
    elements.push({ tag: "hr" });
    elements.push(markdownBlock(`**读取失败**\n${escapeMd(truncate(options.error, 300))}`));
  } else if (options.servers.length === 0) {
    elements.push({ tag: "hr" });
    elements.push(markdownBlock("没有从 `codex mcp list` 读取到 MCP server。"));
  } else {
    for (const server of options.servers) {
      elements.push({ tag: "hr" });
      elements.push(markdownBlock(formatMcpServer(server)));
    }
  }

  return card("Codex 功能：MCP", "blue", elements);
}

function normalizeCodexFeatureKey(value: string): CodexFeatureKey | undefined {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, CodexFeatureKey> = {
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

export function buildSelectSessionActionValue(sessionId: string): Record<string, string> {
  return {
    bridge: BRIDGE_ACTION_OWNER,
    action: "select_codex_session",
    sessionId
  };
}

export function buildBindProjectActionValue(projectId: string): Record<string, string> {
  return {
    bridge: BRIDGE_ACTION_OWNER,
    action: "bind_codex_project",
    projectId
  };
}

export function buildListSessionPageActionValue(
  mode: CodexSessionListMode,
  page: number,
  projectId?: string
): Record<string, string | number | undefined> {
  return {
    bridge: BRIDGE_ACTION_OWNER,
    action: "list_codex_sessions",
    mode,
    page,
    projectId
  };
}

export function buildListProjectPageActionValue(page: number): Record<string, string | number> {
  return {
    bridge: BRIDGE_ACTION_OWNER,
    action: "list_codex_projects",
    page
  };
}

export function buildRunCommandActionValue(command: string): Record<string, string> {
  return {
    bridge: BRIDGE_ACTION_OWNER,
    action: "run_codex_command",
    command
  };
}

export function buildEnqueueAgentCommandActionValue(command: string): Record<string, string> {
  return {
    bridge: BRIDGE_ACTION_OWNER,
    action: "enqueue_agent_command",
    command
  };
}

export function parseCodexCardActionValue(value: unknown): CodexCardAction | undefined {
  const object = parseActionObject(value);
  if (!object || object.bridge !== BRIDGE_ACTION_OWNER) return undefined;

  if (object.action === "select_codex_session" && typeof object.sessionId === "string" && object.sessionId) {
    return { type: "select-session", sessionId: object.sessionId };
  }

  if (object.action === "bind_codex_project" && typeof object.projectId === "string" && object.projectId) {
    return { type: "bind-project", projectId: object.projectId };
  }

  if (object.action === "list_codex_sessions" && isSessionListMode(object.mode)) {
    const page = typeof object.page === "number" && Number.isInteger(object.page) && object.page >= 1
      ? object.page
      : 1;
    return {
      type: "list-session-page",
      mode: object.mode,
      page,
      projectId: typeof object.projectId === "string" ? object.projectId : undefined
    };
  }

  if (object.action === "list_codex_projects") {
    return { type: "list-project-page", page: parsePageValue(object.page) };
  }

  if (object.action === "run_codex_command" && typeof object.command === "string") {
    const command = object.command.trim();
    if (isAllowedHelpCommand(command)) {
      return { type: "run-command", command };
    }
  }

  if (object.action === "enqueue_agent_command" && typeof object.command === "string") {
    const command = object.command.trim();
    if (isAllowedFeatureTaskCommand(command)) {
      return { type: "enqueue-command", command };
    }
  }

  return undefined;
}

export function parseSelectSessionActionValue(value: unknown): string | undefined {
  const action = parseCodexCardActionValue(value);
  return action?.type === "select-session" ? action.sessionId : undefined;
}

function formatSession(session: CodexSession, index: number): string {
  const title = escapeMd(truncate(session.title || "(untitled)", MAX_TITLE_LENGTH));
  const cwd = escapeMd(truncate(session.cwd, MAX_CWD_LENGTH));
  const lines = [
    `**${index}. ${title}**`,
    session.projectDisplayLabel
      ? `project: ${escapeMd(truncate(session.projectDisplayLabel, MAX_PROJECT_LENGTH))}`
      : undefined,
    session.isTemporary ? "temporary: yes" : undefined,
    `cwd: ${cwd}`,
    `source: ${escapeMd(session.source || "-")}  updated: ${formatTime(session.updatedAt)}`
  ].filter((line): line is string => Boolean(line));
  if (session.gitBranch) {
    lines.push(`branch: ${escapeMd(session.gitBranch)}`);
  }
  return lines.join("\n");
}

function formatProject(project: CodexProject, index: number): string {
  return [
    `**${index}. ${escapeMd(truncate(project.displayLabel, MAX_PROJECT_LENGTH))}**`,
    `sessions: ${project.sessionCount}  updated: ${formatTime(project.latestUpdatedAt)}`,
    `latest: ${escapeMd(truncate(project.latestSession.title || "(untitled)", MAX_TITLE_LENGTH))}`,
    `root: ${escapeMd(truncate(project.rootPath, MAX_CWD_LENGTH))}`
  ].join("\n");
}

function card(
  title: string,
  template: string,
  elements: Array<Record<string, unknown>>
): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: title
      }
    },
    body: {
      elements
    }
  };
}

function markdownBlock(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content
  };
}

function sessionButtonRow(sessionId: string, index: number, primary: boolean): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      buttonColumn({
        name: `select_session_${index}`,
        type: primary ? "primary_filled" : "default",
        content: `介入 #${index}`,
        value: buildSelectSessionActionValue(sessionId)
      })
    ]
  };
}

function projectButtonRow(projectId: string, index: number, primary: boolean): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      buttonColumn({
        name: `bind_project_${index}`,
        type: primary ? "primary_filled" : "default",
        content: `绑定项目 #${index}`,
        value: buildBindProjectActionValue(projectId)
      })
    ]
  };
}

function projectPaginationRow(pageInfo: PageInfo | undefined): Record<string, unknown> | undefined {
  if (!pageInfo || (!pageInfo.hasPrev && !pageInfo.hasNext)) return undefined;
  const columns = [];
  if (pageInfo.hasPrev) {
    columns.push(buttonColumn({
      name: "prev_project_page",
      type: "default",
      content: "上一页",
      value: buildListProjectPageActionValue(pageInfo.page - 1)
    }));
  }
  if (pageInfo.hasNext) {
    columns.push(buttonColumn({
      name: "next_project_page",
      type: "default",
      content: "下一页",
      value: buildListProjectPageActionValue(pageInfo.page + 1)
    }));
  }
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns
  };
}

function helpCommandRows(commands: Array<{
  command: string;
  description: string;
  buttonCommand?: string;
}>): Array<Record<string, unknown>> {
  return commands.flatMap((item) => {
    const rows = [markdownBlock(`\`${item.command}\`：${item.description}`)];
    if (item.buttonCommand) {
      rows.push(singleButtonRow({
        name: `help_${safeName(item.command)}`,
        type: "default",
        content: item.buttonCommand,
        value: buildRunCommandActionValue(item.buttonCommand)
      }));
    }
    return rows;
  });
}

function featureButtonRows(features: CodexFeatureKey[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < features.length; index += 3) {
    const chunk = features.slice(index, index + 3);
    rows.push({
      tag: "column_set",
      horizontal_spacing: "8px",
      horizontal_align: "left",
      columns: chunk.map((key) => {
        const detail = CODEX_FEATURE_DETAILS[key];
        return buttonColumn({
          name: `feature_${key}`,
          type: "default",
          content: detail.label,
          value: buildRunCommandActionValue(`feature ${key}`)
        });
      })
    });
  }
  return rows;
}

function featureActionRows(actions: readonly CodexFeatureActionDefinition[]): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let index = 0; index < actions.length; index += 2) {
    const chunk = actions.slice(index, index + 2);
    rows.push({
      tag: "column_set",
      horizontal_spacing: "8px",
      horizontal_align: "left",
      columns: chunk.map((action) => buttonColumn({
        name: `feature_task_${safeName(action.label)}`,
        type: action.primary ? "primary_filled" : "default",
        content: action.label,
        value: buildEnqueueAgentCommandActionValue(action.task)
      }))
    });
  }
  return rows;
}

function singleButtonRow(options: {
  name: string;
  type: string;
  content: string;
  value: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      buttonColumn(options)
    ]
  };
}

function paginationRow(
  pageInfo: PageInfo | undefined,
  mode: CodexSessionListMode | undefined,
  projectId: string | undefined
): Record<string, unknown> | undefined {
  if (!pageInfo || !mode || (!pageInfo.hasPrev && !pageInfo.hasNext)) return undefined;
  const columns = [];
  if (pageInfo.hasPrev) {
    columns.push(buttonColumn({
      name: "prev_page",
      type: "default",
      content: "上一页",
      value: buildListSessionPageActionValue(mode, pageInfo.page - 1, projectId)
    }));
  }
  if (pageInfo.hasNext) {
    columns.push(buttonColumn({
      name: "next_page",
      type: "default",
      content: "下一页",
      value: buildListSessionPageActionValue(mode, pageInfo.page + 1, projectId)
    }));
  }
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns
  };
}

function featureDetailActionsRow(refreshCommand?: string): Record<string, unknown> {
  const columns = [];
  if (refreshCommand) {
    columns.push(buttonColumn({
      name: "feature_refresh",
      type: "default",
      content: "刷新",
      value: buildRunCommandActionValue(refreshCommand)
    }));
  }
  columns.push(buttonColumn({
    name: "feature_back",
    type: "default",
    content: "返回功能面板",
    value: buildRunCommandActionValue("features")
  }));
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns
  };
}

function parsePageValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}

function isAllowedHelpCommand(command: string): boolean {
  if (/^feature\s+(?:mcp|personality|review|side|compression|feedback|pet|fast|reasoning|model|fork)$/i.test(command)) {
    return true;
  }
  return new Set([
    "help",
    "features",
    "status",
    "status-full",
    "list-project",
    "current-project",
    "new-session",
    "list-session",
    "current-session",
    "unbind-project",
    "unbind-session",
    "list-session --all",
    "list-session --temp"
  ]).has(command);
}

function isAllowedFeatureTaskCommand(command: string): boolean {
  const tasks: string[] = CODEX_FEATURE_ORDER.flatMap((key) =>
    CODEX_FEATURE_DETAILS[key].actions.map((action) => action.task)
  );
  return new Set(tasks).has(command);
}

function formatBindingSummary(options: {
  projectLabel?: string;
  sessionTitle?: string;
  sessionId?: string;
  isTemporary?: boolean;
}): string {
  return options.projectLabel || options.sessionId
    ? [
      options.projectLabel ? `Project: ${options.projectLabel}` : undefined,
      options.sessionTitle || options.sessionId
        ? `Active session: ${options.sessionTitle || "(untitled)"}${options.sessionId ? ` (#${shortId(options.sessionId)})` : ""}`
        : "Active session: 未绑定",
      options.isTemporary ? "Temporary: yes" : undefined
    ].filter((line): line is string => Boolean(line)).join("\n")
    : "当前群未绑定 project。发送 `list-project` 选择一个 project。";
}

function formatFeatureBindingSummary(options: {
  projectLabel?: string;
  sessionTitle?: string;
  sessionId?: string;
  isTemporary?: boolean;
}): string {
  if (options.projectLabel || options.sessionId) {
    return formatBindingSummary(options);
  }
  return "当前群未绑定 project。";
}

function formatMcpServer(server: CodexMcpServerSummary): string {
  const status = server.status.toLowerCase();
  const statusBadge = mcpStatusBadge(status);
  const lines = [
    `${statusBadge} **${escapeMd(server.name)}**`,
    `Transport: ${escapeMd(server.transport)}  Status: ${escapeMd(server.status || "unknown")}  Auth: ${escapeMd(server.auth || "unknown")}`,
    server.url ? `URL: ${escapeMd(truncate(server.url, 100))}` : undefined,
    server.command ? `Command: ${escapeMd(truncate(compactCommand(server.command), 100))}` : undefined,
    server.args ? `Args: ${escapeMd(truncate(server.args, 120))}` : undefined,
    server.env ? `Env: ${escapeMd(truncate(server.env, 120))}` : undefined,
    server.cwd ? `Cwd: ${escapeMd(truncate(server.cwd, 120))}` : undefined,
    server.bearerTokenEnvVar ? `Bearer env: ${escapeMd(truncate(server.bearerTokenEnvVar, 80))}` : undefined
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

function mcpStatusBadge(status: string): string {
  if (status === "enabled") return "<font color='green'>[Enabled]</font>";
  if (status === "disabled") return "<font color='grey'>[Disabled]</font>";
  return "<font color='orange'>[Unknown]</font>";
}

function compactCommand(command: string): string {
  if (!command.includes("/")) return command;
  const segments = command.split("/").filter(Boolean);
  return segments.at(-1) || command;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buttonColumn(options: {
  name: string;
  type: string;
  content: string;
  value: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    tag: "column",
    width: "auto",
    elements: [
      {
        tag: "button",
        name: options.name,
        type: options.type,
        width: "default",
        text: {
          tag: "plain_text",
          content: options.content
        },
        behaviors: [
          {
            type: "callback",
            value: options.value
          }
        ]
      }
    ]
  };
}

function sessionFooter(mode: CodexSessionListMode | undefined): string {
  if (mode === "all") {
    return "_分页文本备用：`list-session --all 2`；切换会话：`switch-session <sessionId>`。_";
  }
  if (mode === "temp") {
    return "_分页文本备用：`list-session --temp 2`；临时对话需显式选择，不进入默认 project 列表。_";
  }
  return "_按钮不可用时，可发送 `switch-session <序号|sessionId>`；只解绑 active session 用 `unbind-session`，解绑 project 用 `unbind-project`。_";
}

function parseActionObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return parseActionObject(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isSessionListMode(value: unknown): value is CodexSessionListMode {
  return value === "project" || value === "all" || value === "temp";
}

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function escapeMd(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("_", "\\_");
}

interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
}
