import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBindProjectActionValue,
  buildClearCodexModelActionValue,
  buildEnqueueAgentCommandActionValue,
  buildCodexFeatureDetailCard,
  buildCodexFeatureCard,
  buildCodexModelCard,
  buildCodexMcpListCard,
  buildCodexHelpCard,
  buildCodexProjectListCard,
  buildCodexSessionListCard,
  buildListProjectPageActionValue,
  buildListSessionPageActionValue,
  buildRunCommandActionValue,
  buildSelectSessionActionValue,
  buildSetCodexModelActionValue,
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
  assert.match(text, /status/);
  assert.match(text, /status-full/);
  assert.match(text, /unbind-project/);
  assert.match(text, /unbind-session/);
  assert.match(text, /解绑说明/);
  assert.match(text, /保留 project，只清 active session/);
  assert.match(text, /new-session/);
  assert.match(text, /run_codex_command/);
  assert.deepEqual(collectRunCommands(card), [
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
  ]);
  assert.deepEqual(parseCodexCardActionValue(buildRunCommandActionValue("current-project")), {
    type: "run-command",
    command: "current-project"
  });
  assert.deepEqual(parseCodexCardActionValue(buildRunCommandActionValue("status")), {
    type: "run-command",
    command: "status"
  });
  assert.deepEqual(parseCodexCardActionValue(buildRunCommandActionValue("status-full")), {
    type: "run-command",
    command: "status-full"
  });
  assert.deepEqual(parseCodexCardActionValue(buildRunCommandActionValue("features")), {
    type: "run-command",
    command: "features"
  });
  assert.deepEqual(parseCodexCardActionValue(buildRunCommandActionValue("feature mcp")), {
    type: "run-command",
    command: "feature mcp"
  });
  assert.deepEqual(parseCodexCardActionValue(buildSetCodexModelActionValue("gpt-5.4")), {
    type: "set-model",
    model: "gpt-5.4"
  });
  assert.deepEqual(parseCodexCardActionValue(buildClearCodexModelActionValue()), {
    type: "clear-model"
  });
  assert.equal(parseCodexCardActionValue(buildSetCodexModelActionValue("bad model")), undefined);
  assert.deepEqual(parseCodexCardActionValue(buildEnqueueAgentCommandActionValue(
    "请 code review 最近一次提交，优先指出风险、回归和测试缺口。"
  )), {
    type: "enqueue-command",
    command: "请 code review 最近一次提交，优先指出风险、回归和测试缺口。"
  });
  assert.deepEqual(parseCodexCardActionValue(buildEnqueueAgentCommandActionValue("随便执行")), undefined);
  assert.deepEqual(parseCodexCardActionValue(buildRunCommandActionValue("unbind-project")), {
    type: "run-command",
    command: "unbind-project"
  });
  assert.deepEqual(parseCodexCardActionValue(buildRunCommandActionValue("bind-project 1")), undefined);
});

test("buildCodexFeatureCard renders CLI-backed feature entries", () => {
  const card = buildCodexFeatureCard({
    projectLabel: "project  repo",
    sessionTitle: "当前会话",
    sessionId: "session_123456789",
    model: "gpt-5.5",
    profile: "full-access",
    sandbox: "danger-full-access"
  });

  const text = JSON.stringify(card);
  assert.match(text, /Codex 功能面板/);
  assert.match(text, /功能入口/);
  assert.match(text, /run_codex_command/);
  assert.match(text, /feature mcp/);
  assert.match(text, /feature review/);
  assert.match(text, /个性/);
  assert.match(text, /Model: gpt-5\.5/);
  assert.match(text, /反馈/);
  assert.match(text, /宠物/);
  assert.doesNotMatch(text, /不做一键控制/);
  assert.doesNotMatch(text, /桌面内部能力/);
  assert.doesNotMatch(text, /codex mcp list/);
  assert.doesNotMatch(text, /list-project/);
  assert.doesNotMatch(text, /list-session/);
  assert.doesNotMatch(text, /current-project/);
  assert.deepEqual(collectRunCommands(card), [
    "feature mcp",
    "feature personality",
    "feature review",
    "feature side",
    "feature compression",
    "feature feedback",
    "feature pet",
    "feature fast",
    "feature reasoning",
    "feature model",
    "feature fork"
  ]);

  const unboundText = JSON.stringify(buildCodexFeatureCard());
  assert.doesNotMatch(unboundText, /list-project/);
});

