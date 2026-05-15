import type { CodexSession } from "./codexSessions.js";

const MAX_TITLE_LENGTH = 80;
const MAX_CWD_LENGTH = 120;

export function buildCodexSessionListCard(
  sessions: CodexSession[],
  limit: number,
  options: {
    title?: string;
    notice?: string;
  } = {}
): Record<string, unknown> {
  const visible = sessions.slice(0, limit);
  const elements: Array<Record<string, unknown>> = [];

  if (options.notice) {
    elements.push(markdownBlock(options.notice));
    elements.push({ tag: "hr" });
  }

  if (visible.length === 0) {
    elements.push(markdownBlock("没有找到可用的 Codex 会话。"));
  } else {
    for (const [index, session] of visible.entries()) {
      elements.push(markdownBlock(formatSession(session, index + 1)));
      elements.push(buttonRow(session.id, index + 1, index === 0));
      if (index < visible.length - 1) {
        elements.push({ tag: "hr" });
      }
    }
  }

  elements.push(markdownBlock("_按钮不可用时，可发送 list-session <序号> 作为备用；解绑当前群可发送 unbind-session。_"));

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: options.title ?? "选择要介入的 Codex 会话"
      }
    },
    body: {
      elements
    }
  };
}

export function buildSelectSessionActionValue(sessionId: string): Record<string, string> {
  return {
    bridge: "feishu-agent-bridge",
    action: "select_codex_session",
    sessionId
  };
}

export function parseSelectSessionActionValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      return parseSelectSessionActionValue(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  if (
    object.bridge !== "feishu-agent-bridge" ||
    object.action !== "select_codex_session" ||
    typeof object.sessionId !== "string" ||
    object.sessionId.length === 0
  ) {
    return undefined;
  }
  return object.sessionId;
}

function formatSession(session: CodexSession, index: number): string {
  const title = escapeMd(truncate(session.title || "(untitled)", MAX_TITLE_LENGTH));
  const cwd = escapeMd(truncate(session.cwd, MAX_CWD_LENGTH));
  const lines = [
    `**${index}. ${title}**`,
    `cwd: ${cwd}`,
    `source: ${escapeMd(session.source || "-")}  updated: ${formatTime(session.updatedAt)}`
  ];
  if (session.gitBranch) {
    lines.push(`branch: ${escapeMd(session.gitBranch)}`);
  }
  return lines.join("\n");
}

function markdownBlock(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content
  };
}

function buttonRow(sessionId: string, index: number, primary: boolean): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns: [
      {
        tag: "column",
        width: "auto",
        elements: [
          {
            tag: "button",
            name: `select_session_${index}`,
            type: primary ? "primary_filled" : "default",
            width: "default",
            text: {
              tag: "plain_text",
              content: `介入 #${index}`
            },
            behaviors: [
              {
                type: "callback",
                value: buildSelectSessionActionValue(sessionId)
              }
            ]
          }
        ]
      }
    ]
  };
}

function formatTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function escapeMd(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("_", "\\_");
}
