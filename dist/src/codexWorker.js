import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { CONFIG_DIR, CONFIG_PATH, ConfigError, loadConfig } from "./config.js";
import { buildNotificationCard } from "./card.js";
import { ackCommand, getNextCommand, resolveCommandQueuePath, updateCommandStatusMetadata } from "./commandQueue.js";
import { FeishuApiError, FeishuClient } from "./feishuClient.js";
import { progressSummaryFromJsonLine, runCodexResume } from "./codexCli.js";
import { findCodexSession, handleCodexSessionControlCommand, parseCodexSessionControlCommand } from "./codexSessions.js";
import { formatGitBranchValueForCwd } from "./gitStatus.js";
import { buildCommandStatusCard } from "./statusCard.js";
const PROGRESS_UPDATE_INTERVAL_MS = 10_000;
const INITIAL_CLI_HANDOFF_PROGRESS_SUMMARY = "已交接给 Codex CLI 处理。";
export async function processNextCodexCommand(options = {}) {
    const configPath = options.configPath ?? CONFIG_PATH;
    const config = await loadConfig(configPath);
    const queuePath = resolveCommandQueuePath(config);
    const base = {
        queuePath
    };
    const claimedCommand = await getNextCommand(queuePath, {
        claim: true,
        sessionId: options.sessionId
    });
    if (!claimedCommand) {
        return {
            ...base,
            processed: false,
            reason: "no pending command"
        };
    }
    let command = claimedCommand;
    let codex;
    let ackState = "failed";
    let summary = "";
    const feishuClient = options.feishuClient ?? new FeishuClient();
    const control = parseCodexSessionControlCommand(command.text);
    if (control) {
        const controlResult = await handleCodexSessionControlCommand(control, config, configPath);
        const updatedCommand = await ackCommand(command.id, controlResult.ackState, queuePath, controlResult.summary);
        const notifyResult = await notifyCommandResult(config, updatedCommand ?? command, controlResult.ackState, controlResult.title, controlResult.summary, undefined, feishuClient);
        return {
            ...base,
            processed: true,
            command: updatedCommand ?? command,
            ackState: controlResult.ackState,
            control: controlResult.control,
            summary: controlResult.summary,
            notification: notifyResult.notification,
            notifyError: notifyResult.error
        };
    }
    if (!config.codex.enabled || !command.sessionId) {
        summary = "Codex CLI 未启用。请先发送 list-session 选择一个 Codex 会话，或在配置中设置 codex.enabled=true。";
        command = await updateCommandStatusCard(config, queuePath, command, "in_progress", summary, feishuClient, { nowMs: options.now?.() ?? Date.now() }).then((result) => result.command);
        const updatedCommand = await ackCommand(command.id, "failed", queuePath, summary);
        const finalNotifyResult = await notifyFinalCommandStatus(config, queuePath, updatedCommand ?? command, "failed", "Codex CLI disabled", summary, undefined, feishuClient, { nowMs: options.now?.() ?? Date.now() });
        return {
            ...base,
            processed: true,
            command: updatedCommand ?? command,
            ackState: "failed",
            summary,
            notification: finalNotifyResult.notification,
            notifyError: finalNotifyResult.error
        };
    }
    const progressUpdateIntervalMs = options.progressUpdateIntervalMs ?? PROGRESS_UPDATE_INTERVAL_MS;
    const initialProgressNowMs = options.now?.() ?? Date.now();
    const initialProgressSummary = formatRunningProgressSummary([INITIAL_CLI_HANDOFF_PROGRESS_SUMMARY]);
    const commandCodexConfig = codexConfigForCommand(config, command);
    const sessionProgressReader = await createCodexSessionProgressReader(commandCodexConfig, command.sessionId);
    command = await updateCommandStatusCard(config, queuePath, command, "in_progress", initialProgressSummary, feishuClient, { nowMs: initialProgressNowMs }).then((result) => result.command);
    const progressUpdates = [];
    const publicProgressSummaries = [INITIAL_CLI_HANDOFF_PROGRESS_SUMMARY];
    let lastCardSummary = initialProgressSummary;
    let lastCardUpdatedAt = initialProgressNowMs;
    let progressUpdateChain = Promise.resolve();
    let progressRefreshChain = Promise.resolve();
    let progressHeartbeat;
    const recordProgressSummary = (summary) => {
        const normalized = summary.replace(/\s+/g, " ").trim();
        if (!normalized || publicProgressSummaries[publicProgressSummaries.length - 1] === normalized)
            return;
        publicProgressSummaries.push(normalized);
        if (publicProgressSummaries.length > 4) {
            publicProgressSummaries.splice(0, publicProgressSummaries.length - 4);
        }
    };
    const enqueueProgressUpdate = (nowMs, updateOptions = {}) => {
        const statusSummary = formatRunningProgressSummary(publicProgressSummaries);
        if (!updateOptions.allowSameSummary && statusSummary === lastCardSummary)
            return;
        if (nowMs - lastCardUpdatedAt < progressUpdateIntervalMs)
            return;
        lastCardSummary = statusSummary;
        lastCardUpdatedAt = nowMs;
        const update = progressUpdateChain
            .catch(() => undefined)
            .then(async () => {
            const result = await updateCommandStatusCard(config, queuePath, command, "in_progress", statusSummary, feishuClient, { nowMs });
            command = result.command;
        })
            .catch(() => {
            // Progress card updates should never interrupt the running Codex task.
        });
        progressUpdateChain = update;
        progressUpdates.push(update);
    };
    const reportProgress = (event) => {
        const progressSummary = event.summary.trim();
        if (!progressSummary)
            return;
        recordProgressSummary(progressSummary);
        enqueueProgressUpdate(event.receivedAtMs);
    };
    const refreshProgressFromSessionLog = (nowMs) => {
        progressRefreshChain = progressRefreshChain
            .catch(() => undefined)
            .then(async () => {
            const summaries = await sessionProgressReader?.readNewSummaries();
            for (const summary of summaries ?? []) {
                recordProgressSummary(summary);
            }
            enqueueProgressUpdate(nowMs, { allowSameSummary: true });
        })
            .catch(() => {
            // Session-log progress is best-effort and must not interrupt the task.
        });
    };
    const stopProgressUpdates = async () => {
        if (progressHeartbeat) {
            clearInterval(progressHeartbeat);
            progressHeartbeat = undefined;
        }
        await progressRefreshChain.catch(() => undefined);
        await Promise.allSettled(progressUpdates);
        await progressUpdateChain.catch(() => undefined);
    };
    if (command.statusMessageId && config.enabled) {
        progressHeartbeat = setInterval(() => {
            refreshProgressFromSessionLog(options.now?.() ?? Date.now());
        }, progressUpdateIntervalMs);
        progressHeartbeat.unref?.();
    }
    try {
        codex = await runCodexResume(buildFeishuCommandPrompt(command), commandCodexConfig, {
            outputPath: codexOutputPath(config, command),
            now: options.now,
            onProgress: reportProgress
        });
        ackState = codex.ok ? "done" : "failed";
        summary = summarizeCodexResult(codex);
    }
    catch (error) {
        summary = formatError(error);
    }
    finally {
        await stopProgressUpdates();
    }
    const updatedCommand = await ackCommand(command.id, ackState, queuePath, summary);
    const notifyResult = await notifyFinalCommandStatus(config, queuePath, updatedCommand ?? command, ackState, ackState === "done" ? "Codex task finished" : "Codex task failed", summary, codex, feishuClient, { nowMs: options.now?.() ?? Date.now() });
    return {
        ...base,
        processed: true,
        command: updatedCommand ?? command,
        codex,
        ackState,
        summary,
        notification: notifyResult.notification,
        notifyError: notifyResult.error
    };
}
function codexOutputPath(config, command) {
    return join(config.codex.outputDir ?? join(CONFIG_DIR, "codex-output"), `${safeFilename(command.id)}.txt`);
}
function codexConfigForCommand(config, command) {
    return {
        ...config.codex,
        sessionId: command.sessionId,
        sessionTitle: command.sessionTitle,
        sessionSource: command.sessionSource,
        sessionGitBranch: command.sessionGitBranch,
        sessionUpdatedAt: command.sessionUpdatedAt,
        cwd: command.sessionCwd,
        useLast: false
    };
}
export function buildFeishuCommandPrompt(command) {
    const lines = [
        "你正在处理一条来自飞书群聊的 Agent 指令。",
        "请执行用户的原始指令，并把最终答复写在本次 Codex 回复中。",
        "不要调用 feishu_notify、feishu_notify_task_result、feishu_send_test 或其他飞书发送工具；外层 feishu-agent-bridge runtime 会自动把你的最终答复转发回飞书。",
        "如果用户要求“回消息”“发消息”或“验证飞书消息格式”，也只需要在最终答复中写出要返回的内容。",
        "执行过程中可以输出简短、可公开、无敏感信息的进度更新；不要输出内部推理、完整命令参数、凭据或工具输出全文。",
        "",
        "用户原始指令：",
        command.text
    ];
    if (command.attachments?.length) {
        lines.push("", "本次飞书指令包含本地附件，请直接读取这些绝对路径完成识别或分析：");
        for (const [index, attachment] of command.attachments.entries()) {
            lines.push(`${index + 1}. type=${attachment.type} path=${attachment.path}` +
                `${attachment.mimeType ? ` mime=${attachment.mimeType}` : ""}` +
                `${attachment.sizeBytes !== undefined ? ` size=${attachment.sizeBytes}` : ""}`);
        }
    }
    return lines.join("\n");
}
async function notifyFinalCommandStatus(config, queuePath, command, ackState, title, summary, codex, feishuClient, options) {
    const phase = ackState === "done" ? "done" : "failed";
    const statusUpdate = await updateCommandStatusCard(config, queuePath, command, phase, summary, feishuClient, {
        nowMs: options.nowMs,
        codex
    });
    if (statusUpdate.notification === "updated") {
        return { notification: "updated" };
    }
    const fallback = await notifyCommandResult(config, statusUpdate.command, ackState, title, summary, codex, feishuClient);
    return {
        notification: fallback.notification,
        error: statusUpdate.error ?? fallback.error
    };
}
async function updateCommandStatusCard(config, queuePath, command, phase, statusSummary, feishuClient, options) {
    const statusUpdatedAt = new Date(options.nowMs).toISOString();
    if (!command.statusMessageId || !config.enabled) {
        const updated = await updateCommandStatusMetadata(command.id, queuePath, {
            statusUpdatedAt,
            statusSummary
        });
        return { command: updated ?? command, notification: "skipped" };
    }
    try {
        const gitBranch = await formatCommandGitBranch(config, command);
        await feishuClient.updateInteractiveMessage(config, command.statusMessageId, buildCommandStatusCard(command, config, {
            phase,
            nowMs: options.nowMs,
            progressSummary: phase === "in_progress" ? statusSummary : undefined,
            resultSummary: phase === "done" || phase === "failed" ? statusSummary : undefined,
            outputPath: options.codex?.outputPath,
            durationMs: options.codex?.durationMs,
            exitCode: options.codex?.exitCode,
            signal: options.codex?.signal,
            timedOut: options.codex?.timedOut,
            gitBranch
        }));
        const updated = await updateCommandStatusMetadata(command.id, queuePath, {
            statusUpdatedAt,
            statusNotifyError: null,
            statusSummary
        });
        return { command: updated ?? command, notification: "updated" };
    }
    catch (error) {
        const formatted = formatError(error);
        const updated = await updateCommandStatusMetadata(command.id, queuePath, {
            statusUpdatedAt,
            statusNotifyError: formatted,
            statusSummary
        });
        return {
            command: updated ?? command,
            notification: "skipped",
            error: formatted
        };
    }
}
async function notifyCommandResult(config, command, ackState, title, summary, codex, feishuClient) {
    if (!config.codex.notifyResult || !config.enabled) {
        return { notification: "skipped" };
    }
    const status = ackState === "done" ? "success" : "failed";
    const gitBranch = await formatCommandGitBranch(config, command);
    const card = buildNotificationCard({
        source: "codex-cli",
        title,
        status,
        summary,
        cwd: command.sessionCwd ?? config.codex.cwd,
        gitBranch,
        projectLabel: command.projectDisplayLabel,
        codexSessionId: command.sessionId,
        codexSessionTitle: command.sessionTitle,
        artifacts: codex?.outputPath ? [codex.outputPath] : undefined,
        metadata: {
            commandId: command.id,
            messageId: command.messageId,
            chatId: command.chatId,
            exitCode: codex?.exitCode,
            signal: codex?.signal,
            timedOut: codex?.timedOut,
            durationMs: codex?.durationMs
        }
    }, config);
    try {
        await feishuClient.sendInteractiveMessageToReceiver(config, {
            receiveIdType: "chat_id",
            receiveId: command.chatId
        }, card);
        return { notification: "sent" };
    }
    catch (error) {
        return { notification: "skipped", error: formatError(error) };
    }
}
function formatCommandGitBranch(config, command) {
    return formatGitBranchValueForCwd(command.sessionCwd ?? config.codex.cwd);
}
function summarizeCodexResult(result) {
    const body = result.lastMessage.trim() || result.stdout.trim() || result.stderr.trim();
    if (result.ok) {
        return body || `Codex CLI completed in ${result.durationMs}ms.`;
    }
    const reason = result.timedOut
        ? `Codex CLI timed out after ${result.durationMs}ms.`
        : `Codex CLI exited with code ${result.exitCode ?? "null"}${result.signal ? ` signal=${result.signal}` : ""}.`;
    return body ? `${reason}\n\n${body}` : reason;
}
async function createCodexSessionProgressReader(config, sessionId) {
    if (!sessionId)
        return undefined;
    let rolloutPath;
    try {
        const session = await findCodexSession(config, sessionId, { includeTemporary: true });
        rolloutPath = session?.rolloutPath;
    }
    catch {
        return undefined;
    }
    if (!rolloutPath)
        return undefined;
    let offset = await fileSize(rolloutPath);
    let buffered = "";
    return {
        readNewSummaries: async () => {
            const data = await readFile(rolloutPath);
            if (offset > data.byteLength) {
                offset = 0;
                buffered = "";
            }
            const chunk = data.subarray(offset).toString("utf8");
            offset = data.byteLength;
            const lines = `${buffered}${chunk}`.split(/\r?\n/);
            buffered = lines.pop() ?? "";
            return lines
                .map((line) => progressSummaryFromJsonLine(line))
                .filter((summary) => Boolean(summary));
        }
    };
}
async function fileSize(path) {
    try {
        return (await stat(path)).size;
    }
    catch {
        return 0;
    }
}
function formatRunningProgressSummary(publicProgressSummaries) {
    if (publicProgressSummaries.length === 0)
        return "";
    return [
        "最近进展：",
        ...publicProgressSummaries.map((item) => `- ${item}`)
    ].join("\n");
}
function safeFilename(value) {
    return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
function formatError(error) {
    if (error instanceof ConfigError || error instanceof FeishuApiError) {
        return error.message;
    }
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}
