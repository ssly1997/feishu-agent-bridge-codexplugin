import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCodexResumeArgs, runCodexResume } from "../src/codexCli.js";
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
