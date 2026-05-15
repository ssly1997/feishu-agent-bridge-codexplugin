import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodexCliConfig } from "./types.js";
import { ConfigError } from "./config.js";

export interface CodexResumeOptions {
  outputPath: string;
  now?: () => number;
  onProgress?: (event: CodexProgressEvent) => void;
}

export interface CodexProgressEvent {
  summary: string;
  receivedAtMs: number;
}

export interface CodexResumeResult {
  ok: boolean;
  command: string;
  args: string[];
  cwd?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  lastMessage: string;
  outputPath: string;
}

export async function runCodexResume(
  prompt: string,
  config: CodexCliConfig,
  options: CodexResumeOptions
): Promise<CodexResumeResult> {
  if (!config.enabled) {
    throw new ConfigError("codex.enabled is false");
  }
  if (!config.sessionId && !config.useLast) {
    throw new ConfigError("codex.sessionId is required unless codex.useLast is true");
  }
  if (!prompt.trim()) {
    throw new ConfigError("prompt must be a non-empty string");
  }

  await mkdir(dirname(options.outputPath), { recursive: true });
  const args = buildCodexResumeArgs(config, options.outputPath);
  const start = options.now?.() ?? Date.now();
  const child = spawn(config.command, args, {
    cwd: config.cwd,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  let stdoutLineBuffer = "";
  let timedOut = false;
  const maxBytes = config.outputMaxBytes;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = appendLimited(stdout, chunk, maxBytes);
    stdoutLineBuffer = processProgressLines(stdoutLineBuffer + chunk, (summary) => {
      options.onProgress?.({
        summary,
        receivedAtMs: options.now?.() ?? Date.now()
      });
    });
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = appendLimited(stderr, chunk, maxBytes);
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, config.timeoutMs);

  child.stdin.end(`${prompt}\n`);

  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, closeSignal) => {
      resolve({ exitCode: code, signal: closeSignal });
    });
  }).finally(() => {
    clearTimeout(timeout);
  });

  const trailingSummary = progressSummaryFromJsonLine(stdoutLineBuffer);
  if (trailingSummary) {
    options.onProgress?.({
      summary: trailingSummary,
      receivedAtMs: options.now?.() ?? Date.now()
    });
  }

  const end = options.now?.() ?? Date.now();
  const lastMessage = truncate(await readOptionalFile(options.outputPath), maxBytes);
  return {
    ok: exitCode === 0 && !timedOut,
    command: config.command,
    args,
    cwd: config.cwd,
    exitCode,
    signal,
    timedOut,
    durationMs: Math.max(0, end - start),
    stdout,
    stderr,
    lastMessage,
    outputPath: options.outputPath
  };
}

export function buildCodexResumeArgs(config: CodexCliConfig, outputPath: string): string[] {
  const args = ["exec"];

  if (config.model) args.push("--model", config.model);
  if (config.profile) args.push("--profile", config.profile);
  if (config.sandbox) args.push("--sandbox", config.sandbox);
  if (config.approvalPolicy) args.push("--ask-for-approval", config.approvalPolicy);

  args.push("resume", "--json", "-o", outputPath);

  if (config.extraArgs) args.push(...config.extraArgs);

  if (config.sessionId) {
    args.push(config.sessionId);
  } else if (config.useLast) {
    args.push("--last");
  }

  args.push("-");
  return args;
}

function appendLimited(current: string, chunk: string, maxBytes: number): string {
  return truncate(`${current}${chunk}`, maxBytes);
}

function processProgressLines(input: string, onSummary: (summary: string) => void): string {
  const lines = input.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const summary = progressSummaryFromJsonLine(line);
    if (summary) onSummary(summary);
  }
  return rest;
}

export function progressSummaryFromJsonLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return progressSummaryFromEvent(parsed);
}

function progressSummaryFromEvent(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined;
  const type = stringValue(event.type);
  const payload = isRecord(event.payload) ? event.payload : undefined;

  if (type === "event_msg" && payload?.type === "agent_message") {
    const summary = publicAgentMessageSummary(payload);
    if (summary) return summary;
  }

  if (type === "agent_message") {
    const summary = publicAgentMessageSummary(event);
    if (summary) return summary;
  }

  if (type === "response_item" && payload?.type === "function_call") {
    const name = stringValue(payload.name);
    if (name) {
      return `正在调用工具：${name}`;
    }
  }

  if (type === "function_call") {
    const name = stringValue(event.name);
    if (name) {
      return `正在调用工具：${name}`;
    }
  }

  return undefined;
}

function publicAgentMessageSummary(event: Record<string, unknown>): string | undefined {
  const phase = stringValue(event.phase);
  const message = stringValue(event.message);
  if (phase === "commentary" && message) {
    return truncateProgress(`进展：${message}`);
  }
  return undefined;
}

function truncate(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  return `${buffer.subarray(0, Math.max(0, maxBytes - 16)).toString("utf8")}\n[truncated]`;
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function truncateProgress(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 485)}... [truncated]`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
