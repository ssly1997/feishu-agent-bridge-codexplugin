import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  getChatSessionBinding,
  listChatSessionBindingsBySession,
  upsertChatSessionBinding
} from "../src/chatBindings.js";
import { listCodexProjects } from "../src/codexSessions.js";
import {
  ackCommand,
  enqueueCommand,
  getNextCommand,
  listCommands,
  updateCommandStatusMetadata
} from "../src/commandQueue.js";
import { FeishuClient } from "../src/feishuClient.js";
import { extractCommandFromMessage, FeishuCommandListener } from "../src/inbound.js";
import { listenerRuntimeStatusPath } from "../src/listenerRuntime.js";
import type { MessageReceiveEvent } from "../src/inbound.js";
import type { BridgeConfig, NewAgentCommand, ReceiveIdType } from "../src/types.js";

const execFileAsync = promisify(execFile);

class FakeFeishuClient extends FeishuClient {
  failInteractive = false;
  texts: Array<{
    config: BridgeConfig;
    receiver: { receiveIdType: ReceiveIdType; receiveId: string };
    text: string;
  }> = [];
  cards: Array<{
    config: BridgeConfig;
    receiver: { receiveIdType: ReceiveIdType; receiveId: string };
    card: Record<string, unknown>;
  }> = [];
  downloads: Array<{
    messageId: string;
    resourceKey: string;
    outputPath: string;
  }> = [];
  chatNames = new Map<string, string>();
  failDownload = false;

  override async sendTextMessage(
    config: BridgeConfig,
    receiver: { receiveIdType: ReceiveIdType; receiveId: string },
    text: string
  ): Promise<{ messageId?: string }> {
    this.texts.push({ config, receiver, text });
    return { messageId: "om_fake" };
  }

  override async sendInteractiveMessageToReceiver(
    config: BridgeConfig,
    receiver: { receiveIdType: ReceiveIdType; receiveId: string },
    card: unknown
  ): Promise<{ messageId?: string }> {
    if (this.failInteractive) {
      throw new Error("card send failed");
    }
    this.cards.push({ config, receiver, card: card as Record<string, unknown> });
    return { messageId: "om_fake_card" };
  }

  override async downloadMessageResource(
    config: BridgeConfig,
    messageId: string,
    resourceKey: string,
    outputPath: string
  ) {
    if (this.failDownload) {
      throw new Error("download failed");
    }
    this.downloads.push({ messageId, resourceKey, outputPath });
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "fake image", "utf8");
    return {
      path: outputPath,
      mimeType: "image/png",
      sizeBytes: 10,
      sha256: "sha256_fake"
    };
  }

  override async getChatInfo(
    config: BridgeConfig,
    chatId: string
  ): Promise<{ chatId: string; name?: string; chatType?: string }> {
    return {
      chatId,
      name: this.chatNames.get(chatId),
      chatType: "group"
    };
  }
}

test("extractCommandFromMessage parses a mentioned group text command", () => {
  const result = extractCommandFromMessage(
    makeMessageEvent({
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> 继续执行下一步"
      }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Agent"
        }
      ]
    }),
    {
      ...DEFAULT_CONFIG,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot"
      }
    }
  );

  assert.equal(result.ignoredReason, undefined);
  assert.equal(result.command?.text, "继续执行下一步");
  assert.equal(result.command?.rawText, "<at user_id=\"ou_bot\">Agent</at> 继续执行下一步");
  assert.equal(result.command?.messageId, "om_test");
});

test("extractCommandFromMessage strips Feishu mention placeholders", () => {
  const result = extractCommandFromMessage(
    makeMessageEvent({
      content: JSON.stringify({
        text: "@_user_1 继续执行下一步"
      }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Agent"
        }
      ]
    }),
    {
      ...DEFAULT_CONFIG,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot"
      }
    }
  );

  assert.equal(result.command?.text, "继续执行下一步");
});

test("extractCommandFromMessage parses rich post text commands", () => {
  const result = extractCommandFromMessage(
    makeMessageEvent({
      messageType: "post",
      content: JSON.stringify({
        content: [[
          { tag: "at", user_id: "ou_bot", user_name: "Agent" },
          { tag: "text", text: " 能看到这个图片了吗" },
          { tag: "img", image_key: "img_post" }
        ]]
      }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Agent"
        }
      ]
    }),
    {
      ...DEFAULT_CONFIG,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot"
      }
    }
  );

  assert.equal(result.ignoredReason, undefined);
  assert.equal(result.command?.text, "能看到这个图片了吗");
  assert.equal(result.command?.rawText, "<at user_id=\"ou_bot\">Agent</at> 能看到这个图片了吗");
});

test("extractCommandFromMessage ignores group messages without the required mention", () => {
  const result = extractCommandFromMessage(
    makeMessageEvent({
      content: JSON.stringify({ text: "继续执行下一步" }),
      mentions: []
    }),
    {
      ...DEFAULT_CONFIG,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot"
      }
    }
  );

  assert.equal(result.command, undefined);
  assert.equal(result.ignoredReason, "missing bot mention");
});

