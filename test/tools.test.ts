import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import { enqueueCommand } from "../src/commandQueue.js";
import { FeishuClient } from "../src/feishuClient.js";
import { listenerRuntimeStatusPath } from "../src/listenerRuntime.js";
import { createToolRegistry } from "../src/tools.js";
import type { BridgeConfig } from "../src/types.js";

class FakeFeishuClient extends FeishuClient {
  sent: Array<{ config: BridgeConfig; card: Record<string, unknown> }> = [];

  override async sendInteractiveMessage(
    config: BridgeConfig,
    card: unknown
  ): Promise<{ messageId?: string }> {
    this.sent.push({ config, card: card as Record<string, unknown> });
    return { messageId: "om_fake" };
  }
}

test("tool registry exposes the expected generic tool names", () => {
  const registry = createToolRegistry();
  const names = registry.listTools().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "feishu_ack_command",
    "feishu_command_status",
    "feishu_list_commands",
    "feishu_next_command",
    "feishu_notify",
    "feishu_notify_task_result",
    "feishu_send_test",
    "feishu_set_enabled",
    "feishu_set_inbound_enabled",
    "feishu_start_command_listener",
    "feishu_status",
    "feishu_stop_command_listener"
  ]);
});

test("feishu_notify skips sends when disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-tools-"));
  const configPath = join(dir, "config.json");
  const client = new FakeFeishuClient();
  try {
    await writeFile(configPath, JSON.stringify({ ...DEFAULT_CONFIG, enabled: false }), "utf8");
    const registry = createToolRegistry({ configPath, feishuClient: client });
    const result = await registry.callTool("feishu_notify", { summary: "hello" });

    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /skipped/);
    assert.equal(client.sent.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("feishu_notify_task_result validates status and sends a card", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-tools-"));
  const configPath = join(dir, "config.json");
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
        codex: {
          ...DEFAULT_CONFIG.codex,
          sessionId: "019e2142-8030-7353-bb1b-0f11ad3e82fb",
          sessionTitle: "看一下 live-socket mcp能识别到了吗"
        }
      }),
      "utf8"
    );
    const registry = createToolRegistry({ configPath, feishuClient: client });
    const result = await registry.callTool("feishu_notify_task_result", {
      status: "success",
      summary: "done",
      source: "test"
    });

    assert.match(result.content[0].text, /sent/);
    assert.equal(client.sent.length, 1);
    const cardText = JSON.stringify(client.sent[0].card);
    assert.match(cardText, /done/);
    assert.match(cardText, /Codex session.*\(unbound\)/);
    assert.doesNotMatch(cardText, /live-socket/);
    assert.doesNotMatch(cardText, /#019e2142/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("feishu_status returns sanitized config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-tools-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        appId: "cli_abcdefghijklmnop",
        appSecret: "secret_abcdefghijklmnop",
        receiveId: "oc_abcdefghijklmnop",
        enabled: true
      }),
      "utf8"
    );
    const registry = createToolRegistry({ configPath, feishuClient: new FakeFeishuClient() });
    const result = await registry.callTool("feishu_status", {});

    assert.match(result.content[0].text, /cli_\*\*\*\*mnop/);
    assert.doesNotMatch(result.content[0].text, /secret_abcdefghijklmnop/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("feishu_set_enabled persists the local enabled switch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-tools-"));
  const configPath = join(dir, "config.json");
  try {
    const registry = createToolRegistry({ configPath, feishuClient: new FakeFeishuClient() });
    const result = await registry.callTool("feishu_set_enabled", { enabled: true });
    assert.match(result.content[0].text, /enabled=true/);

    const status = await registry.callTool("feishu_status", {});
    assert.match(status.content[0].text, /"enabled": true/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inbound command tools read, claim, and acknowledge queued commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-tools-"));
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          enabled: true,
          queueDbPath: queuePath
        }
      }),
      "utf8"
    );
    await enqueueCommand(
      {
        text: "继续执行测试",
        rawText: "<at user_id=\"ou_bot\">bot</at> 继续执行测试",
        messageId: "om_1",
        chatId: "oc_1",
        chatType: "group",
        sender: { openId: "ou_user" },
        createdAt: "1710000000000",
        sessionId: "session_1",
        sessionTitle: "Session 1"
      },
      queuePath
    );

    const registry = createToolRegistry({ configPath, feishuClient: new FakeFeishuClient() });
    const status = await registry.callTool("feishu_command_status", {});
    assert.match(status.content[0].text, /"pending": 1/);

    const next = await registry.callTool("feishu_next_command", {});
    const nextPayload = JSON.parse(next.content[0].text);
    assert.equal(nextPayload.claimed, true);
    assert.equal(nextPayload.command.text, "继续执行测试");
    assert.equal(nextPayload.command.state, "in_progress");

    const ack = await registry.callTool("feishu_ack_command", {
      id: nextPayload.command.id,
      status: "done",
      summary: "已继续执行"
    });
    const ackPayload = JSON.parse(ack.content[0].text);
    assert.equal(ackPayload.command.state, "done");
    assert.equal(ackPayload.command.resultSummary, "已继续执行");

    const list = await registry.callTool("feishu_list_commands", { state: "done", limit: 1 });
    assert.equal(JSON.parse(list.content[0].text).commands.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("feishu_set_inbound_enabled persists the inbound switch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-tools-"));
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
    const registry = createToolRegistry({ configPath, feishuClient: new FakeFeishuClient() });
    const result = await registry.callTool("feishu_set_inbound_enabled", { enabled: true });
    assert.match(result.content[0].text, /inbound.enabled=true/);

    const status = await registry.callTool("feishu_command_status", {});
    assert.match(status.content[0].text, /"inboundEnabled": true/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("feishu_command_status reports a standalone screen listener heartbeat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-tools-"));
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          enabled: true,
          queueDbPath: queuePath
        }
      }),
      "utf8"
    );
    await writeFile(
      listenerRuntimeStatusPath(configPath),
      JSON.stringify({
        managedBy: "standalone",
        pid: process.pid,
        processAlive: true,
        updatedAt: new Date().toISOString(),
        runtimeStatusPath: listenerRuntimeStatusPath(configPath),
        running: true,
        ready: true,
        configPath,
        queuePath,
        startedAt: "2026-05-15T00:00:00.000Z",
        enqueuedCount: 3,
        ignoredCount: 1,
        scheduler: {
          activeSessions: ["session_a"],
          recoveryRunning: false,
          lastRecoveryAt: "2026-05-15T00:01:00.000Z",
          lastRecoveredCount: 2
        }
      }),
      "utf8"
    );

    const registry = createToolRegistry({ configPath, feishuClient: new FakeFeishuClient() });
    const status = await registry.callTool("feishu_command_status", {});
    const payload = JSON.parse(status.content[0].text);

    assert.equal(payload.listener.running, true);
    assert.equal(payload.listener.ready, true);
    assert.equal(payload.listener.managedBy, "standalone");
    assert.equal(payload.listener.pid, process.pid);
    assert.equal(payload.listener.queuePath, queuePath);
    assert.equal(payload.listener.enqueuedCount, 3);
    assert.deepEqual(payload.listener.scheduler, {
      activeSessions: ["session_a"],
      recoveryRunning: false,
      lastRecoveryAt: "2026-05-15T00:01:00.000Z",
      lastRecoveredCount: 2
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listener start and stop tools point to the standalone runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-tools-"));
  const configPath = join(dir, "config.json");
  try {
    const registry = createToolRegistry({ configPath, feishuClient: new FakeFeishuClient() });
    const start = await registry.callTool("feishu_start_command_listener", {});
    const stop = await registry.callTool("feishu_stop_command_listener", {});
    const startPayload = JSON.parse(start.content[0].text);
    const stopPayload = JSON.parse(stop.content[0].text);

    assert.equal(startPayload.managedBy, "runtime");
    assert.match(startPayload.command, /runtime\.js/);
    assert.match(startPayload.screenCommand, /fab-runtime/);
    assert.equal(stopPayload.managedBy, "runtime");
    assert.match(stopPayload.message, /fab-runtime/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
