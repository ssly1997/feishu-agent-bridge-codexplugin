import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import { enqueueCommand, listCommands, updateCommandStatusMetadata } from "../src/commandQueue.js";
import { buildFeishuCommandPrompt, processNextCodexCommand } from "../src/codexWorker.js";
import { FeishuClient } from "../src/feishuClient.js";
import type { BridgeConfig, ReceiveIdType } from "../src/types.js";

const execFileAsync = promisify(execFile);

class FakeFeishuClient extends FeishuClient {
  failUpdate = false;
  sent: Array<{
    config: BridgeConfig;
    receiver: { receiveIdType: ReceiveIdType; receiveId: string };
    card: Record<string, unknown>;
  }> = [];
  updated: Array<{
    config: BridgeConfig;
    messageId: string;
    card: Record<string, unknown>;
  }> = [];

  override async sendInteractiveMessageToReceiver(
    config: BridgeConfig,
    receiver: { receiveIdType: ReceiveIdType; receiveId: string },
    card: unknown
  ): Promise<{ messageId?: string }> {
    this.sent.push({ config, receiver, card: card as Record<string, unknown> });
    return { messageId: "om_fake" };
  }

  override async updateInteractiveMessage(
    config: BridgeConfig,
    messageId: string,
    card: unknown
  ): Promise<{ messageId?: string }> {
    if (this.failUpdate) {
      throw new Error("patch failed");
    }
    this.updated.push({ config, messageId, card: card as Record<string, unknown> });
    return { messageId };
  }
}

