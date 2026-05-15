import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexSessionListCard,
  buildSelectSessionActionValue,
  parseSelectSessionActionValue
} from "../src/sessionCard.js";

test("buildCodexSessionListCard renders session buttons", () => {
  const card = buildCodexSessionListCard(
    [
      {
        id: "session_1",
        title: "当前会话",
        cwd: "/tmp/project",
        source: "vscode",
        updatedAt: 1778747553,
        createdAt: 1778747000,
        gitBranch: "main"
      }
    ],
    10
  );

  const text = JSON.stringify(card);
  assert.match(text, /选择要介入的 Codex 会话/);
  assert.equal(card.schema, "2.0");
  assert.match(text, /介入 #1/);
  assert.match(text, /select_codex_session/);
  assert.match(text, /session_1/);
  assert.match(text, /behaviors/);
  assert.match(text, /callback/);
});

test("buildCodexSessionListCard can render an explicit unbound notice", () => {
  const card = buildCodexSessionListCard(
    [],
    10,
    {
      title: "当前群尚未绑定 Codex 会话",
      notice: "这条任务暂未入队。请先选择一个 Codex 会话。"
    }
  );

  const text = JSON.stringify(card);
  assert.match(text, /当前群尚未绑定 Codex 会话/);
  assert.match(text, /这条任务暂未入队/);
  assert.match(text, /没有找到可用的 Codex 会话/);
});

test("parseSelectSessionActionValue accepts only bridge-owned actions", () => {
  assert.equal(
    parseSelectSessionActionValue(buildSelectSessionActionValue("session_1")),
    "session_1"
  );
  assert.equal(
    parseSelectSessionActionValue(JSON.stringify(buildSelectSessionActionValue("session_1"))),
    "session_1"
  );
  assert.equal(parseSelectSessionActionValue({ action: "select_codex_session" }), undefined);
  assert.equal(
    parseSelectSessionActionValue({
      bridge: "other",
      action: "select_codex_session",
      sessionId: "session_1"
    }),
    undefined
  );
});
