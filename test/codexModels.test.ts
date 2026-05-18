import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseCodexFeatureFlagEnabled,
  readCodexConfigSummary,
  readCodexGlobalModel,
  resolveCodexModelStatus
} from "../src/codexModels.js";

test("readCodexGlobalModel reads top-level Codex model only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-models-"));
  const configPath = join(dir, "config.toml");
  try {
    await writeFile(
      configPath,
      [
        "model = \"gpt-5.5\"",
        "model_reasoning_effort = \"xhigh\"",
        "",
        "[profiles.fast]",
        "model = \"gpt-5.4-mini\""
      ].join("\n"),
      "utf8"
    );

    assert.equal(await readCodexGlobalModel(configPath), "gpt-5.5");
    assert.deepEqual(await readCodexConfigSummary(configPath), {
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      fastModeEnabled: undefined
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readCodexConfigSummary reads configured fast mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-config-summary-"));
  const configPath = join(dir, "config.toml");
  try {
    await writeFile(
      configPath,
      [
        "model = \"gpt-5.5\"",
        "",
        "[features]",
        "fast_mode = false"
      ].join("\n"),
      "utf8"
    );

    assert.deepEqual(await readCodexConfigSummary(configPath), {
      model: "gpt-5.5",
      reasoningEffort: undefined,
      fastModeEnabled: false
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseCodexFeatureFlagEnabled reads the effective feature state", () => {
  assert.equal(parseCodexFeatureFlagEnabled([
    "feature_a under development false",
    "fast_mode stable true"
  ].join("\n"), "fast_mode"), true);
  assert.equal(parseCodexFeatureFlagEnabled("fast_mode stable false\n", "fast_mode"), false);
  assert.equal(parseCodexFeatureFlagEnabled("other stable true\n", "fast_mode"), undefined);
});

test("resolveCodexModelStatus prefers session override over bridge and global models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-codex-model-status-"));
  const configPath = join(dir, "config.toml");
  try {
    await writeFile(configPath, "model = \"gpt-5.5\"\nmodel_reasoning_effort = \"high\"\n", "utf8");
    assert.deepEqual(await resolveCodexModelStatus({
      sessionModel: "gpt-5.4-mini",
      bridgeModel: "gpt-5.4",
      codexConfigPath: configPath,
      codexFeaturesListOutput: "fast_mode stable true\n"
    }), {
      sessionModel: "gpt-5.4-mini",
      bridgeModel: "gpt-5.4",
      globalModel: "gpt-5.5",
      effectiveModel: "gpt-5.4-mini",
      reasoningEffort: "high",
      fastModeEnabled: true
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
