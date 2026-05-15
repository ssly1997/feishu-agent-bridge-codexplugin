import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBindProjectActionValue,
  buildCodexHelpCard,
  buildCodexProjectListCard,
  buildCodexSessionListCard,
  buildListProjectPageActionValue,
  buildListSessionPageActionValue,
  buildRunCommandActionValue,
  buildSelectSessionActionValue,
  parseCodexCardActionValue,
  parseSelectSessionActionValue
} from "../src/sessionCard.js";

test("buildCodexSessionListCard renders session buttons", () => {
  const card = buildCodexSessionListCard(
    [
      {
        id: "session_1",
        title: "当前会话",
        cwd: "/tmp/project",
        source: "vscode",
        updatedAt: 1778747553,
        createdAt: 1778747000,
        gitBranch: "main"
      }
    ],
    10
  );

  const text = JSON.stringify(card);
  assert.match(text, /选择要介入的 Codex 会话/);
  assert.equal(card.schema, "2.0");
  assert.match(text, /介入 #1/);
  assert.match(text, /select_codex_session/);
  assert.match(text, /session_1/);
  assert.match(text, /behaviors/);
  assert.match(text, /callback/);
});

test("buildCodexProjectListCard renders bind project buttons and pagination", () => {
  const card = buildCodexProjectListCard(
    [
      {
        id: "proj_abc",
        kind: "workspace",
        rootPath: "/tmp/project",
        displayName: "project",
        secondaryName: "repo",
        displayLabel: "project  repo",
        labelSource: "codex-global-state",
        isTemporary: false,
        sessionCount: 3,
        latestUpdatedAt: 1778747553,
        latestSession: {
          id: "session_1",
          title: "最新会话",
          cwd: "/tmp/project",
          source: "codex",
          updatedAt: 1778747553,
          createdAt: 1778747000
        },
        sessions: []
      }
    ],
    10,
    {
      pageInfo: {
        page: 2,
        pageSize: 10,
        total: 21,
        totalPages: 3,
        hasPrev: true,
        hasNext: true
      }
    }
  );

  const text = JSON.stringify(card);
  assert.match(text, /选择要绑定的 Codex project/);
  assert.match(text, /绑定项目 #11/);
  assert.match(text, /bind_codex_project/);
  assert.match(text, /proj_abc/);
  assert.match(text, /上一页/);
  assert.match(text, /下一页/);
  assert.match(text, /list_codex_projects/);
  assert.deepEqual(parseCodexCardActionValue(buildListProjectPageActionValue(3)), {
    type: "list-project-page",
    page: 3
  });
});

test("session card pagination actions use bridge-owned values", () => {
  const card = buildCodexSessionListCard(
    [
      {
        id: "session_2",
        title: "第二页会话",
        cwd: "/tmp/project",
        source: "codex",
        updatedAt: 1778747553,
        createdAt: 1778747000
      }
    ],
    10,
    {
      mode: "all",
      pageInfo: {
        page: 2,
        pageSize: 10,
        total: 21,
        totalPages: 3,
        hasPrev: true,
        hasNext: true
      }
    }
  );

  const text = JSON.stringify(card);
  assert.match(text, /上一页/);
  assert.match(text, /下一页/);
  assert.match(text, /list_codex_sessions/);
  assert.deepEqual(parseCodexCardActionValue(buildListSessionPageActionValue("all", 3)), {
    type: "list-session-page",
    mode: "all",
    page: 3,
    projectId: undefined
  });
});

test("buildCodexSessionListCard can render an explicit unbound notice", () => {
  const card = buildCodexSessionListCard(
    [],
    10,
    {
      title: "当前群尚未绑定 Codex 会话",
      notice: "这条任务暂未入队。请先选择一个 Codex 会话。"
    }
  );

  const text = JSON.stringify(card);
  assert.match(text, /当前群尚未绑定 Codex 会话/);
  assert.match(text, /这条任务暂未入队/);
  assert.match(text, /没有找到可用的 Codex 会话/);
});

test("parseSelectSessionActionValue accepts only bridge-owned actions", () => {
  assert.equal(
    parseSelectSessionActionValue(buildSelectSessionActionValue("session_1")),
    "session_1"
  );
  assert.equal(
    parseSelectSessionActionValue(JSON.stringify(buildSelectSessionActionValue("session_1"))),
    "session_1"
  );
  assert.equal(parseSelectSessionActionValue({ action: "select_codex_session" }), undefined);
  assert.equal(
    parseSelectSessionActionValue({
      bridge: "other",
      action: "select_codex_session",
      sessionId: "session_1"
    }),
    undefined
  );
  assert.deepEqual(parseCodexCardActionValue(buildBindProjectActionValue("proj_abc")), {
    type: "bind-project",
    projectId: "proj_abc"
  });
});

test("buildCodexHelpCard renders command shortcut buttons", () => {
  const card = buildCodexHelpCard({
    projectLabel: "project  repo",
    sessionTitle: "当前会话",
    sessionId: "session_123456789"
  });

  const text = JSON.stringify(card);
  assert.match(text, /current-project/);
  assert.match(text, /unbind-project/);
  assert.match(text, /new-session/);
  assert.match(text, /run_codex_command/);
  assert.deepEqual(collectRunCommands(card), [
    "help",
    "list-project",
    "current-project",
    "new-session",
    "list-session",
    "current-session",
    "unbind-project",
    "unbind-session",
    "list-session --all",
    "list-session --temp"
  ]);
  assert.deepEqual(parseCodexCardActionValue(buildRunCommandActionValue("current-project")), {
    type: "run-command",
    command: "current-project"
  });
  assert.deepEqual(parseCodexCardActionValue(buildRunCommandActionValue("unbind-project")), {
    type: "run-command",
    command: "unbind-project"
  });
  assert.deepEqual(parseCodexCardActionValue(buildRunCommandActionValue("bind-project 1")), undefined);
});

function collectRunCommands(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectRunCommands);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const object = value as Record<string, unknown>;
  const current = object.action === "run_codex_command" && typeof object.command === "string"
    ? [object.command]
    : [];
  return [
    ...current,
    ...Object.values(object).flatMap(collectRunCommands)
  ];
}
