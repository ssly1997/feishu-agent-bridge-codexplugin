import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ackCommand,
  enqueueCommand,
  getCommandQueueStats,
  getNextCommand,
  getPendingSessionIds,
  initializeCommandQueue,
  listCommands,
  recoverInProgressCommands
} from "../src/commandQueue.js";

test("command queue deduplicates Feishu message ids and tracks state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-queue-"));
  const queuePath = join(dir, "commands.json");
  try {
    const first = await enqueueCommand(
      {
        text: "继续跑测试",
        rawText: "继续跑测试",
        messageId: "om_same",
        chatId: "oc_test",
        chatType: "group",
        sender: { openId: "ou_sender" },
        createdAt: "1710000000000",
        sessionId: "session_1",
        sessionTitle: "Session 1"
      },
      queuePath
    );
    const duplicate = await enqueueCommand(
      {
        text: "继续跑测试",
        rawText: "继续跑测试",
        messageId: "om_same",
        chatId: "oc_test",
        chatType: "group",
        sender: { openId: "ou_sender" },
        createdAt: "1710000000000",
        sessionId: "session_1",
        sessionTitle: "Session 1"
      },
      queuePath
    );

    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(first.command.id, duplicate.command.id);

    const claimed = await getNextCommand(queuePath);
    assert.equal(claimed?.state, "in_progress");
    assert.equal(claimed?.attempts, 1);

    const done = await ackCommand(first.command.id, "done", queuePath, "完成");
    assert.equal(done?.state, "done");
    assert.equal(done?.resultSummary, "完成");

    const stats = await getCommandQueueStats(queuePath);
    assert.equal(stats.total, 1);
    assert.equal(stats.done, 1);
    assert.equal((await listCommands(queuePath, { state: "done" })).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command queue migrates legacy JSON commands into SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-queue-migrate-"));
  const queuePath = join(dir, "commands.db");
  const legacyPath = join(dir, "commands.json");
  try {
    await writeFile(
      legacyPath,
      JSON.stringify([
        {
          id: "fcmd_legacy",
          state: "done",
          text: "旧任务",
          rawText: "旧任务",
          messageId: "om_legacy",
          chatId: "oc_test",
          sender: { openId: "ou_sender" },
          source: "feishu",
          receivedAt: "2026-05-15T00:00:00.000Z",
          attempts: 1,
          resultSummary: "完成"
        }
      ]),
      "utf8"
    );

    await initializeCommandQueue(queuePath, { legacyJsonPath: legacyPath });
    await initializeCommandQueue(queuePath, { legacyJsonPath: legacyPath });

    const commands = await listCommands(queuePath);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].messageId, "om_legacy");
    assert.equal(commands[0].state, "done");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command queue claims one active command per session and keeps session stats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-queue-session-"));
  const queuePath = join(dir, "commands.db");
  try {
    await enqueueCommand(makeCommand("om_a1", "session_a"), queuePath);
    await enqueueCommand(makeCommand("om_a2", "session_a"), queuePath);
    await enqueueCommand(makeCommand("om_b1", "session_b"), queuePath);

    const firstA = await getNextCommand(queuePath, { sessionId: "session_a" });
    const blockedA = await getNextCommand(queuePath, { sessionId: "session_a" });
    const firstB = await getNextCommand(queuePath, { sessionId: "session_b" });

    assert.equal(firstA?.messageId, "om_a1");
    assert.equal(blockedA, undefined);
    assert.equal(firstB?.messageId, "om_b1");

    await ackCommand(firstA?.id ?? "", "done", queuePath, "A1 done");
    const secondA = await getNextCommand(queuePath, { sessionId: "session_a" });
    assert.equal(secondA?.messageId, "om_a2");

    const stats = await getCommandQueueStats(queuePath);
    assert.equal(stats.sessions.find((item) => item.sessionId === "session_a")?.inProgress, 1);
    assert.deepEqual((await getPendingSessionIds(queuePath)), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("command queue recovers stale in_progress commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-queue-recover-"));
  const queuePath = join(dir, "commands.db");
  try {
    await enqueueCommand(makeCommand("om_recover", "session_recover"), queuePath);
    const claimed = await getNextCommand(queuePath, { sessionId: "session_recover" });
    assert.equal(claimed?.state, "in_progress");

    const recovered = await recoverInProgressCommands(queuePath, {
      timeoutMs: 1,
      recovery: "reset_pending",
      now: () => Date.parse(claimed?.claimedAt ?? "2026-05-15T00:00:00.000Z") + 10
    });
    assert.equal(recovered, 1);

    const claimedAgain = await getNextCommand(queuePath, { sessionId: "session_recover" });
    assert.equal(claimedAgain?.messageId, "om_recover");
    assert.equal(claimedAgain?.attempts, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeCommand(messageId: string, sessionId: string) {
  return {
    text: `task ${messageId}`,
    rawText: `task ${messageId}`,
    messageId,
    chatId: "oc_test",
    chatType: "group",
    sender: { openId: "ou_sender" },
    createdAt: "1710000000000",
    sessionId,
    sessionTitle: `Session ${sessionId}`
  };
}
