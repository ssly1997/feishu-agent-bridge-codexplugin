import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ackCommand,
  enqueueCommand,
  getCommandQueueStats,
  getNextCommand,
  listCommands
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
        createdAt: "1710000000000"
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
        createdAt: "1710000000000"
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
