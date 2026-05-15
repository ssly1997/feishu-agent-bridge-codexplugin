import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  progressSummaryFromJsonLine,
  runCodexNewSession,
  runCodexResume
} from "../src/codexCli.js";
import { DEFAULT_CONFIG } from "../src/config.js";

test("buildCodexResumeArgs targets an explicit session id", () => {
  assert.deepEqual(
    buildCodexResumeArgs(
      {
        ...DEFAULT_CONFIG.codex,
        enabled: true,
        sessionId: "019e249d-96bd-75d3-b604-16a0198a4649",
        model: "gpt-5.2",
        profile: "full_access",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        extraArgs: ["--skip-git-repo-check"]
      },
      "/tmp/last.txt"
    ),
    [
      "exec",
      "--model",
      "gpt-5.2",
      "--profile",
      "full_access",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "resume",
      "--json",
      "-o",
      "/tmp/last.txt",
      "--skip-git-repo-check",
      "019e249d-96bd-75d3-b604-16a0198a4649",
      "-"
    ]
  );
});

test("buildCodexExecArgs starts a new session in a cwd", () => {
  assert.deepEqual(
    buildCodexExecArgs(
      {
        ...DEFAULT_CONFIG.codex,
        enabled: true,
        model: "gpt-5.2",
        profile: "full_access",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        extraArgs: ["--skip-git-repo-check"]
      },
      "/tmp/new-last.txt",
      "/tmp/project"
    ),
    [
      "exec",
      "--model",
      "gpt-5.2",
      "--profile",
      "full_access",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--cd",
      "/tmp/project",
      "--json",
      "-o",
      "/tmp/new-last.txt",
      "--skip-git-repo-check",
      "-"
    ]
  );
});

test("runCodexResume writes prompt to codex exec resume and reads last message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-cli-"));
  const scriptPath = join(dir, "fake-codex.mjs");
  const outputPath = join(dir, "last-message.txt");
  try {
    await writeFile(
      scriptPath,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("-o") + 1];
const prompt = readFileSync(0, "utf8").trim();
writeFileSync(outputPath, "Codex saw: " + prompt);
console.log(JSON.stringify({ ok: true, args }));
`,
      "utf8"
    );
    await chmod(scriptPath, 0o755);

    const result = await runCodexResume("继续执行测试", {
      ...DEFAULT_CONFIG.codex,
      enabled: true,
      command: scriptPath,
      sessionId: "session_1",
      timeoutMs: 5000
    }, { outputPath });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /"ok":true/);
    assert.equal(result.lastMessage, "Codex saw: 继续执行测试");
    assert.deepEqual(result.args.slice(-2), ["session_1", "-"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexNewSession writes prompt to codex exec with project cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-cli-new-"));
  const scriptPath = join(dir, "fake-codex.mjs");
  const outputPath = join(dir, "last-message.txt");
  const argsPath = join(dir, "args.json");
  try {
    await writeFile(
      scriptPath,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("-o") + 1];
const prompt = readFileSync(0, "utf8").trim();
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify({ args, cwd: process.cwd() }));
writeFileSync(outputPath, "New session saw: " + prompt);
`,
      "utf8"
    );
    await chmod(scriptPath, 0o755);

    const result = await runCodexNewSession("初始化新会话", {
      ...DEFAULT_CONFIG.codex,
      enabled: true,
      command: scriptPath,
      timeoutMs: 5000
    }, {
      outputPath,
      cwd: dir
    });

    assert.equal(result.ok, true);
    assert.equal(result.lastMessage, "New session saw: 初始化新会话");
    assert.equal(result.cwd, dir);
    const recorded = JSON.parse(await readFile(argsPath, "utf8"));
    assert.equal(recorded.cwd, await realpath(dir));
    assert.deepEqual(recorded.args.slice(-2), ["--skip-git-repo-check", "-"]);
    assert.ok(recorded.args.includes("--cd"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCodexResume extracts public JSON progress without reasoning or tool arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-cli-progress-"));
  const scriptPath = join(dir, "fake-codex.mjs");
  const outputPath = join(dir, "last-message.txt");
  const progress: string[] = [];
  try {
    await writeFile(
      scriptPath,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("-o") + 1];
readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: "internal" } }));
console.log(JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{\\\\\\"cmd\\\\\\":\\\\\\"secret\\\\\\"}" } }));
console.log(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "正在跑测试" } }));
writeFileSync(outputPath, "done");
`,
      "utf8"
    );
    await chmod(scriptPath, 0o755);

    const result = await runCodexResume("继续执行测试", {
      ...DEFAULT_CONFIG.codex,
      enabled: true,
      command: scriptPath,
      sessionId: "session_1",
      timeoutMs: 5000
    }, {
      outputPath,
      onProgress: (event) => progress.push(event.summary)
    });

    assert.equal(result.ok, true);
    assert.deepEqual(progress, ["正在调用工具：exec_command", "进展：正在跑测试"]);
    assert.doesNotMatch(progress.join("\n"), /secret|internal/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("progressSummaryFromJsonLine ignores non-public Codex events", () => {
  assert.equal(
    progressSummaryFromJsonLine(JSON.stringify({ type: "function_call", name: "exec_command" })),
    "正在调用工具：exec_command"
  );
  assert.equal(
    progressSummaryFromJsonLine(JSON.stringify({
      type: "agent_message",
      phase: "commentary",
      message: "继续检查"
    })),
    "进展：继续检查"
  );
  assert.equal(
    progressSummaryFromJsonLine(JSON.stringify({ type: "response_item", payload: { type: "reasoning" } })),
    undefined
  );
  assert.equal(progressSummaryFromJsonLine("not json"), undefined);
});
