import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import { enqueueCommand, listCommands } from "../src/commandQueue.js";
import { buildFeishuCommandPrompt, processNextCodexCommand } from "../src/codexWorker.js";
import { FeishuClient } from "../src/feishuClient.js";
import type { BridgeConfig, ReceiveIdType } from "../src/types.js";

const execFileAsync = promisify(execFile);

class FakeFeishuClient extends FeishuClient {
  sent: Array<{
    config: BridgeConfig;
    receiver: { receiveIdType: ReceiveIdType; receiveId: string };
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
    attempts: 0
  });

  assert.match(prompt, /不要调用 feishu_notify/);
  assert.match(prompt, /外层 feishu-agent-bridge runtime 会自动/);
  assert.match(prompt, /回我一条消息，带代码块/);
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
    assert.match(result.summary ?? "", /list-session <序号>/);
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
