import { basename } from "node:path";
import { buildNotificationCard } from "./card.js";
import type { AgentCommand, BridgeConfig, NotifyStatus } from "./types.js";

const MAX_CONCLUSION_LINES = 8;
const MAX_CONCLUSION_LENGTH = 900;
const MAX_CONCLUSION_LINE_LENGTH = 220;

export type CommandStatusPhase = "queued" | "in_progress" | "done" | "failed";

export interface CommandStatusCardOptions {
  phase: CommandStatusPhase;
  nowMs?: number;
  progressSummary?: string;
  resultSummary?: string;
  outputPath?: string;
  durationMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  gitBranch?: string;
  model?: string;
  reasoningEffort?: string;
  fastModeEnabled?: boolean;
}

export function buildCommandStatusCard(
  command: AgentCommand,
  config: BridgeConfig,
  options: CommandStatusCardOptions
) {
  const nowMs = options.nowMs ?? Date.now();
  const statusSummary = options.resultSummary ?? options.progressSummary ?? command.statusSummary;
  const statusSummaryLines = formatStatusSummaryLines(options.phase, statusSummary);
  const lines = [
    `任务状态：${phaseLabel(options.phase)}`,
    `指令摘要：${truncateSingleLine(command.text, 220)}`,
    formatRuntimeConfigLine(command, config, options),
    command.claimedAt && options.phase === "in_progress"
      ? `已运行：${formatDuration(nowMs - Date.parse(command.claimedAt))}`
      : undefined,
    options.durationMs !== undefined ? `总耗时：${formatDuration(options.durationMs)}` : undefined,
    options.signal ? `退出信号：${options.signal}` : undefined,
    options.timedOut ? "结果：Codex CLI 超时" : undefined,
    options.phase === "queued" && command.attachments?.length
      ? `附件：${command.attachments.length} 个（${command.attachments.map((item) => basename(item.path)).join(", ")}）`
      : undefined,
    ...statusSummaryLines
  ].filter((line): line is string => Boolean(line));

  return buildNotificationCard(
    {
      source: "codex-cli",
      title: phaseTitle(options.phase),
      status: phaseStatus(options.phase),
      summary: lines.join("\n"),
      cwd: command.sessionCwd ?? config.codex.cwd,
      gitBranch: options.gitBranch,
      projectLabel: command.projectDisplayLabel,
      codexSessionId: command.sessionId,
      codexSessionTitle: command.sessionTitle
    },
    config
  );
}

function phaseLabel(phase: CommandStatusPhase): string {
  switch (phase) {
    case "queued":
      return "已收到 / 排队中";
    case "in_progress":
      return "处理中";
    case "done":
      return "完成";
    case "failed":
      return "失败";
  }
}

function phaseTitle(phase: CommandStatusPhase): string {
  switch (phase) {
    case "queued":
      return "Codex task queued";
    case "in_progress":
      return "Codex task in progress";
    case "done":
      return "Codex task finished";
    case "failed":
      return "Codex task failed";
  }
}

function phaseStatus(phase: CommandStatusPhase): NotifyStatus {
  switch (phase) {
    case "queued":
      return "info";
    case "in_progress":
      return "in_progress";
    case "done":
      return "success";
    case "failed":
      return "failed";
  }
}

function formatStatusSummaryLines(phase: CommandStatusPhase, statusSummary: string | undefined): string[] {
  if (!statusSummary) return [];
  switch (phase) {
    case "in_progress":
      return [truncateMultiline(statusSummary, 900)];
    case "failed":
      return [`失败原因：${truncateMultiline(statusSummary, 900)}`];
    case "queued":
      return [`说明：${truncateMultiline(statusSummary, 900)}`];
    case "done":
      return [`结论：\n${formatConclusion(statusSummary)}`];
  }
}

function formatConclusion(value: string): string {
  const usefulLines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(isUsefulConclusionLine)
    .slice(0, MAX_CONCLUSION_LINES)
    .map((line) => truncateSingleLine(line, MAX_CONCLUSION_LINE_LENGTH));
  const conclusion = usefulLines.length > 0 ? usefulLines.join("\n") : value.trim();
  return truncateMultiline(conclusion, MAX_CONCLUSION_LENGTH);
}

function isUsefulConclusionLine(line: string): boolean {
  if (!line) return false;
  if (line.startsWith("```")) return false;
  if (line.startsWith("<oai-mem-citation>")) return false;
  if (line.startsWith("</oai-mem-citation>")) return false;
  return true;
}

function formatDuration(valueMs: number): string {
  const ms = Math.max(0, valueMs);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatRuntimeConfigLine(
  command: AgentCommand,
  config: BridgeConfig,
  options: CommandStatusCardOptions
): string {
  return [
    `当前模型：${options.model || command.model || config.codex.model || "Codex default"}`,
    `智能等级：${formatReasoningEffort(options.reasoningEffort)}`,
    `快速模式：${formatFastModeEnabled(options.fastModeEnabled)}`
  ].join(" ｜ ");
}

function formatReasoningEffort(value: string | undefined): string {
  return value || "(未配置)";
}

function formatFastModeEnabled(value: boolean | undefined): string {
  if (value === true) return "已开启";
  if (value === false) return "未开启";
  return "(未知)";
}

function truncateSingleLine(value: string, maxLength: number): string {
  return truncateMultiline(value.replace(/\s+/g, " ").trim(), maxLength);
}

function truncateMultiline(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 15))}... [truncated]`;
}
