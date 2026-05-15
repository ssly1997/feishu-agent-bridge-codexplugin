import { buildNotificationCard } from "./card.js";
export function buildCommandStatusCard(command, config, options) {
    const nowMs = options.nowMs ?? Date.now();
    const statusSummary = options.resultSummary ?? options.progressSummary ?? command.statusSummary;
    const lines = [
        `任务状态：${phaseLabel(options.phase)}`,
        `Command ID：${command.id}`,
        `指令摘要：${truncateSingleLine(command.text, 220)}`,
        `收到时间：${formatDate(command.receivedAt)}`,
        command.claimedAt ? `认领时间：${formatDate(command.claimedAt)}` : undefined,
        command.completedAt ? `完成时间：${formatDate(command.completedAt)}` : undefined,
        command.attempts > 0 ? `尝试次数：${command.attempts}` : undefined,
        command.claimedAt && options.phase === "in_progress"
            ? `已运行：${formatDuration(nowMs - Date.parse(command.claimedAt))}`
            : undefined,
        options.durationMs !== undefined ? `总耗时：${formatDuration(options.durationMs)}` : undefined,
        options.exitCode !== undefined ? `退出码：${options.exitCode ?? "null"}` : undefined,
        options.signal ? `退出信号：${options.signal}` : undefined,
        options.timedOut ? "结果：Codex CLI 超时" : undefined,
        statusSummary ? `进度摘要：${truncateMultiline(statusSummary, 900)}` : undefined
    ].filter((line) => Boolean(line));
    return buildNotificationCard({
        source: "codex-cli",
        title: phaseTitle(options.phase),
        status: phaseStatus(options.phase),
        summary: lines.join("\n"),
        cwd: command.sessionCwd ?? config.codex.cwd,
        codexSessionId: command.sessionId,
        codexSessionTitle: command.sessionTitle,
        artifacts: options.outputPath ? [options.outputPath] : undefined
    }, config);
}
function phaseLabel(phase) {
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
function phaseTitle(phase) {
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
function phaseStatus(phase) {
    switch (phase) {
        case "queued":
            return "info";
        case "in_progress":
            return "needs_action";
        case "done":
            return "success";
        case "failed":
            return "failed";
    }
}
function formatDate(value) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp))
        return value;
    return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}
function formatDuration(valueMs) {
    const ms = Math.max(0, valueMs);
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60)
        return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}
function truncateSingleLine(value, maxLength) {
    return truncateMultiline(value.replace(/\s+/g, " ").trim(), maxLength);
}
function truncateMultiline(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    return `${value.slice(0, Math.max(0, maxLength - 15))}... [truncated]`;
}
