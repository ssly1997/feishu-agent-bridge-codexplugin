import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CodexModelOption {
  id: string;
  label: string;
  description: string;
}

export interface CodexModelStatus {
  sessionModel?: string;
  bridgeModel?: string;
  globalModel?: string;
  effectiveModel?: string;
  reasoningEffort?: string;
  fastModeEnabled?: boolean;
}

export const CODEX_MODEL_OPTIONS: readonly CodexModelOption[] = [
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    description: "复杂编码、设计和长任务的默认主力模型。"
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    description: "日常代码修改和分析。"
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    description: "轻量、低成本、快速响应。"
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    description: "偏代码实现和修复的稳定选择。"
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    description: "超快代码任务。"
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    description: "专业工作和长任务的稳定模型。"
  }
];

export function isKnownCodexModel(model: string): boolean {
  return CODEX_MODEL_OPTIONS.some((option) => option.id === model);
}

export function getCodexModelOptions(currentModel: string | undefined): CodexModelOption[] {
  if (!currentModel || isKnownCodexModel(currentModel)) {
    return [...CODEX_MODEL_OPTIONS];
  }
  return [
    {
      id: currentModel,
      label: currentModel,
      description: "当前配置中的自定义模型。"
    },
    ...CODEX_MODEL_OPTIONS
  ];
}

export async function resolveCodexModelStatus(
  options: {
    sessionModel?: string;
    bridgeModel?: string;
    codexConfigPath?: string;
    codexCommand?: string;
    codexFeaturesListOutput?: string;
  } = {}
): Promise<CodexModelStatus> {
  const config = await readCodexConfigSummary(options.codexConfigPath);
  const fastModeEnabled = await resolveCodexFastModeEnabled({
    codexCommand: options.codexCommand,
    featuresListOutput: options.codexFeaturesListOutput,
    configFastModeEnabled: config.fastModeEnabled
  });
  return {
    sessionModel: options.sessionModel,
    bridgeModel: options.bridgeModel,
    globalModel: config.model,
    effectiveModel: options.sessionModel || options.bridgeModel || config.model,
    reasoningEffort: config.reasoningEffort,
    fastModeEnabled
  };
}

export async function readCodexGlobalModel(configPath = join(homedir(), ".codex", "config.toml")): Promise<string | undefined> {
  return (await readCodexConfigSummary(configPath)).model;
}

export interface CodexConfigSummary {
  model?: string;
  reasoningEffort?: string;
  fastModeEnabled?: boolean;
}

export async function readCodexConfigSummary(configPath = join(homedir(), ".codex", "config.toml")): Promise<CodexConfigSummary> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return {};
  }

  const topLevel = sectionBody(raw);
  const features = sectionBody(raw, "features");
  return {
    model: readTomlStringValue(topLevel, "model"),
    reasoningEffort: readTomlStringValue(topLevel, "model_reasoning_effort"),
    fastModeEnabled: readTomlBooleanValue(features, "fast_mode")
  };
}

export function parseCodexFeatureFlagEnabled(output: string, flagName: string): boolean | undefined {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${flagName} `)) continue;
    const parts = trimmed.split(/\s+/);
    const value = parts[parts.length - 1];
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return undefined;
}

async function resolveCodexFastModeEnabled(options: {
  codexCommand?: string;
  featuresListOutput?: string;
  configFastModeEnabled?: boolean;
}): Promise<boolean | undefined> {
  if (options.featuresListOutput !== undefined) {
    return parseCodexFeatureFlagEnabled(options.featuresListOutput, "fast_mode")
      ?? options.configFastModeEnabled;
  }
  if (options.codexCommand && basename(options.codexCommand) !== "codex") {
    return options.configFastModeEnabled;
  }

  try {
    const { stdout } = await execFileAsync(options.codexCommand ?? "codex", ["features", "list"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });
    return parseCodexFeatureFlagEnabled(stdout, "fast_mode")
      ?? options.configFastModeEnabled;
  } catch {
    return options.configFastModeEnabled;
  }
}

function sectionBody(raw: string, sectionName?: string): string {
  const lines = raw.split(/\r?\n/);
  const body: string[] = [];
  let inSection = sectionName === undefined;
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)]\s*$/);
    if (section) {
      if (sectionName === undefined) break;
      inSection = section[1] === sectionName;
      continue;
    }
    if (inSection) body.push(line);
  }
  return body.join("\n");
}

function readTomlStringValue(body: string, key: string): string | undefined {
  const quoted = body.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?$`, "m"))
    ?? body.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*'([^']+)'\\s*(?:#.*)?$`, "m"));
  if (quoted?.[1]) return quoted[1].trim() || undefined;

  const bare = body.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*([^\\s#]+)\\s*(?:#.*)?$`, "m"));
  return bare?.[1]?.trim() || undefined;
}

function readTomlBooleanValue(body: string, key: string): boolean | undefined {
  const match = body.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?$`, "m"));
  if (!match?.[1]) return undefined;
  return match[1] === "true";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
