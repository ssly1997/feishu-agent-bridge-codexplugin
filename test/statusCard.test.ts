import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.js";
import { buildCommandStatusCard } from "../src/statusCard.js";
import type { AgentCommand } from "../src/types.js";

test("done status card keeps actionable conclusion details", () => {
  const command: AgentCommand = {
    id: "fcmd_detail",
    state: "done",
    text: "实现功能面板",
    rawText: "实现功能面板",
    messageId: "om_detail",
    chatId: "oc_detail",
    sender: {},
    source: "feishu",
    receivedAt: "2026-05-18T07:41:14.000Z",
    claimedAt: "2026-05-18T07:41:15.000Z",
    completedAt: "2026-05-18T07:48:18.000Z",
    attempts: 1,
    sessionId: "session_detail",
    sessionTitle: "继续优化插件",
    sessionCwd: "/tmp/feishu-agent-bridge",
    attachments: [{
      type: "image",
      path: "/tmp/input.png",
      source: "feishu",
      messageId: "om_image",
      resourceKey: "img_key"
    }]
  };

  const card = buildCommandStatusCard(command, DEFAULT_CONFIG, {
    phase: "done",
    durationMs: 424_000,
    exitCode: 0,
    outputPath: "/tmp/fcmd_detail.txt",
    resultSummary: [
      "可以实现，已在分支 codex/lfc/feature-panel-card 做完。",
      "",
      "触发方式：在飞书群里发送 `@机器人 功能` 或 `@机器人 features`。",
      "主要改动：",
      "- 新增功能面板卡片。",
      "- 按钮映射到 status/status-full/list-session。",
      "验证：pnpm test 通过。"
    ].join("\n")
  });

  const text = JSON.stringify(card);
  assert.match(text, /结论：\\n可以实现/);
  assert.match(text, /触发方式.*@机器人 功能/);
  assert.match(text, /status\/status-full\/list-session/);
  assert.match(text, /验证：pnpm test 通过/);
  assert.match(text, /总耗时：7m 4s/);
  assert.doesNotMatch(text, /收到时间/);
  assert.doesNotMatch(text, /认领时间/);
  assert.doesNotMatch(text, /完成时间/);
  assert.doesNotMatch(text, /尝试次数/);
  assert.doesNotMatch(text, /退出码/);
  assert.doesNotMatch(text, /附件：/);
  assert.doesNotMatch(text, /Artifacts/);
  assert.doesNotMatch(text, /fcmd_detail/);
});
