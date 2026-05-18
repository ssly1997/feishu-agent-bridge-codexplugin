import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  ackCommand,
  enqueueCommand,
  getNextCommand,
  listCommands,
  updateCommandStatusMetadata
} from "../src/commandQueue.js";
import { FeishuClient } from "../src/feishuClient.js";
import { CodexRuntimeScheduler } from "../src/runtimeScheduler.js";
import type { CodexCommandProcessResult } from "../src/codexWorker.js";
import type { BridgeConfig } from "../src/types.js";

class FakeFeishuClient extends FeishuClient {
  updates: Array<{ config: BridgeConfig; messageId: string; card: Record<string, unknown> }> = [];

  override async updateInteractiveMessage(
    config: BridgeConfig,
    messageId: string,
    card: unknown
  ): Promise<{ messageId?: string }> {
    this.updates.push({ config, messageId, card: card as Record<string, unknown> });
    return { messageId };
  }
}

test("runtime scheduler drains one session serially and coalesces duplicate wakeups", async () => {
  const calls: string[] = [];
  let processedCount = 0;
  const scheduler = new CodexRuntimeScheduler({
    processor: async (sessionId) => {
      calls.push(sessionId);
      processedCount += 1;
      return result(processedCount <= 2);
    }
  });

  const firstWake = scheduler.wake("session_a");
  const duplicateWake = scheduler.wake("session_a");
  assert.equal(firstWake, duplicateWake);

  await firstWake;
  assert.deepEqual(calls, ["session_a", "session_a", "session_a"]);
  assert.deepEqual(scheduler.getStatus().activeSessions, []);
});

test("runtime scheduler allows different sessions to run concurrently", async () => {
  const started: string[] = [];
  let releaseSessionA!: () => void;
  const sessionABlocked = new Promise<void>((resolve) => {
    releaseSessionA = resolve;
  });
  const scheduler = new CodexRuntimeScheduler({
    processor: async (sessionId) => {
      started.push(sessionId);
      if (sessionId === "session_a") {
        await sessionABlocked;
      }
      return result(false);
    }
  });

  const runA = scheduler.wake("session_a");
  await delay(0);
  const runB = scheduler.wake("session_b");
  await delay(0);

  assert.deepEqual(started, ["session_a", "session_b"]);
  assert.deepEqual(scheduler.getStatus().activeSessions, ["session_a"]);

  releaseSessionA();
  await Promise.all([runA, runB]);
  assert.deepEqual(scheduler.getStatus().activeSessions, []);
});

test("runtime scheduler logs processor errors and clears active sessions", async () => {
  const events: Record<string, unknown>[] = [];
  const scheduler = new CodexRuntimeScheduler({
    logger: (event) => {
      events.push(event);
    },
    processor: async () => {
      throw new Error("sqlite busy");
    }
  });

  await scheduler.wake("session_error");

  assert.deepEqual(scheduler.getStatus().activeSessions, []);
  assert.deepEqual(events, [
    {
      event: "session_error",
      sessionId: "session_error",
      error: "Error: sqlite busy"
    }
  ]);
});

test("runtime scheduler recovers stale blockers before waking pending sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-runtime-scheduler-recover-"));
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  const calls: string[] = [];
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          queueDbPath: queuePath
        },
        codex: {
          ...DEFAULT_CONFIG.codex,
          inProgressTimeoutMs: 1,
          inProgressRecovery: "mark_failed"
        }
      }),
      "utf8"
    );
    await enqueueCommand(makeCommand("om_blocker", "session_recover"), queuePath);
    await enqueueCommand(makeCommand("om_pending", "session_recover"), queuePath);
    const blocker = await getNextCommand(queuePath, { sessionId: "session_recover" });
    assert.equal(blocker?.messageId, "om_blocker");

    await delay(5);
    const scheduler = new CodexRuntimeScheduler({
      configPath,
      processor: async (sessionId) => {
        calls.push(sessionId);
        const command = await getNextCommand(queuePath, { sessionId });
        if (!command) return result(false);
        await ackCommand(command.id, "done", queuePath, "ok");
        return {
          ...result(true),
          command,
          ackState: "done"
        };
      }
    });

    const recoveryRun = scheduler.recoverAndWakePending();
    assert.equal(scheduler.getStatus().recoveryRunning, true);
    const recovered = await recoveryRun;
    await scheduler.waitForIdle();

    assert.equal(recovered, 1);
    assert.equal(scheduler.getStatus().recoveryRunning, false);
    assert.equal(scheduler.getStatus().lastRecoveredCount, 1);
    assert.match(scheduler.getStatus().lastRecoveryAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(scheduler.getStatus().lastRecoveryError, undefined);
    assert.deepEqual(calls, ["session_recover", "session_recover"]);
    const commands = await listCommands(queuePath);
    assert.equal(commands.find((command) => command.messageId === "om_blocker")?.state, "failed");
    assert.equal(commands.find((command) => command.messageId === "om_pending")?.state, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime scheduler updates status cards for recovered failed commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-runtime-scheduler-status-recover-"));
  const configPath = join(dir, "config.json");
  const queuePath = join(dir, "commands.db");
  const client = new FakeFeishuClient();
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        ...DEFAULT_CONFIG,
        enabled: true,
        inbound: {
          ...DEFAULT_CONFIG.inbound,
          queueDbPath: queuePath
        },
        codex: {
          ...DEFAULT_CONFIG.codex,
          inProgressTimeoutMs: 1,
          inProgressRecovery: "mark_failed"
        }
      }),
      "utf8"
    );
    const { command } = await enqueueCommand(makeCommand("om_status_recover", "session_recover"), queuePath);
    await updateCommandStatusMetadata(command.id, queuePath, {
      statusMessageId: "om_status_card"
    });
    const claimed = await getNextCommand(queuePath, { sessionId: "session_recover" });
    assert.equal(claimed?.messageId, "om_status_recover");

    await delay(5);
    const scheduler = new CodexRuntimeScheduler({
      configPath,
      feishuClient: client,
      processor: async () => result(false)
    });

    const recovered = await scheduler.recoverAndWakePending({
      summary: "Runtime stopped before command completed."
    });

    assert.equal(recovered, 1);
    assert.equal(client.updates.length, 1);
    assert.equal(client.updates[0].messageId, "om_status_card");
    assert.match(JSON.stringify(client.updates[0].card), /Codex task failed/);
    const commands = await listCommands(queuePath);
    const recoveredCommand = commands.find((item) => item.id === command.id);
    assert.equal(recoveredCommand?.state, "failed");
    assert.equal(recoveredCommand?.statusNotifyError, undefined);
    assert.equal(recoveredCommand?.statusSummary, "Runtime stopped before command completed.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function result(processed: boolean): CodexCommandProcessResult {
  return {
    processed,
    queuePath: "/tmp/commands.db"
  };
}

function makeCommand(messageId: string, sessionId: string) {
  return {
    text: `task ${messageId}`,
    rawText: `task ${messageId}`,
    messageId,
    chatId: "oc_test",
    chatType: "group",
    sender: { openId: "ou_test" },
    createdAt: "1710000000000",
    sessionId,
    sessionTitle: `Session ${sessionId}`
  };
}