test("buildCodexFeatureDetailCard renders feature detail and back button", () => {
  const card = buildCodexFeatureDetailCard("review", {
    projectLabel: "project repo"
  });

  const text = JSON.stringify(card);
  assert.match(text, /Codex 功能：代码审查/);
  assert.match(text, /codex review --uncommitted/);
  assert.match(text, /可执行操作/);
  assert.match(text, /审查未提交/);
  assert.match(text, /审查最近提交/);
  assert.match(text, /enqueue_agent_command/);
  assert.match(text, /返回功能面板/);
  assert.deepEqual(collectRunCommands(card), ["features"]);
  assert.deepEqual(collectAgentCommands(card), [
    "请对当前工作区的未提交改动做 code review，优先指出风险、回归和测试缺口。",
    "请 code review 最近一次提交，优先指出风险、回归和测试缺口。"
  ]);
});

test("task-backed non-MCP feature detail cards expose task buttons", () => {
  for (const feature of [
    "personality",
    "review",
    "side",
    "compression",
    "feedback",
    "pet",
    "fast",
    "reasoning",
    "fork"
  ]) {
    const card = buildCodexFeatureDetailCard(feature);
    const text = JSON.stringify(card);
    assert.match(text, /可执行操作/, feature);
    assert.match(text, /enqueue_agent_command/, feature);
    assert.ok(collectAgentCommands(card).length > 0, feature);
  }
});

test("buildCodexModelCard renders current model and switch buttons", () => {
  const card = buildCodexModelCard({
    projectLabel: "project repo",
    sessionTitle: "当前会话",
    sessionId: "session_123456789",
    modelStatus: {
      sessionModel: "gpt-5.4-mini",
      bridgeModel: "gpt-5.5",
      globalModel: "gpt-5.4",
      effectiveModel: "gpt-5.4-mini",
      reasoningEffort: "xhigh",
      fastModeEnabled: true
    }
  });

  const text = JSON.stringify(card);
  assert.match(text, /Codex 功能：模型/);
  assert.match(text, /Current model: gpt-5\.4-mini/);
  assert.match(text, /智能等级: xhigh/);
  assert.match(text, /快速模式: 已开启/);
  assert.match(text, /Session override: gpt-5\.4-mini/);
  assert.match(text, /Bridge default: gpt-5\.5/);
  assert.match(text, /Global default: gpt-5\.4/);
  assert.match(text, /set_codex_model/);
  assert.match(text, /clear_codex_model/);
  assert.match(text, /set_model_gpt-5_4-mini_gpt-5_4-mini/);
  assert.match(text, /当前 GPT-5\.4 Mini/);
  assert.match(text, /GPT-5\.4 Mini/);
  assert.doesNotMatch(text, /返回功能面板/);
  assert.deepEqual(collectRunCommands(card), []);
});

test("buildCodexMcpListCard renders MCP servers with colored state badges", () => {
  const card = buildCodexMcpListCard({
    projectLabel: "project repo",
    command: "codex mcp list",
    servers: [
      {
        name: "feishu-agent-bridge",
        transport: "stdio",
        status: "enabled",
        auth: "Unsupported",
        command: "node",
        args: "./scripts/codex-plugin-mcp.mjs",
        cwd: "/Users/lifangchang/.codex/plugins/cache/local/feishu-agent-bridge/0.1.2/."
      },
      {
        name: "viewinspect",
        transport: "http",
        status: "enabled",
        auth: "Unsupported",
        url: "http://127.0.0.1:47199/mcp"
      },
      {
        name: "live-socket",
        transport: "stdio",
        status: "disabled",
        auth: "Unsupported",
        command: "live-agentprobe-mcp"
      }
    ]
  });

  const text = JSON.stringify(card);
  assert.match(text, /Codex 功能：MCP/);
  assert.match(text, /MCP server 列表/);
  assert.doesNotMatch(text, /Enabled MCP servers/);
  assert.doesNotMatch(text, /Disabled MCP servers/);
  assert.match(text, /<font color='green'>\[Enabled\]<\/font> \*\*feishu-agent-bridge\*\*/);
  assert.match(text, /<font color='grey'>\[Disabled\]<\/font> \*\*live-socket\*\*/);
  assert.match(text, /feishu-agent-bridge/);
  assert.match(text, /viewinspect/);
  assert.match(text, /http:\/\/127\.0\.0\.1:47199\/mcp/);
  assert.match(text, /Servers: 3/);
  assert.doesNotMatch(text, /刷新/);
  assert.doesNotMatch(text, /返回功能面板/);
  assert.deepEqual(collectRunCommands(card), []);
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

function collectAgentCommands(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectAgentCommands);
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const object = value as Record<string, unknown>;
  const current = object.action === "enqueue_agent_command" && typeof object.command === "string"
    ? [object.command]
    : [];
  return [
    ...current,
    ...Object.values(object).flatMap(collectAgentCommands)
  ];
}
