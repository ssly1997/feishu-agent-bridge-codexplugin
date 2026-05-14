import { join } from "node:path";
import { CONFIG_DIR, CONFIG_PATH, ConfigError, loadConfig } from "./config.js";
import { buildNotificationCard } from "./card.js";
import { ackCommand, getNextCommand, resolveCommandQueuePath } from "./commandQueue.js";
import { FeishuApiError, FeishuClient } from "./feishuClient.js";
import { runCodexResume } from "./codexCli.js";
import { handleCodexSessionControlCommand, parseCodexSessionControlCommand } from "./codexSessions.js";
export async function processNextCodexCommand(options = {}) {
    const configPath = options.configPath ?? CONFIG_PATH;
    const config = await loadConfig(configPath);
    const queuePath = resolveCommandQueuePath(config);
    const base = {
        queuePath,
        pollIntervalSeconds: config.codex.pollIntervalSeconds
    };
    const command = await getNextCommand(queuePath, { claim: true });
    if (!command) {
        return {
            ...base,
            processed: false,
            reason: "no pending command"
        };
    }
    let codex;
    let ackState = "failed";
    let summary = "";
    const control = parseCodexSessionControlCommand(command.text);
    if (control) {
        const controlResult = await handleCodexSessionControlCommand(control, config, configPath);
        const updatedCommand = await ackCommand(command.id, controlResult.ackState, queuePath, controlResult.summary);
        const notifyResult = await notifyCommandResult(config, updatedCommand ?? command, controlResult.ackState, controlResult.title, controlResult.summary, undefined, options.feishuClient ?? new FeishuClient());
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
    if (!config.codex.enabled) {
        summary = "Codex CLI 未启用。请先发送 list-session 选择一个 Codex 会话，或在配置中设置 codex.enabled=true。";
        const updatedCommand = await ackCommand(command.id, "failed", queuePath, summary);
        const notifyResult = await notifyCommandResult(config, updatedCommand ?? command, "failed", "Codex CLI disabled", summary, undefined, options.feishuClient ?? new FeishuClient());
        return {
            ...base,
            processed: true,
            command: updatedCommand ?? command,
            ackState: "failed",
            summary,
            notification: notifyResult.notification,
            notifyError: notifyResult.error
        };
    }
    try {
        codex = await runCodexResume(buildFeishuCommandPrompt(command), config.codex, {
            outputPath: codexOutputPath(config, command),
            now: options.now
        });
        ackState = codex.ok ? "done" : "failed";
        summary = summarizeCodexResult(codex);
    }
    catch (error) {
        summary = formatError(error);
    }
    const updatedCommand = await ackCommand(command.id, ackState, queuePath, summary);
    const notifyResult = await notifyCommandResult(config, updatedCommand ?? command, ackState, ackState === "done" ? "Codex task finished" : "Codex task failed", summary, codex, options.feishuClient ?? new FeishuClient());
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
export function buildFeishuCommandPrompt(command) {
    return [
        "你正在处理一条来自飞书群聊的 Agent 指令。",
        "请执行用户的原始指令，并把最终答复写在本次 Codex 回复中。",
        "不要调用 feishu_notify、feishu_notify_task_result、feishu_send_test 或其他飞书发送工具；外层 feishu-agent-bridge worker 会自动把你的最终答复转发回飞书。",
        "如果用户要求“回消息”“发消息”或“验证飞书消息格式”，也只需要在最终答复中写出要返回的内容。",
        "",
        "用户原始指令：",
        command.text
    ].join("\n");
}
async function notifyCommandResult(config, command, ackState, title, summary, codex, feishuClient) {
    if (!config.codex.notifyResult || !config.enabled) {
        return { notification: "skipped" };
    }
    const status = ackState === "done" ? "success" : "failed";
    const card = buildNotificationCard({
        source: "codex-cli",
        title,
        status,
        summary,
        cwd: config.codex.cwd,
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
