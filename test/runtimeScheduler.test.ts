import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { CodexRuntimeScheduler } from "../src/runtimeScheduler.js";
import type { CodexCommandProcessResult } from "../src/codexWorker.js";

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

function result(processed: boolean): CodexCommandProcessResult {
  return {
    processed,
    queuePath: "/tmp/commands.db"
  };
}
