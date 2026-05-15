import * as lark from "@larksuiteoapi/node-sdk";
import { assertAppCredentialsReady, ConfigError, CONFIG_PATH, loadConfig } from "./config.js";
import { enqueueCommand, getCommandQueueStats, resolveCommandQueuePath } from "./commandQueue.js";
import { handleCodexSessionControlCommand, listCodexSessions, parseCodexSessionControlCommand } from "./codexSessions.js";
import { FeishuClient } from "./feishuClient.js";
import { buildCodexSessionListCard, parseSelectSessionActionValue } from "./sessionCard.js";
export class FeishuCommandListener {
    options;
    wsClient;
    handledMessageIds = new Set();
    queuePath;
    startedAt;
    lastEventAt;
    lastCommandAt;
    lastError;
    ready = false;
    enqueuedCount = 0;
    ignoredCount = 0;
    constructor(options = {}) {
        this.options = options;
    }
    async start() {
        if (this.wsClient) {
            return this.getStatus();
        }
        const configPath = this.options.configPath ?? CONFIG_PATH;
        const config = await loadConfig(configPath);
        if (!config.inbound.enabled) {
            throw new ConfigError(`inbound.enabled is false in ${configPath}`);
        }
        if (config.inbound.mode !== "long_connection") {
            throw new ConfigError(`Unsupported inbound.mode: ${config.inbound.mode}`);
        }
        assertAppCredentialsReady(config);
        this.queuePath = resolveCommandQueuePath(config);
        this.startedAt = new Date().toISOString();
        this.lastError = undefined;
        this.ready = false;
        const feishuClient = this.options.feishuClient ?? new FeishuClient();
        const eventDispatcher = new lark.EventDispatcher({
            logger: stderrLogger,
            loggerLevel: lark.LoggerLevel.debug
        }).register({
            "im.message.receive_v1": async (data) => {
                await this.handleMessageReceive(data, config, feishuClient);
            },
            "card.action.trigger": async (data) => {
                await this.handleCardAction(data, feishuClient);
            }
        });
        this.wsClient = new lark.WSClient({
            appId: config.appId ?? "",
            appSecret: config.appSecret ?? "",
            logger: stderrLogger,
            loggerLevel: lark.LoggerLevel.debug,
            autoReconnect: true,
            source: "feishu-agent-bridge",
            onReady: () => {
                this.ready = true;
            },
            onError: (error) => {
                this.ready = false;
                this.lastError = formatError(error);
            },
            onReconnecting: () => {
                this.ready = false;
            },
            onReconnected: () => {
                this.ready = true;
            }
        });
        await this.wsClient.start({ eventDispatcher });
        return this.getStatus();
    }
    stop(force = false) {
        if (!this.wsClient)
            return;
        this.wsClient.close({ force });
        this.wsClient = undefined;
        this.ready = false;
    }
    getStatus() {
        return {
            running: Boolean(this.wsClient),
            ready: this.ready,
            configPath: this.options.configPath ?? CONFIG_PATH,
            queuePath: this.queuePath,
            startedAt: this.startedAt,
            lastEventAt: this.lastEventAt,
            lastCommandAt: this.lastCommandAt,
            enqueuedCount: this.enqueuedCount,
            ignoredCount: this.ignoredCount,
            lastError: this.lastError,
            reconnectInfo: this.wsClient?.getReconnectInfo()
        };
    }
    async handleMessageReceive(data, baseConfig, feishuClient) {
        this.lastEventAt = new Date().toISOString();
        const messageId = data.message.message_id;
        if (this.handledMessageIds.has(messageId)) {
            this.ignoredCount += 1;
            stderrLogger.info("[inbound]", "ignored duplicate message", JSON.stringify({
                eventId: data.event_id,
                messageId,
                chatId: data.message.chat_id
            }));
            return;
        }
        this.handledMessageIds.add(messageId);
        stderrLogger.info("[inbound]", "received message", JSON.stringify({
            eventId: data.event_id,
            messageId,
            chatId: data.message.chat_id,
            chatType: data.message.chat_type,
            messageType: data.message.message_type,
            senderOpenId: data.sender.sender_id?.open_id,
            mentions: data.message.mentions?.map((mention) => ({
                key: mention.key,
                openId: mention.id.open_id,
                name: mention.name
            }))
        }));
        try {
            const config = await this.loadRuntimeConfig(baseConfig);
            const extracted = extractCommandFromMessage(data, config);
            if (!extracted.command) {
                this.ignoredCount += 1;
                stderrLogger.info("[inbound]", "ignored message", JSON.stringify({
                    messageId: data.message.message_id,
                    reason: extracted.ignoredReason
                }));
                return;
            }
            const control = parseCodexSessionControlCommand(extracted.command.text);
            if (control) {
                if (control.type === "list-session") {
                    const sessions = await listCodexSessions(config.codex);
                    await feishuClient.sendInteractiveMessageToReceiver(config, {
                        receiveIdType: "chat_id",
                        receiveId: extracted.command.chatId
                    }, buildCodexSessionListCard(sessions, config.codex.sessionListLimit));
                    stderrLogger.info("[inbound]", "sent session selection card", JSON.stringify({
                        messageId: extracted.command.messageId,
                        chatId: extracted.command.chatId,
                        sessions: sessions.length
                    }));
                    return;
                }
                const result = await handleCodexSessionControlCommand(control, config, this.options.configPath ?? CONFIG_PATH);
                await feishuClient.sendTextMessage(config, {
                    receiveIdType: "chat_id",
                    receiveId: extracted.command.chatId
                }, result.summary);
                stderrLogger.info("[inbound]", "handled control command", JSON.stringify({
                    control: result.control,
                    status: result.ackState,
                    title: result.title,
                    messageId: extracted.command.messageId,
                    chatId: extracted.command.chatId
                }));
                return;
            }
            const queuePath = resolveCommandQueuePath(config);
            const session = commandSessionFromConfig(config);
            if (!session) {
                this.ignoredCount += 1;
                await feishuClient.sendTextMessage(config, {
                    receiveIdType: "chat_id",
                    receiveId: extracted.command.chatId
                }, "请先发送 list-session 选择一个 Codex 会话，或使用 switch-session <序号|sessionId> 介入指定会话。");
                stderrLogger.info("[inbound]", "ignored command without selected session", JSON.stringify({
                    messageId: extracted.command.messageId,
                    chatId: extracted.command.chatId
                }));
                return;
            }
            const { command, inserted } = await enqueueCommand({
                ...extracted.command,
                ...session
            }, queuePath);
            stderrLogger.info("[inbound]", inserted ? "enqueued command" : "duplicate command", JSON.stringify({
                commandId: command.id,
                messageId: command.messageId,
                chatId: command.chatId,
                text: command.text
            }));
            if (inserted) {
                this.enqueuedCount += 1;
                this.lastCommandAt = new Date().toISOString();
                await this.options.onCommandEnqueued?.(command);
            }
            if (inserted && config.inbound.acknowledgeOnReceive) {
                await feishuClient.sendTextMessage(config, {
                    receiveIdType: "chat_id",
                    receiveId: command.chatId
                }, config.inbound.acknowledgementText);
                stderrLogger.info("[inbound]", "sent acknowledgement", JSON.stringify({
                    commandId: command.id,
                    chatId: command.chatId
                }));
            }
        }
        catch (error) {
            this.lastError = formatError(error);
            stderrLogger.error("[inbound]", "failed to handle message", this.lastError);
        }
    }
    async handleCardAction(data, feishuClient) {
        this.lastEventAt = new Date().toISOString();
        const event = lark.normalizeCardAction(data, {
            includeRaw: true
        });
        if (!event) {
            this.ignoredCount += 1;
            stderrLogger.info("[card]", "ignored unsupported card action");
            return;
        }
        const sessionId = parseSelectSessionActionValue(event.action.value);
        if (!sessionId) {
            this.ignoredCount += 1;
            stderrLogger.info("[card]", "ignored unrelated card action", JSON.stringify({
                messageId: event.messageId,
                chatId: event.chatId,
                actionTag: event.action.tag
            }));
            return;
        }
        await this.completeSessionSelectionFromCard(event, sessionId, feishuClient);
    }
    async completeSessionSelectionFromCard(event, sessionId, feishuClient) {
        try {
            const configPath = this.options.configPath ?? CONFIG_PATH;
            const config = await loadConfig(configPath);
            if (config.inbound.allowedChatIds && !config.inbound.allowedChatIds.includes(event.chatId)) {
                this.ignoredCount += 1;
                stderrLogger.info("[card]", "ignored card action from disallowed chat", JSON.stringify({
                    messageId: event.messageId,
                    chatId: event.chatId
                }));
                return;
            }
            const result = await handleCodexSessionControlCommand({ type: "select-session", selector: sessionId }, config, configPath);
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: event.chatId
            }, result.summary);
            stderrLogger.info("[card]", "handled session selection action", JSON.stringify({
                status: result.ackState,
                sessionId,
                messageId: event.messageId,
                chatId: event.chatId,
                operatorOpenId: event.operator.openId
            }));
        }
        catch (error) {
            this.lastError = formatError(error);
            stderrLogger.error("[card]", "failed to handle card action", this.lastError);
        }
    }
    async loadRuntimeConfig(fallback) {
        const configPath = this.options.configPath;
        if (!configPath)
            return fallback;
        try {
            return await loadConfig(configPath);
        }
        catch (error) {
            this.lastError = formatError(error);
            stderrLogger.error("[inbound]", "failed to reload runtime config", this.lastError);
            return fallback;
        }
    }
}
export async function startCommandListener(options = {}) {
    const listener = new FeishuCommandListener({
        ...options,
        configPath: options.configPath ?? CONFIG_PATH
    });
    await listener.start();
    return listener;
}
export async function getCommandListenerSnapshot(configPath = CONFIG_PATH) {
    const config = await loadConfig(configPath);
    const queuePath = resolveCommandQueuePath(config);
    return {
        status: {
            running: false,
            ready: false,
            configPath,
            queuePath,
            enqueuedCount: 0,
            ignoredCount: 0
        },
        queue: await getCommandQueueStats(queuePath)
    };
}
export function extractCommandFromMessage(event, config) {
    if (!config.inbound.enabled) {
        return { ignoredReason: "inbound disabled" };
    }
    const message = event.message;
    const sender = event.sender;
    if (message.message_type !== "text") {
        return { ignoredReason: `unsupported message_type=${message.message_type}` };
    }
    if (config.inbound.allowedChatIds?.length &&
        !config.inbound.allowedChatIds.includes(message.chat_id)) {
        return { ignoredReason: "chat not allowed" };
    }
    const senderOpenId = sender.sender_id?.open_id;
    if (config.inbound.allowedOpenIds?.length &&
        (!senderOpenId || !config.inbound.allowedOpenIds.includes(senderOpenId))) {
        return { ignoredReason: "sender not allowed" };
    }
    const rawText = readTextContent(message.content);
    if (!hasRequiredMention(event, config, rawText)) {
        return { ignoredReason: "missing bot mention" };
    }
    const text = stripAtMentions(rawText, (message.mentions ?? []).map((mention) => mention.key));
    if (!text) {
        return { ignoredReason: "empty command text" };
    }
    return {
        command: {
            text,
            rawText,
            messageId: message.message_id,
            chatId: message.chat_id,
            chatType: message.chat_type,
            sender: {
                openId: sender.sender_id?.open_id,
                userId: sender.sender_id?.user_id,
                unionId: sender.sender_id?.union_id,
                senderType: sender.sender_type
            },
            eventId: event.event_id,
            tenantKey: event.tenant_key,
            createdAt: message.create_time
        }
    };
}
function readTextContent(content) {
    try {
        const parsed = JSON.parse(content);
        if (isObject(parsed) && typeof parsed.text === "string") {
            return parsed.text;
        }
    }
    catch {
        return content;
    }
    return content;
}
function hasRequiredMention(event, config, rawText) {
    if (!config.inbound.requireMention)
        return true;
    if (event.message.chat_type === "p2p")
        return true;
    const mentions = event.message.mentions ?? [];
    if (config.inbound.botOpenId) {
        return mentions.some((mention) => mention.id.open_id === config.inbound.botOpenId);
    }
    return mentions.length > 0 || /<at\b/i.test(rawText);
}
function stripAtMentions(text, mentionKeys = []) {
    let result = text
        .replace(/<at\b[^>]*>.*?<\/at>/gis, " ")
        .replace(/<at\b[^>]*\/>/gis, " ");
    for (const key of mentionKeys) {
        if (key) {
            result = result.replace(new RegExp(escapeRegExp(key), "g"), " ");
        }
    }
    return result
        .replace(/@_user_\d+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function commandSessionFromConfig(config) {
    if (!config.codex.enabled || !config.codex.sessionId)
        return undefined;
    return {
        sessionId: config.codex.sessionId,
        sessionTitle: config.codex.sessionTitle,
        sessionCwd: config.codex.cwd,
        sessionSource: config.codex.sessionSource,
        sessionGitBranch: config.codex.sessionGitBranch,
        sessionUpdatedAt: config.codex.sessionUpdatedAt
    };
}
function formatError(error) {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
const stderrLogger = {
    error: (...message) => {
        console.error("[feishu-agent-bridge][error]", ...message);
    },
    warn: (...message) => {
        console.error("[feishu-agent-bridge][warn]", ...message);
    },
    info: (...message) => {
        console.error("[feishu-agent-bridge][info]", ...message);
    },
    debug: (...message) => {
        console.error("[feishu-agent-bridge][debug]", ...message);
    },
    trace: (...message) => {
        console.error("[feishu-agent-bridge][trace]", ...message);
    }
};
