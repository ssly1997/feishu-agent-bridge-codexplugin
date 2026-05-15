import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import { listCommands } from "../src/commandQueue.js";
import { FeishuClient } from "../src/feishuClient.js";
import { extractCommandFromMessage, FeishuCommandListener } from "../src/inbound.js";
import type { MessageReceiveEvent } from "../src/inbound.js";
import type { BridgeConfig, ReceiveIdType } from "../src/types.js";

const execFileAsync = promisify(execFile);

class FakeFeishuClient extends FeishuClient {
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
    this.cards.push({ config, receiver, card: card as Record<string, unknown> });
    return { messageId: "om_fake_card" };
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

test("extractCommandFromMessage applies chat allowlist", () => {
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

  assert.equal(result.command, undefined);
  assert.equal(result.ignoredReason, "chat not allowed");
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
    assert.match(client.texts[0].text, /当前没有绑定 Codex 会话/);
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
        sessionId: "session_new",
        sessionTitle: "最新会话",
        sessionSource: "vscode",
        sessionGitBranch: "main",
        sessionUpdatedAt: 2000,
        cwd: "/tmp/new"
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

    const commands = await listCommands(queuePath);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].sessionId, "session_new");
    assert.equal(commands[0].sessionTitle, "最新会话");
    assert.equal(commands[0].sessionCwd, "/tmp/new");
    assert.equal(wokenSessionId, "session_new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener rejects normal commands until a Codex session is selected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-nosession-"));
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
    assert.equal(client.texts.length, 1);
    assert.match(client.texts[0].text, /请先发送 list-session/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener reloads config before handling session control commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-inbound-reload-"));
  const queuePath = join(dir, "commands.json");
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
        queuePath
      },
      codex: {
        ...DEFAULT_CONFIG.codex,
        enabled: true,
        stateDbPath: dbPath,
        sessionId: "session_old",
        cwd: "/tmp/old"
      }
    };
    const latestConfig = {
      ...staleConfig,
      codex: {
        ...staleConfig.codex,
        sessionId: "session_new",
        cwd: "/tmp/new"
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
    assert.match(client.texts[0].text, /session_new/);
    assert.doesNotMatch(client.texts[0].text, /session_old/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener handles session control commands directly without enqueueing", async () => {
  const cases = [
    {
      text: "list-session",
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
      expectedSessionId: "session_new"
    },
    {
      text: "switch-session session_old",
      expectedCards: 0,
      expectedText: /已介入 Codex 会话/,
      expectedSessionId: "session_old"
    },
    {
      text: "current-session",
      expectedCards: 0,
      expectedText: /当前 Codex 会话/,
      expectedSessionId: undefined,
      initialSessionId: "session_new"
    }
  ];

  for (const item of cases) {
    const dir = await mkdtemp(join(tmpdir(), "fab-inbound-control-"));
    const queuePath = join(dir, "commands.json");
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
          queuePath
        },
        codex: {
          ...DEFAULT_CONFIG.codex,
          enabled: true,
          stateDbPath: dbPath,
          sessionListLimit: 2,
          sessionId: item.initialSessionId,
          cwd: item.initialSessionId ? "/tmp/new" : undefined
        }
      };
      await writeFile(configPath, JSON.stringify(config), "utf8");

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
        const persisted = JSON.parse(await readFile(configPath, "utf8"));
        assert.equal(persisted.codex.sessionId, item.expectedSessionId, item.text);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

function makeMessageEvent(options: {
  chatId?: string;
  chatType?: string;
  content: string;
  mentions?: MessageReceiveEvent["message"]["mentions"];
}): MessageReceiveEvent {
  return {
    event_id: "evt_test",
    create_time: "1710000000000",
    event_type: "im.message.receive_v1",
    tenant_key: "tenant_test",
    sender: {
      sender_id: {
        open_id: "ou_sender",
        user_id: "u_sender",
        union_id: "on_sender"
      },
      sender_type: "user"
    },
    message: {
      message_id: "om_test",
      create_time: "1710000000000",
      chat_id: options.chatId ?? "oc_test",
      chat_type: options.chatType ?? "group",
      message_type: "text",
      content: options.content,
      mentions: options.mentions
    }
  };
}
