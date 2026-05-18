import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  findCodexSession,
  formatCurrentSession,
  formatSelectedSession,
  formatSessionList,
  handleCodexSessionControlCommand,
  listCodexProjects,
  listCodexSessions,
  parseCodexSessionControlCommand
} from "../src/codexSessions.js";

const execFileAsync = promisify(execFile);

test("listCodexSessions reads active sessions from Codex state db", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-sessions-"));
  const dbPath = join(dir, "state.sqlite");
  try {
    await seedCodexStateDb(dbPath);
    const sessions = await listCodexSessions({
      ...DEFAULT_CONFIG.codex,
      stateDbPath: dbPath,
      sessionListLimit: 2
    });

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].id, "session_new");
    assert.equal(sessions[0].rolloutPath, join(dir, "session_new.jsonl"));
    assert.equal(sessions[0].firstUserMessage, "新需求");
    assert.equal(sessions[1].id, "session_old");
    assert.equal(sessions.find((session) => session.id === "session_archived"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findCodexSession supports list index and id prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-sessions-"));
  const dbPath = join(dir, "state.sqlite");
  try {
    await seedCodexStateDb(dbPath);
    const config = {
      ...DEFAULT_CONFIG.codex,
      stateDbPath: dbPath,
      sessionListLimit: 2
    };

    assert.equal((await findCodexSession(config, "1"))?.id, "session_new");
    assert.equal((await findCodexSession(config, "session_ol"))?.id, "session_old");
    assert.equal(await findCodexSession(config, "missing"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project metadata uses workspace labels and hides temporary projects by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-projects-"));
  const dbPath = join(dir, "state.sqlite");
  const globalStatePath = join(dir, "global-state.json");
  const chatroomRoot = join(dir, "worktrees", "ca9d", "ios-client");
  const tempRoot = join(dir, "temporary");
  try {
    await mkdir(chatroomRoot, { recursive: true });
    await mkdir(tempRoot, { recursive: true });
    await seedProjectStateDb(dbPath, {
      chatroomRoot,
      tempRoot
    });
    await writeFile(
      globalStatePath,
      JSON.stringify({
        "electron-workspace-root-labels": {
          [chatroomRoot]: "ios-client_chatroom"
        },
        "projectless-thread-ids": ["session_temp"]
      }),
      "utf8"
    );

    const config = {
      ...DEFAULT_CONFIG.codex,
      stateDbPath: dbPath,
      globalStatePath,
      sessionListLimit: 10
    };
    const sessions = await listCodexSessions(config, { all: true, includeTemporary: true });
    const chatroom = sessions.find((session) => session.id === "session_chatroom");
    const temporary = sessions.find((session) => session.id === "session_temp");
    assert.equal(chatroom?.projectDisplayLabel, "ios-client_chatroom  ios-client");
    assert.equal(chatroom?.projectLabelSource, "codex-global-state");
    assert.equal(temporary?.isTemporary, true);
    const temporarySessions = await listCodexSessions(config, { all: true, temporaryOnly: true });
    assert.deepEqual(temporarySessions.map((session) => session.id), ["session_temp"]);

    const projects = await listCodexProjects(config);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].displayLabel, "ios-client_chatroom  ios-client");
    assert.equal(projects[0].sessionCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session formatters include selection commands", () => {
  const sessions = [
    {
      id: "session_new",
      title: "最新会话",
      cwd: "/tmp/new",
      source: "vscode",
      updatedAt: 1778747553,
      createdAt: 1778747000,
      gitBranch: "main"
    }
  ];
  const list = formatSessionList(sessions, 10);
  assert.match(list, /list-session <序号\|sessionId>/);
  assert.match(list, /switch-session <序号\|sessionId>/);
  assert.match(list, /current-session/);
  assert.match(list, /unbind-session/);
  assert.match(list, /unbind-project/);
  assert.match(list, /session_new/);
  assert.match(formatSelectedSession(sessions[0]), /已介入 Codex 会话/);
});

test("parseCodexSessionControlCommand accepts singular and plural list-session", () => {
  assert.deepEqual(parseCodexSessionControlCommand("list-session"), {
    type: "list-session",
    mode: "project",
    page: 1
  });
  assert.deepEqual(parseCodexSessionControlCommand("list-sessions"), {
    type: "list-session",
    mode: "project",
    page: 1
  });
  assert.deepEqual(parseCodexSessionControlCommand("list-session --all 2"), {
    type: "list-session",
    mode: "all",
    page: 2
  });
  assert.deepEqual(parseCodexSessionControlCommand("list-session --temp"), {
    type: "list-session",
    mode: "temp",
    page: 1
  });
  assert.deepEqual(parseCodexSessionControlCommand("list-sessions 1"), {
    type: "select-session",
    selector: "1"
  });
});

test("parseCodexSessionControlCommand recognizes current and switch aliases", () => {
  assert.deepEqual(parseCodexSessionControlCommand("current-session"), {
    type: "current-session"
  });
  assert.deepEqual(parseCodexSessionControlCommand("current-project"), {
    type: "current-project"
  });
  assert.deepEqual(parseCodexSessionControlCommand("session-status"), {
    type: "status",
    full: false
  });
  assert.deepEqual(parseCodexSessionControlCommand("status"), {
    type: "status",
    full: false
  });
  assert.deepEqual(parseCodexSessionControlCommand("status-full"), {
    type: "status",
    full: true
  });
  assert.deepEqual(parseCodexSessionControlCommand("任务状态"), {
    type: "status",
    full: false
  });
  assert.deepEqual(parseCodexSessionControlCommand("switch-session 1"), {
    type: "select-session",
    selector: "1"
  });
  assert.deepEqual(parseCodexSessionControlCommand("unbind-session"), {
    type: "unbind-session"
  });
  assert.deepEqual(parseCodexSessionControlCommand("unbind-project"), {
    type: "unbind-project"
  });
  assert.deepEqual(parseCodexSessionControlCommand("detach-session"), {
    type: "unbind-session"
  });
  assert.deepEqual(parseCodexSessionControlCommand("help"), {
    type: "help"
  });
  assert.deepEqual(parseCodexSessionControlCommand("功能"), {
    type: "features"
  });
  assert.deepEqual(parseCodexSessionControlCommand("menu"), {
    type: "features"
  });
  assert.deepEqual(parseCodexSessionControlCommand("model"), {
    type: "feature-detail",
    feature: "model"
  });
  assert.deepEqual(parseCodexSessionControlCommand("模型"), {
    type: "feature-detail",
    feature: "model"
  });
  assert.deepEqual(parseCodexSessionControlCommand("feature mcp"), {
    type: "feature-detail",
    feature: "mcp"
  });
  assert.deepEqual(parseCodexSessionControlCommand("功能 代码审查"), {
    type: "feature-detail",
    feature: "review"
  });
  assert.deepEqual(parseCodexSessionControlCommand("list-projects"), {
    type: "list-project",
    page: 1
  });
  assert.deepEqual(parseCodexSessionControlCommand("list-project 2"), {
    type: "list-project",
    page: 2
  });
  assert.deepEqual(parseCodexSessionControlCommand("bind-project 2"), {
    type: "select-project",
    selector: "2"
  });
  assert.deepEqual(parseCodexSessionControlCommand("new-session"), {
    type: "new-session"
  });
  assert.deepEqual(parseCodexSessionControlCommand("create-session 先了解项目结构"), {
    type: "new-session",
    prompt: "先了解项目结构"
  });
  assert.deepEqual(parseCodexSessionControlCommand("新建会话"), {
    type: "new-session"
  });
});

test("parseCodexSessionControlCommand leaves natural language to Agent", () => {
  assert.equal(parseCodexSessionControlCommand("当前的会话Id是多少"), undefined);
  assert.equal(parseCodexSessionControlCommand("你好？"), undefined);
});

test("handleCodexSessionControlCommand returns CLI-backed feature summary", async () => {
  const result = await handleCodexSessionControlCommand(
    { type: "features" },
    DEFAULT_CONFIG,
    "/tmp/config.json"
  );

  assert.equal(result.ackState, "done");
  assert.equal(result.control, "features");
  assert.match(result.summary, /按钮式功能入口/);
  assert.match(result.summary, /MCP、个性、代码审查/);
  assert.doesNotMatch(result.summary, /桌面内部能力/);
  assert.doesNotMatch(result.summary, /暂不做一键控制/);
  assert.doesNotMatch(result.summary, /list-project/);
  assert.doesNotMatch(result.summary, /list-session/);
  assert.doesNotMatch(result.summary, /current-session/);
});

test("handleCodexSessionControlCommand returns feature detail summary", async () => {
  const result = await handleCodexSessionControlCommand(
    { type: "feature-detail", feature: "mcp" },
    DEFAULT_CONFIG,
    "/tmp/config.json"
  );

  assert.equal(result.ackState, "done");
  assert.equal(result.control, "feature-detail");
  assert.match(result.summary, /codex mcp list/);
  assert.match(result.summary, /校验依据/);
});

test("formatCurrentSession reports the bound session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-sessions-"));
  const dbPath = join(dir, "state.sqlite");
  try {
    await seedCodexStateDb(dbPath);
    const summary = await formatCurrentSession({
      ...DEFAULT_CONFIG.codex,
      enabled: true,
      stateDbPath: dbPath,
      sessionId: "session_new",
      cwd: "/tmp/new"
    });

    assert.match(summary, /当前 Codex 会话/);
    assert.match(summary, /enabled: true/);
    assert.match(summary, /session_new/);
    assert.match(summary, /\/tmp\/new/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handleCodexSessionControlCommand reports current session without persisting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-sessions-"));
  const dbPath = join(dir, "state.sqlite");
  const configPath = join(dir, "config.json");
  try {
    await seedCodexStateDb(dbPath);
    const config = {
      ...DEFAULT_CONFIG,
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true,
        stateDbPath: dbPath,
        sessionId: "session_new",
        cwd: "/tmp/new",
        sessionListLimit: 2
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");

    const result = await handleCodexSessionControlCommand(
      { type: "current-session" },
      config,
      configPath
    );

    assert.equal(result.ackState, "done");
    assert.equal(result.control, "current-session");
    assert.match(result.summary, /当前 Codex 会话/);
    assert.match(result.summary, /session_new/);

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(persisted.codex.sessionId, "session_new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handleCodexSessionControlCommand selects and persists a session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-sessions-"));
  const dbPath = join(dir, "state.sqlite");
  const configPath = join(dir, "config.json");
  try {
    await seedCodexStateDb(dbPath);
    await writeFile(
      join(dir, "session_new.jsonl"),
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "新需求" }]
          }
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "已完成第一轮排查" }]
          }
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "继续修复按钮介入" }]
          }
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<environment_context>ignored</environment_context>" }]
          }
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: "你正在处理一条来自飞书群聊的 Agent 指令。\n用户原始指令：\n同步会话摘要"
            }]
          }
        })
      ].join("\n"),
      "utf8"
    );
    const config = {
      ...DEFAULT_CONFIG,
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: false,
        stateDbPath: dbPath,
        sessionListLimit: 2
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");

    const result = await handleCodexSessionControlCommand(
      { type: "select-session", selector: "1" },
      config,
      configPath
    );

    assert.equal(result.ackState, "done");
    assert.match(result.summary, /会话摘要/);
    assert.match(result.summary, /首条需求：新需求/);
    assert.match(result.summary, /继续修复按钮介入/);
    assert.match(result.summary, /同步会话摘要/);
    assert.doesNotMatch(result.summary, /environment_context/);
    assert.doesNotMatch(result.summary, /你正在处理一条来自飞书群聊/);
    assert.match(result.summary, /已完成第一轮排查/);
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(persisted.codex.enabled, true);
    assert.equal(persisted.codex.sessionId, "session_new");
    assert.equal(persisted.codex.sessionTitle, "最新会话");
    assert.equal(persisted.codex.sessionSource, "vscode");
    assert.equal(persisted.codex.sessionUpdatedAt, 2000);
    assert.equal(persisted.codex.sessionGitBranch, "main");
    assert.equal(persisted.codex.cwd, "/tmp/new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function seedCodexStateDb(dbPath: string): Promise<void> {
  await execFileAsync("sqlite3", [
    dbPath,
    `
create table threads (
  id text primary key,
  title text not null,
  cwd text not null,
  source text not null,
  updated_at integer not null,
  created_at integer not null,
  archived integer not null,
  model text,
  git_branch text,
  rollout_path text,
  first_user_message text
);
insert into threads values ('session_old', '旧会话', '/tmp/old', 'cli', 1000, 900, 0, 'gpt-5', null, '${join(dbPath, "..", "session_old.jsonl").replaceAll("'", "''")}', '旧需求');
insert into threads values ('session_archived', '归档会话', '/tmp/archived', 'cli', 3000, 900, 1, 'gpt-5', null, '${join(dbPath, "..", "session_archived.jsonl").replaceAll("'", "''")}', '归档需求');
insert into threads values ('session_new', '最新会话', '/tmp/new', 'vscode', 2000, 1000, 0, 'gpt-5', 'main', '${join(dbPath, "..", "session_new.jsonl").replaceAll("'", "''")}', '新需求');
`
  ]);
}

async function seedProjectStateDb(
  dbPath: string,
  roots: { chatroomRoot: string; tempRoot: string }
): Promise<void> {
  await execFileAsync("sqlite3", [
    dbPath,
    `
create table threads (
  id text primary key,
  title text not null,
  cwd text not null,
  source text not null,
  updated_at integer not null,
  created_at integer not null,
  archived integer not null,
  model text,
  git_branch text,
  git_origin_url text,
  rollout_path text,
  first_user_message text
);
insert into threads values ('session_chatroom', '聊天室需求', '${roots.chatroomRoot.replaceAll("'", "''")}', 'codex', 2000, 1000, 0, 'gpt-5', 'main', 'git@example.com:kwai/ios-client.git', '', '聊天室需求');
insert into threads values ('session_temp', '临时问题', '${roots.tempRoot.replaceAll("'", "''")}', 'codex', 1000, 900, 0, 'gpt-5', null, null, '', '临时问题');
`
  ]);
}
