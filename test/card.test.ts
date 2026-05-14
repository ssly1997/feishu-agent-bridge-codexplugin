import test from "node:test";
import assert from "node:assert/strict";
import { buildNotificationCard, normalizeStatus } from "../src/card.js";
import { DEFAULT_CONFIG } from "../src/config.js";

test("buildNotificationCard creates a Feishu interactive card payload", () => {
  const card = buildNotificationCard(
    {
      source: "ci",
      title: "Build finished",
      status: "success",
      summary: "All checks passed.\n\n```bash\ncorepack pnpm test\n```",
      cwd: "/tmp/project",
      artifacts: ["/tmp/project/report.txt"],
      links: [{ label: "Run", url: "https://example.com/run/1" }],
      nextSteps: ["Ship it"],
      metadata: { duration: "12s" }
    },
    {
      ...DEFAULT_CONFIG,
      codex: {
        ...DEFAULT_CONFIG.codex,
        sessionId: "019e249d-96bd-75d3-b604-16a0198a4649",
        sessionTitle: "Build investigation"
      }
    }
  );

  assert.equal(card.header.template, "green");
  assert.equal(card.header.title.content, "Build finished");
  assert.equal(card.schema, "2.0");
  assert.equal(card.config.wide_screen_mode, true);
  assert.ok(card.body.elements.length >= 6);
  assert.match(JSON.stringify(card), /Project.*project/);
  assert.match(JSON.stringify(card), /Codex session.*Build investigation.*#019e249d/);
  assert.doesNotMatch(JSON.stringify(card), /019e249d-96bd-75d3-b604-16a0198a4649/);
  assert.match(JSON.stringify(card), /All checks passed/);
  assert.match(JSON.stringify(card), /https:\/\/example.com\/run\/1/);
  assert.match(JSON.stringify(card), /Working directory/);
  assert.match(JSON.stringify(card), /Next steps/);
  assert.match(JSON.stringify(card), /1\. Ship it/);
  assert.doesNotMatch(JSON.stringify(card), /Metadata/);
  assert.doesNotMatch(JSON.stringify(card), /tag":"column_set/);
  assert.doesNotMatch(JSON.stringify(card), /tag":"note/);
  assert.match(JSON.stringify(card), /```bash/);
  assert.doesNotMatch(JSON.stringify(card), /lark_md/);
  assert.doesNotMatch(JSON.stringify(card), /- Ship it/);
});

test("buildNotificationCard falls back to configured Codex context", () => {
  const card = buildNotificationCard(
    {
      title: "Task finished",
      summary: "Done."
    },
    {
      ...DEFAULT_CONFIG,
      codex: {
        ...DEFAULT_CONFIG.codex,
        cwd: "/Users/example/work/project-a",
        sessionId: "019e249d-96bd-75d3-b604-16a0198a4649"
      }
    }
  );

  const text = JSON.stringify(card);
  assert.match(text, /Project.*project-a/);
  assert.match(text, /Codex session.*#019e249d/);
  assert.doesNotMatch(text, /019e249d-96bd-75d3-b604-16a0198a4649/);
  assert.match(text, /\/Users\/example\/work\/project-a/);
});

test("normalizeStatus falls back to info for unknown values", () => {
  assert.equal(normalizeStatus("failed"), "failed");
  assert.equal(normalizeStatus("unknown"), "info");
  assert.equal(normalizeStatus(undefined), "info");
});

test("buildNotificationCard truncates long summaries", () => {
  const card = buildNotificationCard(
    {
      title: "Long output",
      summary: "x".repeat(4000)
    },
    DEFAULT_CONFIG
  );
  assert.match(JSON.stringify(card), /truncated/);
});
