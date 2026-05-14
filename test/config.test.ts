import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_CONFIG,
  ConfigError,
  getConfigReadiness,
  loadConfig,
  sanitizeConfig,
  saveConfigPatch
} from "../src/config.js";

test("loadConfig returns defaults when the config file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-config-"));
  try {
    const config = await loadConfig(join(dir, "missing.json"));
    assert.deepEqual(config, DEFAULT_CONFIG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveConfigPatch creates a config file and preserves existing fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-config-"));
  const configPath = join(dir, "config.json");
  try {
    await saveConfigPatch(
      {
        appId: "cli_1234567890",
        appSecret: "secret_1234567890",
        receiveId: "oc_1234567890",
        enabled: true
      },
      configPath
    );
    const config = await saveConfigPatch({ enabled: false }, configPath);
    assert.equal(config.enabled, false);
    assert.equal(config.appId, "cli_1234567890");
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).receiveIdType, "chat_id");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sanitizeConfig masks secrets and receiver ids", () => {
  const sanitized = sanitizeConfig({
    ...DEFAULT_CONFIG,
    appId: "cli_abcdefghijklmnop",
    appSecret: "secret_abcdefghijklmnop",
    receiveId: "oc_abcdefghijklmnop"
  });
  assert.equal(sanitized.appId, "cli_****mnop");
  assert.equal(sanitized.appSecret, "secr****mnop");
  assert.equal(sanitized.receiveId, "oc_a****mnop");
});

test("loadConfig rejects invalid receiveIdType", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-config-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ receiveIdType: "user_id" }), "utf8");
    await assert.rejects(loadConfig(configPath), ConfigError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getConfigReadiness reports required field presence", () => {
  assert.deepEqual(
    getConfigReadiness({
      ...DEFAULT_CONFIG,
      appId: "cli_x",
      appSecret: "secret_x"
    }),
    {
      enabled: false,
      hasAppId: true,
      hasAppSecret: true,
      hasReceiveId: false,
      inboundEnabled: false,
      codexEnabled: false,
      codexHasResumeTarget: false
    }
  );
});

test("saveConfigPatch merges codex config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-config-"));
  const configPath = join(dir, "config.json");
  try {
    const first = await saveConfigPatch(
      {
        codex: {
          enabled: true,
          sessionId: "019e249d-96bd-75d3-b604-16a0198a4649",
          cwd: "/tmp/project"
        }
      },
      configPath
    );
    assert.equal(first.codex.enabled, true);
    assert.equal(first.codex.command, "codex");
    assert.equal(first.codex.sessionId, "019e249d-96bd-75d3-b604-16a0198a4649");

    const second = await saveConfigPatch({ codex: { enabled: false } }, configPath);
    assert.equal(second.codex.enabled, false);
    assert.equal(second.codex.sessionId, "019e249d-96bd-75d3-b604-16a0198a4649");
    assert.equal(second.codex.cwd, "/tmp/project");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
