import * as lark from "@larksuiteoapi/node-sdk";
import { join } from "node:path";
import { deleteChatSessionBinding, bindingToCommandSession, formatCurrentChatSession, getChatSessionBinding, listChatSessionBindingsBySession, updateChatSessionBindingChatName, upsertChatSessionBinding } from "./chatBindings.js";
import { assertAppCredentialsReady, ConfigError, CONFIG_DIR, CONFIG_PATH, loadConfig } from "./config.js";
import { enqueueCommand, getCommandQueueStats, resolveCommandQueuePath, updateCommandStatusMetadata } from "./commandQueue.js";
import { findCodexSession, formatSelectedSessionWithSummary, listCodexSessions, parseCodexSessionControlCommand } from "./codexSessions.js";
import { FeishuClient } from "./feishuClient.js";
import { buildCodexSessionListCard, parseSelectSessionActionValue } from "./sessionCard.js";
import { buildCommandStatusCard } from "./statusCard.js";
const IMAGE_CANDIDATE_TTL_MS = 5 * 60 * 1000;
const IMAGE_CANDIDATE_MAX_PER_SENDER = 5;
const DEFAULT_IMAGE_TASK_TEXT = "请识别并分析这张图片。";
export class FeishuCommandListener {
    options;
    wsClient;
    handledMessageIds = new Set();
    recentImageCandidates = new Map();
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
            const queuePath = resolveCommandQueuePath(config);
            const imageCandidates = extractImageCandidates(data);
            if (imageCandidates.length > 0 && shouldCacheImageOnly(data, config)) {
                this.cacheImageCandidates(imageCandidates);
                stderrLogger.info("[inbound]", "cached image candidate", JSON.stringify({
                    messageId: data.message.message_id,
                    chatId: data.message.chat_id,
                    senderKey: imageCandidates[0]?.senderKey,
                    imageCount: imageCandidates.length
                }));
                return;
            }
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
                await this.handleSessionControlCommand(control, extracted.command, config, queuePath, feishuClient);
                return;
            }
            const resourceCandidates = imageCandidates.length > 0
                ? imageCandidates
                : this.consumeRecentImageCandidates(extracted.command, Date.now());
            if (imageCandidates.length === 0 &&
                resourceCandidates.length === 0 &&
                shouldAttachRecentImage(extracted.command.text)) {
                this.ignoredCount += 1;
                await feishuClient.sendTextMessage(config, {
                    receiveIdType: "chat_id",
                    receiveId: extracted.command.chatId
                }, "没找到最近图片，请重新发送图片或把图片和 @ 指令放在一起。");
                stderrLogger.info("[inbound]", "ignored image task without recent candidate", JSON.stringify({
                    messageId: extracted.command.messageId,
                    chatId: extracted.command.chatId
                }));
                return;
            }
            let attachments;
            if (resourceCandidates.length > 0) {
                try {
                    attachments = await this.downloadImageAttachments(config, resourceCandidates, feishuClient);
                }
                catch (error) {
                    this.ignoredCount += 1;
                    await feishuClient.sendTextMessage(config, {
                        receiveIdType: "chat_id",
                        receiveId: extracted.command.chatId
                    }, `图片下载失败：${formatError(error)}`);
                    stderrLogger.info("[inbound]", "ignored image task after download failure", JSON.stringify({
                        messageId: extracted.command.messageId,
                        chatId: extracted.command.chatId,
                        error: formatError(error)
                    }));
                    return;
                }
            }
            const commandText = extracted.command.text || (attachments?.length ? DEFAULT_IMAGE_TASK_TEXT : "");
            if (!commandText) {
                this.ignoredCount += 1;
                await feishuClient.sendTextMessage(config, {
                    receiveIdType: "chat_id",
                    receiveId: extracted.command.chatId
                }, "请补充要执行的指令，或发送图片后 @机器人 说明要识别的内容。");
                return;
            }
            const binding = await getChatSessionBinding(queuePath, extracted.command.chatId);
            const session = binding ? bindingToCommandSession(binding) : undefined;
            if (!session) {
                this.ignoredCount += 1;
                await this.sendSessionSelectionCard(config, extracted.command, feishuClient, {
                    title: "当前群尚未绑定 Codex 会话",
                    notice: [
                        "**当前群尚未绑定 Codex 会话，所以这条任务暂未入队。**",
                        "",
                        "请先选择一个会话绑定到当前群，绑定成功后重新发送刚才的指令。"
                    ].join("\n")
                });
                stderrLogger.info("[inbound]", "ignored command without chat session binding", JSON.stringify({
                    messageId: extracted.command.messageId,
                    chatId: extracted.command.chatId
                }));
                return;
            }
            let { command, inserted } = await enqueueCommand({
                ...extracted.command,
                text: commandText,
                attachments,
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
            }
            if (inserted && config.inbound.acknowledgeOnReceive) {
                command = await this.sendQueuedStatusCard(config, command, queuePath, feishuClient);
            }
            if (inserted) {
                await this.options.onCommandEnqueued?.(command);
            }
        }
        catch (error) {
            this.lastError = formatError(error);
            stderrLogger.error("[inbound]", "failed to handle message", this.lastError);
        }
    }
    async sendQueuedStatusCard(config, command, queuePath, feishuClient) {
        const statusSummary = "任务已收到，正在等待 runtime 调度。";
        const statusUpdatedAt = new Date().toISOString();
        try {
            const result = await feishuClient.sendInteractiveMessageToReceiver(config, {
                receiveIdType: "chat_id",
                receiveId: command.chatId
            }, buildCommandStatusCard(command, config, {
                phase: "queued",
                progressSummary: statusSummary,
                nowMs: Date.parse(statusUpdatedAt)
            }));
            const updated = await updateCommandStatusMetadata(command.id, queuePath, {
                statusMessageId: result.messageId,
                statusUpdatedAt,
                statusNotifyError: result.messageId ? null : "Feishu status card did not return message_id",
                statusSummary
            });
            stderrLogger.info("[inbound]", "sent queued status card", JSON.stringify({
                commandId: command.id,
                chatId: command.chatId,
                statusMessageId: result.messageId
            }));
            return updated ?? command;
        }
        catch (error) {
            const statusNotifyError = formatError(error);
            await updateCommandStatusMetadata(command.id, queuePath, {
                statusUpdatedAt,
                statusNotifyError,
                statusSummary
            });
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: command.chatId
            }, config.inbound.acknowledgementText);
            stderrLogger.info("[inbound]", "sent fallback acknowledgement", JSON.stringify({
                commandId: command.id,
                chatId: command.chatId,
                statusNotifyError
            }));
            return command;
        }
    }
    async handleSessionControlCommand(control, command, config, queuePath, feishuClient) {
        if (control.type === "list-session") {
            await this.sendSessionSelectionCard(config, command, feishuClient);
            return;
        }
        if (control.type === "current-session") {
            const binding = await getChatSessionBinding(queuePath, command.chatId);
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: command.chatId
            }, formatCurrentChatSession(binding));
            stderrLogger.info("[inbound]", "handled control command", JSON.stringify({
                control: "current-session",
                status: "done",
                title: "Current chat Codex session",
                messageId: command.messageId,
                chatId: command.chatId
            }));
            return;
        }
        if (control.type === "unbind-session") {
            const binding = await deleteChatSessionBinding(queuePath, command.chatId);
            const summary = binding
                ? [
                    "已解除当前群与 Codex 会话的绑定。",
                    "",
                    `群：${formatChatBindingLabel(binding)}`,
                    `原会话：${binding.sessionTitle || "(untitled)"} (${shortId(binding.sessionId)})`,
                    "",
                    "后续普通任务会先要求重新绑定 Codex 会话。"
                ].join("\n")
                : "当前群没有绑定 Codex 会话，无需解绑。";
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: command.chatId
            }, summary);
            stderrLogger.info("[inbound]", "handled control command", JSON.stringify({
                control: "unbind-session",
                status: "done",
                title: "Chat Codex session unbound",
                messageId: command.messageId,
                chatId: command.chatId,
                sessionId: binding?.sessionId
            }));
            return;
        }
        const session = await findCodexSession(config.codex, control.selector);
        if (!session) {
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: command.chatId
            }, `没有找到可介入的 Codex 会话：${control.selector}\n\n请先发送 list-session 查看可用会话。`);
            stderrLogger.info("[inbound]", "failed to select chat session", JSON.stringify({
                messageId: command.messageId,
                chatId: command.chatId,
                selector: control.selector
            }));
            return;
        }
        const summary = await this.bindChatToSession(config, queuePath, {
            chatId: command.chatId,
            chatType: command.chatType
        }, session, feishuClient);
        await feishuClient.sendTextMessage(config, {
            receiveIdType: "chat_id",
            receiveId: command.chatId
        }, summary);
        stderrLogger.info("[inbound]", "handled control command", JSON.stringify({
            control: "select-session",
            status: "done",
            title: "Chat Codex session selected",
            messageId: command.messageId,
            chatId: command.chatId,
            sessionId: session.id
        }));
    }
    async sendSessionSelectionCard(config, command, feishuClient, options = {}) {
        const sessions = await listCodexSessions(config.codex);
        await feishuClient.sendInteractiveMessageToReceiver(config, {
            receiveIdType: "chat_id",
            receiveId: command.chatId
        }, buildCodexSessionListCard(sessions, config.codex.sessionListLimit, options));
        stderrLogger.info("[inbound]", "sent session selection card", JSON.stringify({
            messageId: command.messageId,
            chatId: command.chatId,
            sessions: sessions.length
        }));
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
            const queuePath = resolveCommandQueuePath(config);
            const session = await findCodexSession(config.codex, sessionId);
            const summary = session
                ? await this.bindChatToSession(config, queuePath, {
                    chatId: event.chatId
                }, session, feishuClient)
                : `没有找到可介入的 Codex 会话：${sessionId}\n\n请先发送 list-session 查看可用会话。`;
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: event.chatId
            }, summary);
            stderrLogger.info("[card]", "handled session selection action", JSON.stringify({
                status: session ? "done" : "failed",
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
    async bindChatToSession(config, queuePath, chat, session, feishuClient) {
        const chatInfo = await this.getChatInfoSafely(config, chat.chatId, feishuClient);
        const sharedNotice = await this.formatSharedSessionNotice(config, queuePath, session.id, chat.chatId, feishuClient);
        await upsertChatSessionBinding(queuePath, {
            chatId: chat.chatId,
            chatType: chat.chatType ?? chatInfo?.chatType,
            chatName: chatInfo?.name,
            session
        });
        return [
            "已为当前群绑定 Codex 会话。",
            chatInfo?.name ? `当前群：${chatInfo.name}` : undefined,
            "",
            await formatSelectedSessionWithSummary(session),
            sharedNotice ? `\n${sharedNotice}` : undefined
        ].filter((line) => line !== undefined).join("\n");
    }
    async formatSharedSessionNotice(config, queuePath, sessionId, currentChatId, feishuClient) {
        const bindings = await listChatSessionBindingsBySession(queuePath, sessionId, {
            excludeChatId: currentChatId,
            limit: 10
        });
        if (bindings.length === 0)
            return undefined;
        const lines = [
            "注意：这个 Codex 会话已绑定到其他群。继续绑定后，这些群会共享同一 Codex 上下文，并按同一个 session 串行执行："
        ];
        for (const [index, binding] of bindings.entries()) {
            let chatName = binding.chatName;
            if (!chatName) {
                const chatInfo = await this.getChatInfoSafely(config, binding.chatId, feishuClient);
                chatName = chatInfo?.name;
                if (chatName) {
                    await updateChatSessionBindingChatName(queuePath, binding.chatId, chatName);
                }
            }
            lines.push(`${index + 1}. ${formatChatBindingLabel({ ...binding, chatName })}`);
        }
        if (bindings.length >= 10) {
            lines.push("还有更多已绑定群，已只展示最近 10 个。");
        }
        return lines.join("\n");
    }
    async getChatInfoSafely(config, chatId, feishuClient) {
        try {
            return await feishuClient.getChatInfo(config, chatId);
        }
        catch (error) {
            stderrLogger.info("[inbound]", "failed to resolve chat info", JSON.stringify({
                chatId,
                error: formatError(error)
            }));
            return undefined;
        }
    }
    cacheImageCandidates(candidates) {
        const nowMs = Date.now();
        for (const candidate of candidates) {
            const key = imageCandidateMapKey(candidate.chatId, candidate.senderKey);
            const current = (this.recentImageCandidates.get(key) ?? [])
                .filter((item) => nowMs - item.createdAtMs <= IMAGE_CANDIDATE_TTL_MS);
            current.push(candidate);
            this.recentImageCandidates.set(key, current.slice(-IMAGE_CANDIDATE_MAX_PER_SENDER));
        }
    }
    consumeRecentImageCandidates(command, nowMs) {
        if (!shouldAttachRecentImage(command.text))
            return [];
        const senderKey = senderCandidateKey(command.sender);
        if (!senderKey)
            return [];
        const key = imageCandidateMapKey(command.chatId, senderKey);
        const current = (this.recentImageCandidates.get(key) ?? [])
            .filter((item) => nowMs - item.createdAtMs <= IMAGE_CANDIDATE_TTL_MS);
        if (current.length === 0) {
            this.recentImageCandidates.delete(key);
            return [];
        }
        const selected = dedupeImageCandidates(current);
        this.recentImageCandidates.delete(key);
        return selected;
    }
    async downloadImageAttachments(config, candidates, feishuClient) {
        const attachments = [];
        for (const [index, candidate] of candidates.entries()) {
            const outputPath = join(CONFIG_DIR, "resources", safePathSegment(candidate.chatId), safePathSegment(candidate.messageId), `image-${index + 1}-${safePathSegment(candidate.resourceKey)}.png`);
            const downloaded = await feishuClient.downloadMessageResource(config, candidate.messageId, candidate.resourceKey, outputPath);
            attachments.push({
                type: "image",
                source: "feishu",
                path: downloaded.path,
                messageId: candidate.messageId,
                resourceKey: candidate.resourceKey,
                mimeType: downloaded.mimeType,
                sizeBytes: downloaded.sizeBytes,
                sha256: downloaded.sha256
            });
        }
        return attachments;
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
    if (!["text", "image", "post"].includes(message.message_type)) {
        return { ignoredReason: `unsupported message_type=${message.message_type}` };
    }
    const senderOpenId = sender.sender_id?.open_id;
    if (config.inbound.allowedOpenIds?.length &&
        (!senderOpenId || !config.inbound.allowedOpenIds.includes(senderOpenId))) {
        return { ignoredReason: "sender not allowed" };
    }
    const rawText = readMessageText(message.message_type, message.content);
    if (!hasRequiredMention(event, config, rawText)) {
        return { ignoredReason: "missing bot mention" };
    }
    const text = stripAtMentions(rawText, (message.mentions ?? []).map((mention) => mention.key));
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
function extractImageCandidates(event) {
    if (event.message.message_type !== "image" && event.message.message_type !== "post")
        return [];
    const senderKey = senderCandidateKey({
        openId: event.sender.sender_id?.open_id,
        userId: event.sender.sender_id?.user_id,
        unionId: event.sender.sender_id?.union_id,
        senderType: event.sender.sender_type
    });
    if (!senderKey)
        return [];
    const resourceKeys = readImageResourceKeys(event.message.content);
    const createdAtMs = parseFeishuTimeMs(event.message.create_time);
    return resourceKeys.map((resourceKey) => ({
        chatId: event.message.chat_id,
        chatType: event.message.chat_type,
        senderKey,
        messageId: event.message.message_id,
        resourceKey,
        createdAtMs
    }));
}
function shouldCacheImageOnly(event, config) {
    if (event.message.chat_type === "p2p")
        return false;
    return !hasRequiredMention(event, config, readMessageText(event.message.message_type, event.message.content));
}
function readTextContent(content) {
    return readOptionalTextContent(content) ?? content;
}
function readMessageText(messageType, content) {
    if (messageType === "text")
        return readTextContent(content);
    if (messageType === "post")
        return readPostTextContent(content);
    return readOptionalTextContent(content) ?? "";
}
function readOptionalTextContent(content) {
    try {
        const parsed = JSON.parse(content);
        if (isObject(parsed) && typeof parsed.text === "string") {
            return parsed.text;
        }
    }
    catch {
        return content;
    }
    return undefined;
}
function readImageResourceKeys(content) {
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return [];
    }
    if (!isObject(parsed))
        return [];
    const keys = [
        stringProperty(parsed, "image_key"),
        stringProperty(parsed, "file_key"),
        ...collectPostImageKeys(parsed)
    ].filter((item) => Boolean(item));
    return Array.from(new Set(keys));
}
function readPostTextContent(content) {
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return content;
    }
    if (!isObject(parsed))
        return "";
    const posts = getPostPayloads(parsed);
    const parts = [];
    for (const post of posts) {
        const title = stringProperty(post, "title");
        if (title)
            parts.push(title);
        for (const item of flattenPostContent(post.content)) {
            if (!isObject(item))
                continue;
            const tag = stringProperty(item, "tag");
            if (tag === "text" || tag === "a") {
                const text = stringProperty(item, "text");
                if (text)
                    parts.push(text);
            }
            else if (tag === "at") {
                const userId = stringProperty(item, "user_id") ?? stringProperty(item, "open_id");
                const userName = stringProperty(item, "user_name") ?? stringProperty(item, "text");
                if (userId || userName) {
                    parts.push(`<at user_id="${userId ?? ""}">${userName ?? ""}</at>`);
                }
            }
            else {
                const text = stringProperty(item, "text");
                if (text)
                    parts.push(text);
            }
        }
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
}
function collectPostImageKeys(value) {
    const keys = [];
    for (const post of getPostPayloads(value)) {
        for (const item of flattenPostContent(post.content)) {
            if (!isObject(item))
                continue;
            const tag = stringProperty(item, "tag");
            if (tag === "img" || tag === "image") {
                const imageKey = stringProperty(item, "image_key") ?? stringProperty(item, "file_key");
                if (imageKey)
                    keys.push(imageKey);
            }
        }
    }
    return keys;
}
function getPostPayloads(value) {
    if (!isObject(value))
        return [];
    const post = value.post;
    if (isObject(post)) {
        const localized = Object.values(post).filter(isObject);
        return localized.length > 0 ? localized : [post];
    }
    return [value];
}
function flattenPostContent(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((item) => Array.isArray(item) ? flattenPostContent(item) : [item]);
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
function shouldAttachRecentImage(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return true;
    return /(图|图片|截图|照片|相片|这张|image|photo|screenshot)/i.test(trimmed);
}
function senderCandidateKey(sender) {
    return sender.openId || sender.userId || sender.unionId;
}
function imageCandidateMapKey(chatId, senderKey) {
    return `${chatId}\n${senderKey}`;
}
function dedupeImageCandidates(candidates) {
    const seen = new Set();
    const deduped = [];
    for (const candidate of candidates) {
        const key = `${candidate.messageId}\n${candidate.resourceKey}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(candidate);
    }
    return deduped;
}
function parseFeishuTimeMs(value) {
    if (!value)
        return Date.now();
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? timestamp : Date.now();
}
function safePathSegment(value) {
    return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
function formatChatBindingLabel(binding) {
    return binding.chatName
        ? `${binding.chatName} (${shortId(binding.chatId)})`
        : `未知群名 (${binding.chatId})`;
}
function shortId(value) {
    return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}
function stringProperty(value, key) {
    const item = value[key];
    return typeof item === "string" && item.length > 0 ? item : undefined;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
