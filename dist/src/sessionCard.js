const MAX_TITLE_LENGTH = 80;
const MAX_CWD_LENGTH = 120;
const MAX_PROJECT_LENGTH = 100;
const BRIDGE_ACTION_OWNER = "feishu-agent-bridge";
export function buildCodexSessionListCard(sessions, limit, options = {}) {
    const visible = sessions.slice(0, limit);
    const elements = [];
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
    }
    else {
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
export function buildCodexProjectListCard(projects, limit, options = {}) {
    const visible = projects.slice(0, limit);
    const elements = [];
    if (options.notice) {
        elements.push(markdownBlock(options.notice));
        elements.push({ tag: "hr" });
    }
    if (visible.length === 0) {
        elements.push(markdownBlock("没有找到可绑定的 Codex project。临时对话默认隐藏，可发送 `list-session --temp` 查看。"));
    }
    else {
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
export function buildCodexHelpCard(options = {}) {
    const bindingLines = options.projectLabel || options.sessionId
        ? [
            options.projectLabel ? `Project: ${options.projectLabel}` : undefined,
            options.sessionTitle || options.sessionId
                ? `Active session: ${options.sessionTitle || "(untitled)"}${options.sessionId ? ` (#${shortId(options.sessionId)})` : ""}`
                : "Active session: 未绑定",
            options.isTemporary ? "Temporary: yes" : undefined
        ].filter((line) => Boolean(line)).join("\n")
        : "当前群未绑定 project。发送 `list-project` 选择一个 project。";
    const elements = [
        markdownBlock(`**当前绑定**\n${escapeMd(bindingLines)}`),
        { tag: "hr" },
        markdownBlock("**常用命令**"),
        ...helpCommandRows([
            {
                command: "help / 帮助",
                description: "查看这张帮助卡",
                buttonCommand: "help"
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
export function buildSelectSessionActionValue(sessionId) {
    return {
        bridge: BRIDGE_ACTION_OWNER,
        action: "select_codex_session",
        sessionId
    };
}
export function buildBindProjectActionValue(projectId) {
    return {
        bridge: BRIDGE_ACTION_OWNER,
        action: "bind_codex_project",
        projectId
    };
}
export function buildListSessionPageActionValue(mode, page, projectId) {
    return {
        bridge: BRIDGE_ACTION_OWNER,
        action: "list_codex_sessions",
        mode,
        page,
        projectId
    };
}
export function buildListProjectPageActionValue(page) {
    return {
        bridge: BRIDGE_ACTION_OWNER,
        action: "list_codex_projects",
        page
    };
}
export function buildRunCommandActionValue(command) {
    return {
        bridge: BRIDGE_ACTION_OWNER,
        action: "run_codex_command",
        command
    };
}
export function parseCodexCardActionValue(value) {
    const object = parseActionObject(value);
    if (!object || object.bridge !== BRIDGE_ACTION_OWNER)
        return undefined;
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
    return undefined;
}
export function parseSelectSessionActionValue(value) {
    const action = parseCodexCardActionValue(value);
    return action?.type === "select-session" ? action.sessionId : undefined;
}
function formatSession(session, index) {
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
    ].filter((line) => Boolean(line));
    if (session.gitBranch) {
        lines.push(`branch: ${escapeMd(session.gitBranch)}`);
    }
    return lines.join("\n");
}
function formatProject(project, index) {
    return [
        `**${index}. ${escapeMd(truncate(project.displayLabel, MAX_PROJECT_LENGTH))}**`,
        `sessions: ${project.sessionCount}  updated: ${formatTime(project.latestUpdatedAt)}`,
        `latest: ${escapeMd(truncate(project.latestSession.title || "(untitled)", MAX_TITLE_LENGTH))}`,
        `root: ${escapeMd(truncate(project.rootPath, MAX_CWD_LENGTH))}`
    ].join("\n");
}
function card(title, template, elements) {
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
function markdownBlock(content) {
    return {
        tag: "markdown",
        content
    };
}
function sessionButtonRow(sessionId, index, primary) {
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
function projectButtonRow(projectId, index, primary) {
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
function projectPaginationRow(pageInfo) {
    if (!pageInfo || (!pageInfo.hasPrev && !pageInfo.hasNext))
        return undefined;
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
function helpCommandRows(commands) {
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
function singleButtonRow(options) {
    return {
        tag: "column_set",
        horizontal_spacing: "8px",
        horizontal_align: "left",
        columns: [
            buttonColumn(options)
        ]
    };
}
function paginationRow(pageInfo, mode, projectId) {
    if (!pageInfo || !mode || (!pageInfo.hasPrev && !pageInfo.hasNext))
        return undefined;
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
function parsePageValue(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : 1;
}
function isAllowedHelpCommand(command) {
    return new Set([
        "help",
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
function safeName(value) {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
function buttonColumn(options) {
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
function sessionFooter(mode) {
    if (mode === "all") {
        return "_分页文本备用：`list-session --all 2`；切换会话：`switch-session <sessionId>`。_";
    }
    if (mode === "temp") {
        return "_分页文本备用：`list-session --temp 2`；临时对话需显式选择，不进入默认 project 列表。_";
    }
    return "_按钮不可用时，可发送 `switch-session <序号|sessionId>`；只解绑 active session 用 `unbind-session`，解绑 project 用 `unbind-project`。_";
}
function parseActionObject(value) {
    if (typeof value === "string") {
        try {
            return parseActionObject(JSON.parse(value));
        }
        catch {
            return undefined;
        }
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    return value;
}
function isSessionListMode(value) {
    return value === "project" || value === "all" || value === "temp";
}
function formatTime(seconds) {
    return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}
function shortId(value) {
    return value.slice(0, 8);
}
function truncate(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    return `${value.slice(0, maxLength - 1)}…`;
}
function escapeMd(value) {
    return value.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("_", "\\_");
}