test("processNextCodexCommand resumes Codex CLI, acks queue, and notifies Feishu", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-worker-"));
  const scriptPath = join(dir, "fake-codex.mjs");
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  const outputDir = join(dir, "codex-output");
  const client = new FakeFeishuClient();
  try {
    await writeFile(
      scriptPath,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("-o") + 1];
const prompt = readFileSync(0, "utf8").trim();
writeFileSync(outputPath, "Codex handled: " + prompt);
`,
      "utf8"
    );
    await chmod(scriptPath, 0o755);

    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        appId: "cli_test",
        appSecret: "secret_test",
        receiveId: "oc_test",
        enabled: true,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          enabled: true,
          queueDbPath: queuePath
        },
        codex: {
          ...DEFAULT_CONFIG.codex,
          enabled: true,
          command: scriptPath,
          sessionId: "session_1",
          outputDir,
          timeoutMs: 5000
        }
      }),
      "utf8"
    );

    const { command } = await enqueueCommand(
      {
        text: "继续执行测试",
        rawText: "<at user_id=\"ou_bot\">bot</at> 继续执行测试",
        messageId: "om_1",
        chatId: "oc_1",
        chatType: "group",
        sender: { openId: "ou_user" },
        createdAt: "1710000000000",
        sessionId: "session_1",
        sessionTitle: "Session 1",
        sessionCwd: dir
      },
      queuePath
    );

    const result = await processNextCodexCommand({ configPath, feishuClient: client });
    assert.equal(result.processed, true);
    assert.equal(result.ackState, "done");
    assert.match(result.summary ?? "", /Codex handled:/);
    assert.match(result.summary ?? "", /不要调用 feishu_notify/);
    assert.match(result.summary ?? "", /用户原始指令/);
    assert.match(result.summary ?? "", /继续执行测试/);
    assert.equal(result.notification, "sent");
    assert.equal(client.sent.length, 1);
    assert.deepEqual(client.sent[0].receiver, { receiveIdType: "chat_id", receiveId: "oc_1" });
    assert.equal(result.codex?.outputPath, join(outputDir, `${command.id}.txt`));

    const commands = await listCommands(queuePath);
    assert.equal(commands[0].state, "done");
    assert.equal(commands[0].resultSummary, result.summary);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildFeishuCommandPrompt tells resumed Codex not to send Feishu messages itself", () => {
  const prompt = buildFeishuCommandPrompt({
    id: "fcmd_test",
    state: "pending",
    text: "回我一条消息，带代码块",
    rawText: "回我一条消息，带代码块",
    messageId: "om_test",
    chatId: "oc_test",
    sender: {},
    source: "feishu",
    receivedAt: "2026-05-14T10:00:00.000Z",
    attempts: 0,
    attachments: [
      {
        type: "image",
        source: "feishu",
        path: "/tmp/fab/image.png",
        messageId: "om_image",
        resourceKey: "img_key",
        mimeType: "image/png",
        sizeBytes: 10,
        sha256: "sha"
      }
    ]
  });

  assert.match(prompt, /不要调用 feishu_notify/);
  assert.match(prompt, /外层 feishu-agent-bridge runtime 会自动/);
  assert.match(prompt, /可公开/);
  assert.match(prompt, /回我一条消息，带代码块/);
  assert.match(prompt, /本地附件/);
  assert.match(prompt, /\/tmp\/fab\/image\.png/);
});

test("processNextCodexCommand updates an existing status card while running and when done", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-worker-status-"));
  const scriptPath = join(dir, "fake-codex.mjs");
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  const outputDir = join(dir, "codex-output");
  const client = new FakeFeishuClient();
  let now = Date.parse("2026-05-15T00:00:00.000Z");
  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    await execFileAsync("git", ["checkout", "-b", "feature/progress-card"], { cwd: dir });

    await writeFile(
      scriptPath,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("-o") + 1];
readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{\\\\\\"cmd\\\\\\":\\\\\\"secret\\\\\\"}" } }));
console.log(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "测试已经通过一半" } }));
writeFileSync(outputPath, "全部完成");
`,
      "utf8"
    );
    await chmod(scriptPath, 0o755);

    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        appId: "cli_test",
        appSecret: "secret_test",
        receiveId: "oc_test",
        enabled: true,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          enabled: true,
          queueDbPath: queuePath
        },
        codex: {
          ...DEFAULT_CONFIG.codex,
          enabled: true,
          command: scriptPath,
          sessionId: "session_1",
          outputDir,
          timeoutMs: 5000
        }
      }),
      "utf8"
    );

    const { command } = await enqueueCommand(
      {
        text: "继续执行测试",
        rawText: "继续执行测试",
        messageId: "om_status",
        chatId: "oc_1",
        chatType: "group",
        sender: { openId: "ou_user" },
        createdAt: "1710000000000",
        sessionId: "session_1",
        sessionTitle: "Session 1",
        sessionCwd: dir
      },
      queuePath
    );
    await updateCommandStatusMetadata(command.id, queuePath, {
      statusMessageId: "om_status_card"
    });

    const result = await processNextCodexCommand({
      configPath,
      feishuClient: client,
      now: () => {
        const value = now;
        now += 61_000;
        return value;
      }
    });

    assert.equal(result.ackState, "done");
    assert.equal(result.notification, "updated");
    assert.equal(client.sent.length, 0);
    assert.ok(client.updated.length >= 3);
    assert.ok(client.updated.every((item) => item.messageId === "om_status_card"));
    const cards = client.updated.map((item) => JSON.stringify(item.card)).join("\n");
    assert.match(cards, /处理中/);
    assert.match(cards, /正在执行本地命令/);
    assert.match(cards, /测试已经通过一半/);
    assert.match(cards, /完成/);
    assert.match(cards, /最近进展/);
    assert.match(cards, /结论：\\n全部完成/);
    assert.doesNotMatch(cards, /进度摘要/);
    assert.match(cards, /Working directory/);
    assert.match(cards, /Git branch/);
    assert.match(cards, /feature\/progress-card/);
    assert.doesNotMatch(cards, /有效仓库/);
    assert.doesNotMatch(cards, /secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("processNextCodexCommand keeps in-progress status card alive without agent output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-worker-status-heartbeat-"));
  const scriptPath = join(dir, "fake-codex.mjs");
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  try {
    await writeFile(
      scriptPath,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("-o") + 1];
readFileSync(0, "utf8");
await new Promise((resolve) => setTimeout(resolve, 90));
writeFileSync(outputPath, "长任务完成");
`,
      "utf8"
    );
    await chmod(scriptPath, 0o755);

    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        appId: "cli_test",
        appSecret: "secret_test",
        receiveId: "oc_test",
        enabled: true,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          enabled: true,
          queueDbPath: queuePath
        },
        codex: {
          ...DEFAULT_CONFIG.codex,
          enabled: true,
          command: scriptPath,
          sessionId: "session_1",
          timeoutMs: 5000
        }
      }),
      "utf8"
    );

    const { command } = await enqueueCommand(
      {
        text: "执行一个长任务",
        rawText: "执行一个长任务",
        messageId: "om_heartbeat",
        chatId: "oc_1",
        chatType: "group",
        sender: { openId: "ou_user" },
        createdAt: "1710000000000",
        sessionId: "session_1",
        sessionTitle: "Session 1"
      },
      queuePath
    );
    await updateCommandStatusMetadata(command.id, queuePath, {
      statusMessageId: "om_status_card"
    });

    const result = await processNextCodexCommand({
      configPath,
      feishuClient: client,
      progressUpdateIntervalMs: 20
    });

    assert.equal(result.ackState, "done");
    const cards = client.updated.map((item) => JSON.stringify(item.card));
    const inProgressCards = cards.filter((card) => /处理中/.test(card));
    assert.ok(inProgressCards.length >= 2);
    assert.doesNotMatch(cards.join("\n"), /状态卡每 20ms 自动刷新/);
    assert.doesNotMatch(cards.join("\n"), /Codex CLI 已开始处理/);
    assert.match(inProgressCards.join("\n"), /最近进展/);
    assert.match(inProgressCards.join("\n"), /已交接给 Codex CLI 处理/);
    assert.match(inProgressCards.join("\n"), /In progress/);
    assert.doesNotMatch(inProgressCards.join("\n"), /Needs action/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("processNextCodexCommand reads public progress from Codex session log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-worker-status-session-log-"));
  const scriptPath = join(dir, "fake-codex.mjs");
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  const dbPath = join(dir, "state.sqlite");
  const rolloutPath = join(dir, "rollout.jsonl");
  const client = new FakeFeishuClient();
  try {
    await writeFile(rolloutPath, "", "utf8");
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
insert into threads values ('session_1', 'Session 1', '${dir}', 'cli', 2000, 1000, 0, 'gpt-5', null, '${rolloutPath}', '测试');
`
    ]);
    await writeFile(
      scriptPath,
      `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const rolloutPath = ${JSON.stringify(rolloutPath)};
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("-o") + 1];
readFileSync(0, "utf8");
await new Promise((resolve) => setTimeout(resolve, 35));
appendFileSync(rolloutPath, JSON.stringify({
  type: "response_item",
  payload: {
    type: "message",
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: "正在读取 session 日志里的公开进展" }]
  }
}) + "\\n");
await new Promise((resolve) => setTimeout(resolve, 65));
writeFileSync(outputPath, "长任务完成");
`,
      "utf8"
    );
    await chmod(scriptPath, 0o755);

    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        appId: "cli_test",
        appSecret: "secret_test",
        receiveId: "oc_test",
        enabled: true,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          enabled: true,
          queueDbPath: queuePath
        },
        codex: {
          ...DEFAULT_CONFIG.codex,
          enabled: true,
          command: scriptPath,
          sessionId: "session_1",
          stateDbPath: dbPath,
          timeoutMs: 5000
        }
      }),
      "utf8"
    );

    const { command } = await enqueueCommand(
      {
        text: "执行一个会写 session 日志的长任务",
        rawText: "执行一个会写 session 日志的长任务",
        messageId: "om_session_log",
        chatId: "oc_1",
        chatType: "group",
        sender: { openId: "ou_user" },
        createdAt: "1710000000000",
        sessionId: "session_1",
        sessionTitle: "Session 1"
      },
      queuePath
    );
    await updateCommandStatusMetadata(command.id, queuePath, {
      statusMessageId: "om_status_card"
    });

    const result = await processNextCodexCommand({
      configPath,
      feishuClient: client,
      progressUpdateIntervalMs: 20
    });

    assert.equal(result.ackState, "done");
    const cards = client.updated.map((item) => JSON.stringify(item.card)).join("\n");
    assert.match(cards, /最近进展/);
    assert.match(cards, /正在读取 session 日志里的公开进展/);
    assert.doesNotMatch(cards, /状态卡每/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("processNextCodexCommand falls back to a result card when status card updates fail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-worker-status-fallback-"));
  const scriptPath = join(dir, "fake-codex.mjs");
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  client.failUpdate = true;
  try {
    await writeFile(
      scriptPath,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("-o") + 1];
readFileSync(0, "utf8");
writeFileSync(outputPath, "完成但状态卡更新失败");
`,
      "utf8"
    );
    await chmod(scriptPath, 0o755);

    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        appId: "cli_test",
        appSecret: "secret_test",
        receiveId: "oc_test",
        enabled: true,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          enabled: true,
          queueDbPath: queuePath
        },
        codex: {
          ...DEFAULT_CONFIG.codex,
          enabled: true,
          command: scriptPath,
          sessionId: "session_1",
          timeoutMs: 5000
        }
      }),
      "utf8"
    );

    const { command } = await enqueueCommand(
      {
        text: "继续执行测试",
        rawText: "继续执行测试",
        messageId: "om_fallback",
        chatId: "oc_1",
        chatType: "group",
        sender: { openId: "ou_user" },
        createdAt: "1710000000000",
        sessionId: "session_1",
        sessionTitle: "Session 1"
      },
      queuePath
    );
    await updateCommandStatusMetadata(command.id, queuePath, {
      statusMessageId: "om_status_card"
    });

    const result = await processNextCodexCommand({ configPath, feishuClient: client });

    assert.equal(result.ackState, "done");
    assert.equal(result.notification, "sent");
    assert.match(result.notifyError ?? "", /patch failed/);
    assert.equal(client.sent.length, 1);
    const commands = await listCommands(queuePath);
    assert.match(commands[0].statusNotifyError ?? "", /patch failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("processNextCodexCommand handles list-session without running Codex CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-worker-"));
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  const dbPath = join(dir, "state.sqlite");
  const client = new FakeFeishuClient();
  try {
    await seedCodexStateDb(dbPath);
    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        appId: "cli_test",
        appSecret: "secret_test",
        receiveId: "oc_test",
        enabled: true,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          enabled: true,
          queueDbPath: queuePath
        },
        codex: {
          ...DEFAULT_CONFIG.codex,
          enabled: true,
          stateDbPath: dbPath,
          sessionListLimit: 2
        }
      }),
      "utf8"
    );
    await enqueueCommand(
      {
        text: "list-session",
        rawText: "list-session",
        messageId: "om_list",
        chatId: "oc_1",
        chatType: "group",
        sender: { openId: "ou_user" },
        createdAt: "1710000000000",
        sessionId: "session_new",
        sessionTitle: "最新会话",
        sessionCwd: "/tmp/new"
      },
      queuePath
    );

    const result = await processNextCodexCommand({ configPath, feishuClient: client });
    assert.equal(result.processed, true);
    assert.equal(result.control, "list-session");
    assert.equal(result.ackState, "done");
    assert.match(result.summary ?? "", /list-session <序号\|sessionId>/);
    assert.match(result.summary ?? "", /session_new/);
    assert.equal(client.sent.length, 1);
    assert.deepEqual(client.sent[0].receiver, { receiveIdType: "chat_id", receiveId: "oc_1" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("processNextCodexCommand handles current-session without running Codex CLI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-worker-"));
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  const dbPath = join(dir, "state.sqlite");
  const client = new FakeFeishuClient();
  try {
    await seedCodexStateDb(dbPath);
    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        appId: "cli_test",
        appSecret: "secret_test",
        receiveId: "oc_test",
        enabled: true,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          enabled: true,
          queueDbPath: queuePath
        },
        codex: {
          ...DEFAULT_CONFIG.codex,
          enabled: true,
          stateDbPath: dbPath,
          sessionId: "session_new",
          cwd: "/tmp/new",
          sessionListLimit: 2
        }
      }),
      "utf8"
    );
    await enqueueCommand(
      {
        text: "current-session",
        rawText: "current-session",
        messageId: "om_current",
        chatId: "oc_1",
        chatType: "group",
        sender: { openId: "ou_user" },
        createdAt: "1710000000000",
        sessionId: "session_new",
        sessionTitle: "最新会话",
        sessionCwd: "/tmp/new"
      },
      queuePath
    );

    const result = await processNextCodexCommand({ configPath, feishuClient: client });
    assert.equal(result.processed, true);
    assert.equal(result.control, "current-session");
    assert.equal(result.ackState, "done");
    assert.match(result.summary ?? "", /当前 Codex 会话/);
    assert.match(result.summary ?? "", /session_new/);
    assert.equal(client.sent.length, 1);
    assert.deepEqual(client.sent[0].receiver, { receiveIdType: "chat_id", receiveId: "oc_1" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("processNextCodexCommand selects a session with list-session index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-worker-"));
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  const dbPath = join(dir, "state.sqlite");
  const client = new FakeFeishuClient();
  try {
    await seedCodexStateDb(dbPath);
    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        appId: "cli_test",
        appSecret: "secret_test",
        receiveId: "oc_test",
        enabled: true,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          enabled: true,
          queueDbPath: queuePath
        },
        codex: {
          ...DEFAULT_CONFIG.codex,
          enabled: true,
          stateDbPath: dbPath,
          sessionListLimit: 2
        }
      }),
      "utf8"
    );
    await enqueueCommand(
      {
        text: "list-session 1",
        rawText: "list-session 1",
        messageId: "om_select",
        chatId: "oc_1",
        chatType: "group",
        sender: { openId: "ou_user" },
        createdAt: "1710000000000",
        sessionId: "session_new",
        sessionTitle: "最新会话",
        sessionCwd: "/tmp/new"
      },
      queuePath
    );

    const result = await processNextCodexCommand({ configPath, feishuClient: client });
    assert.equal(result.processed, true);
    assert.equal(result.control, "select-session");
    assert.equal(result.ackState, "done");
    assert.match(result.summary ?? "", /已介入 Codex 会话/);

    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(persisted.codex.sessionId, "session_new");
    assert.equal(persisted.codex.cwd, "/tmp/new");
    assert.equal(persisted.codex.useLast, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("processNextCodexCommand reports no-op when there is no pending command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-worker-"));
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          queueDbPath: queuePath
        }
      }),
      "utf8"
    );

    const result = await processNextCodexCommand({ configPath });
    assert.equal(result.processed, false);
    assert.match(result.reason ?? "", /no pending command/);
    assert.equal(result.queuePath, queuePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("processNextCodexCommand fails normal commands when codex adapter is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-worker-"));
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        appId: "cli_test",
        appSecret: "secret_test",
        receiveId: "oc_test",
        enabled: true,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          queueDbPath: queuePath
        }
      }),
      "utf8"
    );
    await enqueueCommand(
      {
        text: "继续执行测试",
        rawText: "继续执行测试",
        messageId: "om_disabled",
        chatId: "oc_1",
        chatType: "group",
        sender: { openId: "ou_user" },
        createdAt: "1710000000000",
        sessionId: "session_1",
        sessionTitle: "Session 1"
      },
      queuePath
    );

    const result = await processNextCodexCommand({ configPath, feishuClient: client });
    assert.equal(result.processed, true);
    assert.equal(result.ackState, "failed");
    assert.match(result.summary ?? "", /Codex CLI 未启用/);
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
insert into threads values ('session_old', '旧会话', '/tmp/old', 'cli', 1000, 900, 0, 'gpt-5', null, '', '旧需求');
insert into threads values ('session_new', '最新会话', '/tmp/new', 'vscode', 2000, 1000, 0, 'gpt-5', 'main', '', '新需求');
`
  ]);
}