test("extractCommandFromMessage no longer applies chat allowlists", () => {
  const result = extractCommandFromMessage(
    makeMessageEvent({
      chatId: "oc_other",
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> 继续执行下一步"
      }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Agent"
        }
      ]
    }),
    {
      ...DEFAULT_CONFIG,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        allowedChatIds: ["oc_allowed"]
      }
    }
  );

  assert.equal(result.ignoredReason, undefined);
  assert.equal(result.command?.chatId, "oc_other");
  assert.equal(result.command?.text, "继续执行下一步");
});

test("listener handles current-session directly without enqueueing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-"));
  const queuePath = join(dir, "commands.json");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener();
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queuePath
      }
    };
    await (
      listener as unknown as {
        handleMessageReceive: (
          data: MessageReceiveEvent,
          config: BridgeConfig,
          feishuClient: FeishuClient
        ) => Promise<void>;
      }
    ).handleMessageReceive(
      makeMessageEvent({
        content: JSON.stringify({
          text: "<at user_id=\"ou_bot\">Agent</at> current-session"
        }),
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "ou_bot" },
            name: "Agent"
          }
        ]
      }),
      config,
      client
    );

    assert.equal((await listCommands(queuePath)).length, 0);
    assert.equal(client.texts.length, 1);
    assert.match(client.texts[0].text, /当前群没有绑定 Codex project/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener reports current session status with runtime and queue details", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-status-"));
  const queuePath = join(dir, "commands.db");
  const configPath = join(dir, "config.json");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener({ configPath });
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true,
        timeoutMs: 120_000,
        inProgressTimeoutMs: 60_000,
        inProgressRecovery: "mark_failed" as const
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");
    await bindChat(queuePath, "oc_test", "session_new", "当前群");
    const first = await enqueueCommand(makeQueuedInput("om_status_1", "正在处理 A"), queuePath);
    const claimed = await getNextCommand(queuePath, { claim: true, sessionId: "session_new" });
    assert.equal(claimed?.id, first.command.id);
    await updateCommandStatusMetadata(first.command.id, queuePath, {
      statusMessageId: "om_card_1",
      statusUpdatedAt: new Date().toISOString(),
      statusSummary: "Codex CLI 已开始处理这条飞书指令。"
    });
    await enqueueCommand(makeQueuedInput("om_status_2", "等待处理 B"), queuePath);
    const done = await enqueueCommand(makeQueuedInput("om_status_3", "已经完成 C"), queuePath);
    await ackCommand(done.command.id, "done", queuePath, "处理完成");
    await writeFile(
      listenerRuntimeStatusPath(configPath),
      JSON.stringify({
        managedBy: "runtime",
        pid: process.pid,
        processAlive: true,
        updatedAt: new Date().toISOString(),
        runtimeStatusPath: listenerRuntimeStatusPath(configPath),
        running: true,
        ready: true,
        configPath,
        queuePath,
        startedAt: "2026-05-18T00:00:00.000Z",
        enqueuedCount: 3,
        ignoredCount: 0,
        scheduler: {
          activeSessions: ["session_new"],
          recoveryRunning: false,
          lastRecoveryAt: "2026-05-18T00:01:00.000Z",
          lastRecoveredCount: 0
        }
      }),
      "utf8"
    );

    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_status_control",
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> status"
      }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Agent"
        }
      ]
    }), config, client);

    assert.equal((await listCommands(queuePath)).length, 3);
    assert.equal(client.texts.length, 0);
    assert.equal(client.cards.length, 1);
    const statusCardText = JSON.stringify(client.cards[0].card);
    assert.match(statusCardText, /当前工作状态/);
    assert.match(statusCardText, /正在执行/);
    assert.match(statusCardText, /正在处理 A/);
    assert.match(statusCardText, /当前 session: pending=1 in_progress=1 done=1 failed=0/);
    assert.match(statusCardText, /ready=true running=true managedBy=runtime/);
    assert.match(statusCardText, /完整信息.*status-full/);
    assert.doesNotMatch(statusCardText, /最近任务/);

    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_status_full_control",
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> status-full"
      }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Agent"
        }
      ]
    }), config, client);

    assert.equal(client.cards.length, 2);
    const fullCardText = JSON.stringify(client.cards[1].card);
    assert.match(fullCardText, /当前工作状态（完整）/);
    assert.match(fullCardText, /Runtime 详情/);
    assert.match(fullCardText, /最近任务/);
    assert.match(fullCardText, /等待处理 B/);
    assert.match(fullCardText, /Codex CLI 已开始处理/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener status card says when there is no running task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-status-empty-"));
  const queuePath = join(dir, "commands.db");
  const configPath = join(dir, "config.json");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener({ configPath });
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");
    await bindChat(queuePath, "oc_test", "session_new", "当前群");

    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_status_empty",
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> status"
      }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    assert.equal(client.cards.length, 1);
    const cardText = JSON.stringify(client.cards[0].card);
    assert.match(cardText, /没有正在执行的任务/);
    assert.match(cardText, /"template":"yellow"/);
    assert.doesNotMatch(cardText, /"template":"red"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener status card reports live git branch and invalid git cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-status-git-"));
  const queuePath = join(dir, "commands.db");
  const configPath = join(dir, "config.json");
  const repoPath = join(dir, "repo");
  const nonRepoPath = join(dir, "not-git");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener({ configPath });
  try {
    await mkdir(repoPath);
    await mkdir(nonRepoPath);
    await execFileAsync("git", ["init"], { cwd: repoPath });
    await execFileAsync("git", ["checkout", "-b", "feature/status-card"], { cwd: repoPath });

    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");
    await upsertChatSessionBinding(queuePath, {
      chatId: "oc_test",
      chatType: "group",
      chatName: "当前群",
      session: {
        id: "session_git",
        title: "Git Session",
        cwd: repoPath,
        source: "vscode",
        updatedAt: 2000,
        createdAt: 1000,
        gitBranch: "stale-branch"
      }
    });

    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_status_git",
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> status"
      }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    assert.equal(client.cards.length, 1);
    const gitCardText = JSON.stringify(client.cards[0].card);
    assert.match(gitCardText, /Git branch: feature\/status-card/);
    assert.doesNotMatch(gitCardText, /有效仓库/);
    assert.doesNotMatch(gitCardText, /stale-branch/);

    await upsertChatSessionBinding(queuePath, {
      chatId: "oc_test",
      chatType: "group",
      chatName: "当前群",
      session: {
        id: "session_non_git",
        title: "Non Git Session",
        cwd: nonRepoPath,
        source: "vscode",
        updatedAt: 3000,
        createdAt: 1000
      }
    });
    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_status_non_git",
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> status"
      }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    assert.equal(client.cards.length, 2);
    assert.match(JSON.stringify(client.cards[1].card), /Git branch: 非有效 git 仓库/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener deduplicates control commands by message id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-dedupe-"));
  const queuePath = join(dir, "commands.json");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener();
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queuePath
      }
    };
    const event = makeMessageEvent({
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> current-session"
      }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Agent"
        }
      ]
    });

    await invokeMessageReceive(listener, event, config, client);
    await invokeMessageReceive(listener, { ...event, event_id: "evt_duplicate" }, config, client);

    assert.equal((await listCommands(queuePath)).length, 0);
    assert.equal(client.texts.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener enqueues normal commands with an immutable Codex session snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-session-"));
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  let wokenSessionId: string | undefined;
  const listener = new FeishuCommandListener({
    onCommandEnqueued: (command) => {
      wokenSessionId = command.sessionId;
    }
  });
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true,
        cwd: "/tmp/fallback"
      }
    };
    await bindChat(queuePath, "oc_test");

    await invokeMessageReceive(listener, makeMessageEvent({
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> 继续执行下一步"
      }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Agent"
        }
      ]
    }), config, client);

    const commands = await listCommands(queuePath);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].sessionId, "session_new");
    assert.equal(commands[0].sessionTitle, "最新会话");
    assert.equal(commands[0].sessionCwd, "/tmp/new");
    assert.equal(commands[0].statusMessageId, "om_fake_card");
    assert.match(commands[0].statusSummary ?? "", /等待 runtime 调度/);
    assert.equal(client.cards.length, 1);
    assert.equal(client.texts.length, 0);
    assert.equal(wokenSessionId, "session_new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener falls back to text acknowledgement when queued status card fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-status-fallback-"));
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  client.failInteractive = true;
  const listener = new FeishuCommandListener();
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true,
        cwd: "/tmp/fallback"
      }
    };
    await bindChat(queuePath, "oc_test");

    await invokeMessageReceive(listener, makeMessageEvent({
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> 继续执行下一步"
      }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Agent"
        }
      ]
    }), config, client);

    const commands = await listCommands(queuePath);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].statusMessageId, undefined);
    assert.match(commands[0].statusNotifyError ?? "", /card send failed/);
    assert.equal(client.texts.length, 1);
    assert.match(client.texts[0].text, /已加入 Agent 队列/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener sends a project list card until the current chat binds a Codex project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-nosession-"));
  const queuePath = join(dir, "commands.db");
  const dbPath = join(dir, "state.sqlite");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener();
  try {
    await seedCodexStateDb(dbPath);
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        stateDbPath: dbPath
      }
    };

    await invokeMessageReceive(listener, makeMessageEvent({
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> 继续执行下一步"
      }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Agent"
        }
      ]
    }), config, client);

    assert.equal((await listCommands(queuePath)).length, 0);
    assert.equal(client.texts.length, 0);
    assert.equal(client.cards.length, 1);
    const cardText = JSON.stringify(client.cards[0].card);
    assert.match(cardText, /当前群尚未绑定 Codex project/);
    assert.match(cardText, /这条任务暂未入队/);
    assert.match(cardText, /重新发送刚才的指令/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener binds a project from a project card action", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-project-action-"));
  const queuePath = join(dir, "commands.db");
  const configPath = join(dir, "config.json");
  const dbPath = join(dir, "state.sqlite");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener({ configPath });
  try {
    await seedCodexStateDb(dbPath);
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        stateDbPath: dbPath
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");
    const project = (await listCodexProjects(config.codex))[0];

    await (
      listener as unknown as {
        completeCardAction: (
          event: { messageId: string; chatId: string; operator: { openId: string } },
          action: { type: "bind-project"; projectId: string },
          feishuClient: FeishuClient
        ) => Promise<void>;
      }
    ).completeCardAction(
      { messageId: "om_card", chatId: "oc_test", operator: { openId: "ou_operator" } },
      { type: "bind-project", projectId: project.id },
      client
    );

    assert.equal(client.texts.length, 1);
    assert.match(client.texts[0].text, /已为当前群绑定 Codex project/);
    const binding = await getChatSessionBinding(queuePath, "oc_test");
    assert.equal(binding?.projectId, project.id);
    assert.equal(binding?.sessionId, "session_new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener runs help-card command actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-help-action-"));
  const queuePath = join(dir, "commands.db");
  const configPath = join(dir, "config.json");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener({ configPath });
  try {
    await bindChat(queuePath, "oc_test", "session_new", "当前群");
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");

    await (
      listener as unknown as {
        completeCardAction: (
          event: { messageId: string; chatId: string; operator: { openId: string } },
          action: { type: "run-command"; command: string },
          feishuClient: FeishuClient
        ) => Promise<void>;
      }
    ).completeCardAction(
      { messageId: "om_card", chatId: "oc_test", operator: { openId: "ou_operator" } },
      { type: "run-command", command: "current-project" },
      client
    );

    assert.equal(client.texts.length, 1);
    assert.match(client.texts[0].text, /当前群绑定的 Codex project/);
    assert.match(client.texts[0].text, /project id: proj_/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener creates and binds a new session in the current project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-new-session-"));
  const projectRoot = join(dir, "project");
  const queuePath = join(dir, "commands.db");
  const configPath = join(dir, "config.json");
  const dbPath = join(dir, "state.sqlite");
  const scriptPath = join(dir, "fake-codex.mjs");
  const argsPath = join(dir, "args.json");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener({ configPath });
  try {
    await mkdir(projectRoot, { recursive: true });
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
insert into threads values ('session_current', '当前会话', '${projectRoot.replaceAll("'", "''")}', 'codex', 2000, 1000, 0, 'gpt-5', 'main', '', '当前需求');
`
    ]);
    await writeFile(
      scriptPath,
      `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("-o") + 1];
const prompt = readFileSync(0, "utf8").trim();
const sql = "insert into threads values ('session_fresh', '新会话', " +
  ${JSON.stringify(`'${projectRoot.replaceAll("'", "''")}'`)} +
  ", 'codex', 3000, 3000, 0, 'gpt-5', 'main', '', '" + prompt.replaceAll("'", "''") + "');";
execFileSync("sqlite3", [${JSON.stringify(dbPath)}, sql]);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({ args, cwd: process.cwd(), prompt }));
writeFileSync(outputPath, "新会话已创建");
`,
      "utf8"
    );
    await chmod(scriptPath, 0o755);
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true,
        command: scriptPath,
        stateDbPath: dbPath,
        outputDir: join(dir, "codex-output"),
        timeoutMs: 5000
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");
    const project = (await listCodexProjects(config.codex))[0];
    await upsertChatSessionBinding(queuePath, {
      chatId: "oc_test",
      chatType: "group",
      session: project.latestSession
    });

    await invokeMessageReceive(listener, makeMessageEvent({
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> new-session 先了解当前项目"
      }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    assert.equal((await listCommands(queuePath)).length, 0);
    const binding = await getChatSessionBinding(queuePath, "oc_test");
    assert.equal(binding?.sessionId, "session_fresh");
    assert.equal(binding?.projectId, project.id);
    assert.equal(client.texts.length, 2);
    assert.match(client.texts[0].text, /正在当前 project 下创建/);
    assert.match(client.texts[1].text, /已在当前 project 下创建并绑定新的 active session/);
    assert.match(client.texts[1].text, /session_fresh/);
    assert.match(client.texts[1].text, /新会话已创建/);
    const recorded = JSON.parse(await readFile(argsPath, "utf8"));
    assert.equal(recorded.cwd, await realpath(projectRoot));
    assert.equal(recorded.prompt, "先了解当前项目");
    assert.ok(recorded.args.includes("--cd"));
    assert.ok(recorded.args.includes(await realpath(projectRoot)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener confirms new session creation before the initialization command exits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-new-session-early-"));
  const projectRoot = join(dir, "project");
  const queuePath = join(dir, "commands.db");
  const configPath = join(dir, "config.json");
  const dbPath = join(dir, "state.sqlite");
  const scriptPath = join(dir, "fake-codex.mjs");
  const releasePath = join(dir, "release");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener({ configPath });
  try {
    await mkdir(projectRoot, { recursive: true });
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
insert into threads values ('session_current', '当前会话', '${projectRoot.replaceAll("'", "''")}', 'codex', 2000, 1000, 0, 'gpt-5', 'main', '', '当前需求');
`
    ]);
    await writeFile(
      scriptPath,
      `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("-o") + 1];
const prompt = readFileSync(0, "utf8").trim();
const sql = "insert into threads values ('session_fresh', '继续优化插件', " +
  ${JSON.stringify(`'${projectRoot.replaceAll("'", "''")}'`)} +
  ", 'codex', 3000, 3000, 0, 'gpt-5', 'main', '', '" + prompt.replaceAll("'", "''") + "');";
execFileSync("sqlite3", [${JSON.stringify(dbPath)}, sql]);
while (!existsSync(${JSON.stringify(releasePath)})) {
  await delay(20);
}
writeFileSync(outputPath, "初始化完成");
`,
      "utf8"
    );
    await chmod(scriptPath, 0o755);
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true,
        command: scriptPath,
        stateDbPath: dbPath,
        outputDir: join(dir, "codex-output"),
        timeoutMs: 5000
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");
    const project = (await listCodexProjects(config.codex))[0];
    await upsertChatSessionBinding(queuePath, {
      chatId: "oc_test",
      chatType: "group",
      session: project.latestSession
    });

    const handling = invokeMessageReceive(listener, makeMessageEvent({
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> new-session 继续优化插件"
      }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    for (let attempt = 0; attempt < 50 && client.texts.length < 2; attempt += 1) {
      await delay(20);
    }
    const binding = await getChatSessionBinding(queuePath, "oc_test");
    assert.equal(binding?.sessionId, "session_fresh");
    assert.equal(binding?.sessionTitle, "继续优化插件");
    assert.equal(client.texts.length, 2);
    assert.match(client.texts[1].text, /已在当前 project 下创建并绑定新的 active session/);
    assert.match(client.texts[1].text, /初始化指令仍在执行/);
    assert.doesNotMatch(client.texts[1].text, /请不要调用任何飞书发送工具/);

    await writeFile(releasePath, "done", "utf8");
    await handling;

    assert.equal(client.texts.length, 3);
    assert.match(client.texts[2].text, /新会话初始化指令已完成/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener reloads config before handling session control commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-reload-"));
  const queuePath = join(dir, "commands.db");
  const configPath = join(dir, "config.json");
  const dbPath = join(dir, "state.sqlite");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener({ configPath });
  try {
    await seedCodexStateDb(dbPath);
    const staleConfig = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true,
        stateDbPath: dbPath,
        sessionId: "session_old",
        cwd: "/tmp/old"
      }
    };
    await bindChat(queuePath, "oc_test", "session_old");
    const latestConfig = {
      ...staleConfig,
      codex: {
        ...staleConfig.codex,
        stateDbPath: dbPath
      }
    };
    await writeFile(configPath, JSON.stringify(latestConfig), "utf8");

    await invokeMessageReceive(listener, makeMessageEvent({
      content: JSON.stringify({
        text: "<at user_id=\"ou_bot\">Agent</at> current-session"
      }),
      mentions: [
        {
          key: "@_user_1",
          id: { open_id: "ou_bot" },
          name: "Agent"
        }
      ]
    }), staleConfig, client);

    assert.equal((await listCommands(queuePath)).length, 0);
    assert.equal(client.texts.length, 1);
    assert.match(client.texts[0].text, /session_old/);
    assert.doesNotMatch(client.texts[0].text, /session_new/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener handles session control commands directly without enqueueing", async () => {
  const cases = [
    {
      text: "help",
      expectedCards: 1,
      expectedSessionId: undefined
    },
    {
      text: "list-project",
      expectedCards: 1,
      expectedSessionId: undefined
    },
    {
      text: "list-project 2",
      expectedCards: 1,
      expectedSessionId: undefined
    },
    {
      text: "list-session",
      expectedCards: 1,
      expectedSessionId: undefined
    },
    {
      text: "list-session --all 1",
      expectedCards: 1,
      expectedSessionId: undefined
    },
    {
      text: "list-session --temp 1",
      expectedCards: 1,
      expectedSessionId: undefined
    },
    {
      text: "list-sessions",
      expectedCards: 1,
      expectedSessionId: undefined
    },
    {
      text: "switch-session 1",
      expectedCards: 0,
      expectedText: /已介入 Codex 会话/,
      expectedSessionId: "session_new",
      initialSessionId: "session_new"
    },
    {
      text: "switch-session session_old",
      expectedCards: 0,
      expectedText: /不属于当前群绑定的 project/,
      expectedSessionId: "session_new",
      initialSessionId: "session_new"
    },
    {
      text: "current-session",
      expectedCards: 0,
      expectedText: /当前群绑定的 Codex project/,
      expectedSessionId: undefined,
      initialSessionId: "session_new"
    },
    {
      text: "current-project",
      expectedCards: 0,
      expectedText: /project id: proj_/,
      expectedSessionId: undefined,
      initialSessionId: "session_new"
    }
  ];

  for (const item of cases) {
    const dir = await mkdtemp(join(tmpdir(), "fab-inbound-control-"));
    const queuePath = join(dir, "commands.db");
    const configPath = join(dir, "config.json");
    const dbPath = join(dir, "state.sqlite");
    const client = new FakeFeishuClient();
    const listener = new FeishuCommandListener({ configPath });
    try {
      await seedCodexStateDb(dbPath);
      const config = {
        ...DEFAULT_CONFIG,
        enabled: true,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          enabled: true,
          botOpenId: "ou_bot",
          queueDbPath: queuePath
        },
        codex: {
          ...DEFAULT_CONFIG.codex,
          enabled: true,
          stateDbPath: dbPath,
          sessionListLimit: 2,
          cwd: item.initialSessionId ? "/tmp/new" : undefined
        }
      };
      await writeFile(configPath, JSON.stringify(config), "utf8");
      if (item.initialSessionId) {
        await bindChat(queuePath, "oc_test", item.initialSessionId);
      }

      await invokeMessageReceive(listener, makeMessageEvent({
        content: JSON.stringify({
          text: `<at user_id="ou_bot">Agent</at> ${item.text}`
        }),
        mentions: [
          {
            key: "@_user_1",
            id: { open_id: "ou_bot" },
            name: "Agent"
          }
        ]
      }), config, client);

      assert.equal((await listCommands(queuePath)).length, 0, item.text);
      assert.equal(client.cards.length, item.expectedCards, item.text);
      if (item.expectedText) {
        assert.equal(client.texts.length, 1, item.text);
        assert.match(client.texts[0].text, item.expectedText, item.text);
      }
      if (item.expectedSessionId) {
        const binding = await getChatSessionBinding(queuePath, "oc_test");
        assert.equal(binding?.sessionId, item.expectedSessionId, item.text);
        const persisted = JSON.parse(await readFile(configPath, "utf8"));
        assert.equal(persisted.codex.sessionId, undefined, item.text);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("listener warns when selecting a session already bound to another chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-shared-session-"));
  const queuePath = join(dir, "commands.db");
  const configPath = join(dir, "config.json");
  const dbPath = join(dir, "state.sqlite");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener({ configPath });
  try {
    await seedCodexStateDb(dbPath);
    await bindChat(queuePath, "oc_other", "session_new", "之前的群");
    client.chatNames.set("oc_test", "当前群");
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true,
        stateDbPath: dbPath,
        sessionListLimit: 2
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");

    await invokeMessageReceive(listener, makeMessageEvent({
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">Agent</at> bind-project 1" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    assert.equal(client.texts.length, 1);
    assert.match(client.texts[0].text, /当前群：当前群/);
    assert.match(client.texts[0].text, /已绑定到其他群/);
    assert.match(client.texts[0].text, /之前的群/);
    assert.match(client.texts[0].text, /共享同一 Codex 上下文/);
    assert.match(client.texts[0].text, /串行执行/);
    const binding = await getChatSessionBinding(queuePath, "oc_test");
    assert.equal(binding?.sessionId, "session_new");
    assert.equal(binding?.chatName, "当前群");
    const shared = await listChatSessionBindingsBySession(queuePath, "session_new");
    assert.equal(shared.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener unbinds only the active session and keeps the chat project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-unbind-session-"));
  const queuePath = join(dir, "commands.db");
  const dbPath = join(dir, "codex-state.sqlite");
  const configPath = join(dir, "config.json");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener({ configPath });
  try {
    await seedCodexStateDb(dbPath);
    await bindChat(queuePath, "oc_test", "session_new", "当前群");
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true,
        stateDbPath: dbPath
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");

    await invokeMessageReceive(listener, makeMessageEvent({
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">Agent</at> unbind-session" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    assert.equal(client.texts.length, 1);
    assert.match(client.texts[0].text, /已解除当前群 active session/);
    assert.match(client.texts[0].text, /保留 Codex project/);
    assert.match(client.texts[0].text, /当前群/);
    assert.match(client.texts[0].text, /session_new/);
    const binding = await getChatSessionBinding(queuePath, "oc_test");
    assert.equal(binding?.sessionId, undefined);
    assert.match(binding?.projectId ?? "", /^proj_/);
    assert.equal(binding?.projectDisplayLabel, "new");

    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_after_unbind_session",
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">Agent</at> 继续执行" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    assert.equal(client.cards.length, 1);
    assert.match(JSON.stringify(client.cards[0].card), /还没有 active session/);
    assert.deepEqual(await listCommands(queuePath), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener unbinds the current chat project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-unbind-project-"));
  const queuePath = join(dir, "commands.db");
  const configPath = join(dir, "config.json");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener({ configPath });
  try {
    await bindChat(queuePath, "oc_test", "session_new", "当前群");
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");

    await invokeMessageReceive(listener, makeMessageEvent({
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">Agent</at> unbind-project" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    assert.equal(client.texts.length, 1);
    assert.match(client.texts[0].text, /已解除当前群与 Codex project \/ session 的绑定/);
    assert.equal(await getChatSessionBinding(queuePath, "oc_test"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener reports when unbind-session has no current project binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-unbind-empty-"));
  const queuePath = join(dir, "commands.db");
  const configPath = join(dir, "config.json");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener({ configPath });
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      }
    };
    await writeFile(configPath, JSON.stringify(config), "utf8");

    await invokeMessageReceive(listener, makeMessageEvent({
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">Agent</at> unbind-session" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    assert.equal(client.texts.length, 1);
    assert.match(client.texts[0].text, /当前群没有绑定 Codex project/);
    assert.equal(await getChatSessionBinding(queuePath, "oc_test"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener routes different chats through their own session bindings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-chat-bindings-"));
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener();
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true
      }
    };
    await bindChat(queuePath, "oc_a", "session_a");
    await bindChat(queuePath, "oc_b", "session_b");

    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_a",
      chatId: "oc_a",
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">Agent</at> A任务" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);
    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_b",
      chatId: "oc_b",
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">Agent</at> B任务" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    const commands = await listCommands(queuePath);
    assert.equal(commands.length, 2);
    assert.equal(commands.find((command) => command.chatId === "oc_a")?.sessionId, "session_a");
    assert.equal(commands.find((command) => command.chatId === "oc_b")?.sessionId, "session_b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener caches unmentioned group images without enqueueing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-image-cache-"));
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener();
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      }
    };

    await invokeMessageReceive(listener, makeMessageEvent({
      messageType: "image",
      messageId: "om_image",
      content: JSON.stringify({ image_key: "img_key_1" }),
      mentions: []
    }), config, client);

    assert.equal((await listCommands(queuePath)).length, 0);
    assert.equal(client.cards.length, 0);
    assert.equal(client.texts.length, 0);
    assert.equal(client.downloads.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener attaches a recent image from the same chat and sender", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-image-attach-"));
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener();
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true
      }
    };
    await bindChat(queuePath, "oc_test");

    await invokeMessageReceive(listener, makeMessageEvent({
      messageType: "image",
      messageId: "om_image",
      content: JSON.stringify({ image_key: "img_key_1" }),
      mentions: []
    }), config, client);
    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_text",
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">Agent</at> 识别刚才那张图" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    const commands = await listCommands(queuePath);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].text, "识别刚才那张图");
    assert.equal(commands[0].attachments?.length, 1);
    assert.equal(commands[0].attachments?.[0].messageId, "om_image");
    assert.equal(commands[0].attachments?.[0].resourceKey, "img_key_1");
    assert.equal(client.downloads.length, 1);
    assert.equal(client.cards.length, 1);
    assert.match(JSON.stringify(client.cards[0].card), /附件：1 个/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener attaches all recent images from the same chat and sender", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-image-attach-many-"));
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener();
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true
      }
    };
    await bindChat(queuePath, "oc_test");

    for (const index of [1, 2, 3]) {
      await invokeMessageReceive(listener, makeMessageEvent({
        messageType: "image",
        messageId: `om_image_${index}`,
        content: JSON.stringify({ image_key: `img_key_${index}` }),
        mentions: []
      }), config, client);
    }
    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_text_many",
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">Agent</at> 我刚刚发了三张图片，都能识别到吗" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    const commands = await listCommands(queuePath);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].attachments?.length, 3);
    assert.deepEqual(
      commands[0].attachments?.map((attachment) => attachment.resourceKey),
      ["img_key_1", "img_key_2", "img_key_3"]
    );
    assert.deepEqual(
      client.downloads.map((download) => download.resourceKey),
      ["img_key_1", "img_key_2", "img_key_3"]
    );
    assert.equal(client.cards.length, 1);
    assert.match(JSON.stringify(client.cards[0].card), /附件：3 个/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener keeps generic analysis commands as text tasks without image candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-generic-analysis-"));
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener();
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true
      }
    };
    await bindChat(queuePath, "oc_test");

    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_analysis",
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">Agent</at> 分析这段代码" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    const commands = await listCommands(queuePath);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].text, "分析这段代码");
    assert.equal(commands[0].attachments, undefined);
    assert.equal(client.downloads.length, 0);
    assert.equal(client.texts.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener does not attach images from another sender or expired candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-image-miss-"));
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener();
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true
      }
    };
    await bindChat(queuePath, "oc_test");

    await invokeMessageReceive(listener, makeMessageEvent({
      messageType: "image",
      messageId: "om_image_old",
      createTime: "1",
      content: JSON.stringify({ image_key: "img_old" }),
      mentions: []
    }), config, client);
    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_text_other",
      senderOpenId: "ou_other",
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">Agent</at> 识别刚才那张图" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);
    await invokeMessageReceive(listener, makeMessageEvent({
      messageId: "om_text_expired",
      content: JSON.stringify({ text: "<at user_id=\"ou_bot\">Agent</at> 识别刚才那张图" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    assert.equal((await listCommands(queuePath)).length, 0);
    assert.equal(client.downloads.length, 0);
    assert.equal(client.texts.length, 2);
    assert.match(client.texts[0].text, /没找到最近图片/);
    assert.match(client.texts[1].text, /没找到最近图片/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener handles a mentioned image message as an image task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-image-direct-"));
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener();
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true
      }
    };
    await bindChat(queuePath, "oc_test");

    await invokeMessageReceive(listener, makeMessageEvent({
      messageType: "image",
      messageId: "om_image_direct",
      content: JSON.stringify({ image_key: "img_direct" }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    const commands = await listCommands(queuePath);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].text, "请识别并分析这张图片。");
    assert.equal(commands[0].attachments?.[0].resourceKey, "img_direct");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener handles a mentioned rich post with image attachment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-post-image-"));
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  const listener = new FeishuCommandListener();
  try {
    const config = {
      ...DEFAULT_CONFIG,
      enabled: true,
      inbound: {
        ...DEFAULT_CONFIG.inbound,
        enabled: true,
        botOpenId: "ou_bot",
        queueDbPath: queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true
      }
    };
    await bindChat(queuePath, "oc_test");

    await invokeMessageReceive(listener, makeMessageEvent({
      messageType: "post",
      messageId: "om_post_image",
      content: JSON.stringify({
        post: {
          zh_cn: {
            title: "",
            content: [[
              { tag: "at", user_id: "ou_bot", user_name: "Agent" },
              { tag: "img", image_key: "img_post" },
              { tag: "text", text: "能看到这个图片了吗" }
            ]]
          }
        }
      }),
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Agent" }]
    }), config, client);

    const commands = await listCommands(queuePath);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].text, "能看到这个图片了吗");
    assert.equal(commands[0].attachments?.length, 1);
    assert.equal(commands[0].attachments?.[0].messageId, "om_post_image");
    assert.equal(commands[0].attachments?.[0].resourceKey, "img_post");
    assert.equal(client.downloads.length, 1);
    assert.match(JSON.stringify(client.cards[0].card), /附件：1 个/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function invokeMessageReceive(
  listener: FeishuCommandListener,
  data: MessageReceiveEvent,
  config: BridgeConfig,
  feishuClient: FeishuClient
): Promise<void> {
  await (
    listener as unknown as {
      handleMessageReceive: (
        data: MessageReceiveEvent,
        config: BridgeConfig,
        feishuClient: FeishuClient
      ) => Promise<void>;
    }
  ).handleMessageReceive(data, config, feishuClient);
}

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
insert into threads values ('session_old', '旧会话', '/tmp/old', 'cli', 1000, 900, 0, 'gpt-5', null, '', '旧需求');
insert into threads values ('session_new', '最新会话', '/tmp/new', 'vscode', 2000, 1000, 0, 'gpt-5', 'main', '', '新需求');
`
  ]);
}

async function bindChat(
  queuePath: string,
  chatId: string,
  sessionId = "session_new",
  chatName?: string
): Promise<void> {
  await upsertChatSessionBinding(queuePath, {
    chatId,
    chatType: "group",
    chatName,
    session: {
      id: sessionId,
      title: sessionId === "session_new" ? "最新会话" : `Session ${sessionId}`,
      cwd: sessionId === "session_new" ? "/tmp/new" : `/tmp/${sessionId}`,
      source: "vscode",
      updatedAt: 2000,
      createdAt: 1000,
      gitBranch: sessionId === "session_new" ? "main" : undefined
    }
  });
}

function makeQueuedInput(messageId: string, text: string): NewAgentCommand {
  return {
    text,
    rawText: text,
    messageId,
    chatId: "oc_test",
    chatType: "group",
    sender: { openId: "ou_sender" },
    createdAt: "1710000000000",
    sessionId: "session_new",
    sessionTitle: "最新会话",
    sessionCwd: "/tmp/new",
    sessionSource: "vscode",
    sessionGitBranch: "main",
    sessionUpdatedAt: 2000
  };
}

function makeMessageEvent(options: {
  messageId?: string;
  messageType?: string;
  createTime?: string;
  chatId?: string;
  chatType?: string;
  senderOpenId?: string;
  content: string;
  mentions?: MessageReceiveEvent["message"]["mentions"];
}): MessageReceiveEvent {
  const createTime = options.createTime ?? String(Date.now());
  const senderOpenId = options.senderOpenId ?? "ou_sender";
  return {
    event_id: "evt_test",
    create_time: createTime,
    event_type: "im.message.receive_v1",
    tenant_key: "tenant_test",
    sender: {
      sender_id: {
        open_id: senderOpenId,
        user_id: `${senderOpenId}_user`,
        union_id: `${senderOpenId}_union`
      },
      sender_type: "user"
    },
    message: {
      message_id: options.messageId ?? "om_test",
      create_time: createTime,
      chat_id: options.chatId ?? "oc_test",
      chat_type: options.chatType ?? "group",
      message_type: options.messageType ?? "text",
      content: options.content,
      mentions: options.mentions
    }
  };
}
