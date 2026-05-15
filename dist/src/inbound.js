import * as lark from "@larksuiteoapi/node-sdk";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { deleteChatSessionBinding, bindingToCommandSession, formatCurrentChatProject, formatCurrentChatSession, getChatSessionBinding, listChatSessionBindingsBySession, updateChatSessionBindingChatName, upsertChatSessionBinding } from "./chatBindings.js";
import { assertAppCredentialsReady, ConfigError, CONFIG_DIR, CONFIG_PATH, loadConfig } from "./config.js";
import { enqueueCommand, getCommandQueueStats, resolveCommandQueuePath, updateCommandStatusMetadata } from "./commandQueue.js";
import { findCodexSession, findCodexProject, formatSelectedSessionWithSummary, listCodexProjects, listCodexSessions, parseCodexSessionControlCommand } from "./codexSessions.js";
import { runCodexNewSession } from "./codexCli.js";
import { FeishuClient } from "./feishuClient.js";
import { buildCodexHelpCard, buildCodexProjectListCard, buildCodexSessionListCard, parseCodexCardActionValue } from "./sessionCard.js";
import { buildCommandStatusCard } from "./statusCard.js";
const IMAGE_CANDIDATE_TTL_MS = 5 * 60 * 1000;
const IMAGE_CANDIDATE_MAX_PER_SENDER = 5;
const DEFAULT_IMAGE_TASK_TEXT = "请识别并分析这张图片。";
const SESSION_PAGE_SIZE = 10;
const NEW_SESSION_DISCOVERY_RETRIES = 12;
const NEW_SESSION_DISCOVERY_INTERVAL_MS = 250;
const DEFAULT_NEW_SESSION_PROMPT = [
    "你正在初始化一个来自飞书群聊的 Codex 新会话。",
    "请不要调用任何飞书发送工具；外层 feishu-agent-bridge 会负责通知用户。",
    "只需要简短回复：新会话已创建。"
].join("\n");
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
                await this.sendProjectSelectionCard(config, extracted.command, feishuClient, {
                    title: "当前群尚未绑定 Codex project",
                    notice: [
                        "**当前群尚未绑定 Codex project，所以这条任务暂未入队。**",
                        "",
                        "请先选择一个 project 绑定到当前群，绑定成功后会自动选中该 project 最近更新的 session。然后重新发送刚才的指令。"
                    ].join("\n")
                });
                stderrLogger.info("[inbound]", "ignored command without chat project binding", JSON.stringify({
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
        if (control.type === "help") {
            const binding = await getChatSessionBinding(queuePath, command.chatId);
            await feishuClient.sendInteractiveMessageToReceiver(config, {
                receiveIdType: "chat_id",
                receiveId: command.chatId
            }, buildCodexHelpCard({
                projectLabel: binding?.projectDisplayLabel,
                sessionTitle: binding?.sessionTitle,
                sessionId: binding?.sessionId,
                isTemporary: binding?.projectKind === "temporary"
            }));
            this.logHandledControl("help", command);
            return;
        }
        if (control.type === "list-project") {
            await this.sendProjectSelectionCard(config, command, feishuClient, {
                page: control.page
            });
            this.logHandledControl("list-project", command);
            return;
        }
        if (control.type === "select-project") {
            const summary = await this.selectProjectForChat(config, queuePath, {
                chatId: command.chatId,
                chatType: command.chatType
            }, control.selector, feishuClient);
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: command.chatId
            }, summary);
            this.logHandledControl("select-project", command);
            return;
        }
        if (control.type === "new-session") {
            await this.createNewSessionForChat(config, queuePath, {
                chatId: command.chatId,
                chatType: command.chatType,
                messageId: command.messageId
            }, control.prompt, feishuClient);
            this.logHandledControl("new-session", command);
            return;
        }
        if (control.type === "list-session") {
            if (control.mode === "all" || control.mode === "temp") {
                await this.sendSessionPage(config, command, feishuClient, {
                    mode: control.mode,
                    page: control.page
                });
                this.logHandledControl(`list-session-${control.mode}`, command);
                return;
            }
            const binding = await getChatSessionBinding(queuePath, command.chatId);
            if (!binding?.projectId) {
                await this.sendProjectSelectionCard(config, command, feishuClient, {
                    title: "当前群尚未绑定 Codex project",
                    notice: "请先绑定 project。绑定后 `list-session` 只展示该 project 下的会话。"
                });
                this.logHandledControl("list-session-unbound", command);
                return;
            }
            await this.sendSessionPage(config, command, feishuClient, {
                mode: "project",
                page: control.page,
                projectId: binding.projectId,
                projectLabel: binding.projectDisplayLabel
            });
            this.logHandledControl("list-session-project", command);
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
        if (control.type === "current-project") {
            const binding = await getChatSessionBinding(queuePath, command.chatId);
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: command.chatId
            }, formatCurrentChatProject(binding));
            this.logHandledControl("current-project", command);
            return;
        }
        if (control.type === "unbind-project" || control.type === "unbind-session") {
            await this.unbindProjectForChat(config, queuePath, command, feishuClient, control.type);
            return;
        }
        const summary = await this.selectSessionForChat(config, queuePath, {
            chatId: command.chatId,
            chatType: command.chatType
        }, control.selector, feishuClient);
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
            selector: control.selector
        }));
    }
    async sendProjectSelectionCard(config, command, feishuClient, options = {}) {
        const projects = await listCodexProjects(config.codex);
        const page = paginate(projects, options.page ?? 1, SESSION_PAGE_SIZE);
        await feishuClient.sendInteractiveMessageToReceiver(config, {
            receiveIdType: "chat_id",
            receiveId: command.chatId
        }, buildCodexProjectListCard(page.items, SESSION_PAGE_SIZE, {
            ...options,
            pageInfo: page.info
        }));
        stderrLogger.info("[inbound]", "sent project selection card", JSON.stringify({
            messageId: command.messageId,
            chatId: command.chatId,
            page: page.info.page,
            total: page.info.total,
            projects: projects.length
        }));
    }
    async sendSessionPage(config, command, feishuClient, options) {
        const sessions = await listCodexSessions(config.codex, {
            all: true,
            includeTemporary: options.mode === "all" ? true : undefined,
            temporaryOnly: options.mode === "temp",
            projectId: options.projectId
        });
        const page = paginate(sessions, options.page, SESSION_PAGE_SIZE);
        const title = options.mode === "temp"
            ? "临时 Codex 对话"
            : options.mode === "all"
                ? "全部 Codex 会话"
                : "当前 project 下的 Codex 会话";
        await feishuClient.sendInteractiveMessageToReceiver(config, {
            receiveIdType: "chat_id",
            receiveId: command.chatId
        }, buildCodexSessionListCard(page.items, SESSION_PAGE_SIZE, {
            title,
            mode: options.mode,
            projectId: options.projectId,
            projectLabel: options.projectLabel,
            pageInfo: page.info
        }));
        stderrLogger.info("[inbound]", "sent session page card", JSON.stringify({
            messageId: command.messageId,
            chatId: command.chatId,
            mode: options.mode,
            page: page.info.page,
            total: page.info.total
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
        const action = parseCodexCardActionValue(event.action.value);
        if (!action) {
            this.ignoredCount += 1;
            stderrLogger.info("[card]", "ignored unrelated card action", JSON.stringify({
                messageId: event.messageId,
                chatId: event.chatId,
                actionTag: event.action.tag
            }));
            return;
        }
        await this.completeCardAction(event, action, feishuClient);
    }
    async completeCardAction(event, action, feishuClient) {
        try {
            const configPath = this.options.configPath ?? CONFIG_PATH;
            const config = await loadConfig(configPath);
            const queuePath = resolveCommandQueuePath(config);
            if (action.type === "list-session-page") {
                const binding = action.mode === "project"
                    ? await getChatSessionBinding(queuePath, event.chatId)
                    : undefined;
                await this.sendSessionPage(config, {
                    messageId: event.messageId,
                    chatId: event.chatId
                }, feishuClient, {
                    mode: action.mode,
                    page: action.page,
                    projectId: action.projectId ?? binding?.projectId,
                    projectLabel: binding?.projectDisplayLabel
                });
                return;
            }
            if (action.type === "list-project-page") {
                await this.sendProjectSelectionCard(config, {
                    messageId: event.messageId,
                    chatId: event.chatId
                }, feishuClient, {
                    page: action.page
                });
                return;
            }
            if (action.type === "run-command") {
                const control = parseCodexSessionControlCommand(action.command);
                if (!control) {
                    this.ignoredCount += 1;
                    return;
                }
                await this.handleSessionControlCommand(control, {
                    text: action.command,
                    rawText: action.command,
                    messageId: event.messageId,
                    chatId: event.chatId,
                    sender: {
                        openId: event.operator.openId
                    }
                }, config, queuePath, feishuClient);
                return;
            }
            const summary = action.type === "bind-project"
                ? await this.selectProjectForChat(config, queuePath, {
                    chatId: event.chatId
                }, action.projectId, feishuClient)
                : await this.selectSessionForChat(config, queuePath, {
                    chatId: event.chatId
                }, action.sessionId, feishuClient);
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: event.chatId
            }, summary);
            stderrLogger.info("[card]", "handled codex card action", JSON.stringify({
                status: "done",
                action: action.type,
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
    async createNewSessionForChat(config, queuePath, chat, prompt, feishuClient) {
        const binding = await getChatSessionBinding(queuePath, chat.chatId);
        if (!binding?.projectId) {
            await this.sendProjectSelectionCard(config, chat, feishuClient, {
                title: "当前群尚未绑定 Codex project",
                notice: "请先绑定 project；绑定后可发送 `new-session` 在当前 project 下开启新会话。"
            });
            return;
        }
        if (binding.projectKind === "temporary") {
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: chat.chatId
            }, [
                "当前群绑定的是临时对话，不能在 temporary 下创建新的 project 会话。",
                "请先发送 list-project 绑定一个 Codex project。"
            ].join("\n"));
            return;
        }
        const projectRootPath = binding.projectRootPath ?? binding.sessionCwd;
        if (!projectRootPath) {
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: chat.chatId
            }, "当前群绑定缺少 project root，无法创建新 Codex 会话。请重新发送 list-project 绑定 project。");
            return;
        }
        if (!config.codex.enabled) {
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: chat.chatId
            }, "Codex CLI 未启用，无法创建新会话。请先在配置中设置 codex.enabled=true。");
            return;
        }
        const beforeSessions = await listCodexSessions(config.codex, {
            all: true,
            includeTemporary: true,
            projectId: binding.projectId
        });
        const beforeIds = new Set(beforeSessions.map((session) => session.id));
        const startedAtSeconds = Math.floor(Date.now() / 1000) - 2;
        await feishuClient.sendTextMessage(config, {
            receiveIdType: "chat_id",
            receiveId: chat.chatId
        }, [
            "正在当前 project 下创建新的 Codex 会话。",
            binding.projectDisplayLabel ? `project: ${binding.projectDisplayLabel}` : undefined
        ].filter((line) => line !== undefined).join("\n"));
        const outputPath = join(config.codex.outputDir ?? join(CONFIG_DIR, "codex-output"), `new-session-${safePathSegment(chat.chatId)}-${Date.now()}.txt`);
        const result = await runCodexNewSession(prompt?.trim() || DEFAULT_NEW_SESSION_PROMPT, config.codex, {
            cwd: projectRootPath,
            outputPath
        });
        const session = await this.findCreatedProjectSession(config, binding.projectId, beforeIds, startedAtSeconds);
        if (!session) {
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: chat.chatId
            }, [
                result.ok ? "Codex CLI 已返回，但暂未在本地 state DB 中识别到新会话。" : "Codex CLI 创建新会话失败。",
                summarizeCodexNewSessionResult(result),
                "",
                "请稍后发送 list-session 查看是否已落盘，或重试 new-session。"
            ].join("\n"));
            return;
        }
        const summary = await this.bindChatToSession(config, queuePath, chat, session, feishuClient);
        await feishuClient.sendTextMessage(config, {
            receiveIdType: "chat_id",
            receiveId: chat.chatId
        }, [
            "已在当前 project 下创建并绑定新的 active session。",
            "",
            summary,
            "",
            summarizeCodexNewSessionResult(result)
        ].join("\n"));
    }
    async findCreatedProjectSession(config, projectId, beforeIds, startedAtSeconds) {
        for (let attempt = 0; attempt <= NEW_SESSION_DISCOVERY_RETRIES; attempt += 1) {
            const sessions = await listCodexSessions(config.codex, {
                all: true,
                includeTemporary: true,
                projectId
            });
            const newSession = sessions.find((session) => !beforeIds.has(session.id));
            if (newSession)
                return newSession;
            const recentSession = sessions.find((session) => session.createdAt >= startedAtSeconds);
            if (recentSession)
                return recentSession;
            if (attempt < NEW_SESSION_DISCOVERY_RETRIES) {
                await sleep(NEW_SESSION_DISCOVERY_INTERVAL_MS);
            }
        }
        return undefined;
    }
    async selectProjectForChat(config, queuePath, chat, selector, feishuClient) {
        const project = await findCodexProject(config.codex, selector);
        if (!project) {
            return `没有找到可绑定的 Codex project：${selector}\n\n请先发送 list-project 查看可用 project。`;
        }
        return this.bindChatToProject(config, queuePath, chat, project, feishuClient);
    }
    async selectSessionForChat(config, queuePath, chat, selector, feishuClient) {
        const binding = await getChatSessionBinding(queuePath, chat.chatId);
        const scopedSession = binding?.projectId
            ? await findCodexSession(config.codex, selector, {
                projectId: binding.projectId,
                includeTemporary: binding.projectKind === "temporary"
            })
            : undefined;
        if (scopedSession) {
            return this.bindChatToSession(config, queuePath, chat, scopedSession, feishuClient);
        }
        const globalSession = await findCodexSession(config.codex, selector, {
            all: true,
            includeTemporary: true
        });
        if (!globalSession) {
            return `没有找到可介入的 Codex 会话：${selector}\n\n请先发送 list-session 查看可用会话。`;
        }
        if (!binding?.projectId) {
            if (globalSession.isTemporary) {
                return this.bindChatToSession(config, queuePath, chat, globalSession, feishuClient);
            }
            return [
                "当前群尚未绑定 Codex project。",
                "",
                `会话 ${globalSession.title || "(untitled)"} 属于 project：${globalSession.projectDisplayLabel ?? "(unknown)"}`,
                "请先发送 list-project 或 bind-project <序号|projectId> 绑定 project。"
            ].join("\n");
        }
        if (globalSession.projectId !== binding.projectId) {
            return [
                "这个会话不属于当前群绑定的 project，已拒绝切换。",
                "",
                `当前 project：${binding.projectDisplayLabel ?? binding.projectId}`,
                `目标 project：${globalSession.projectDisplayLabel ?? globalSession.projectId ?? "(unknown)"}`,
                "",
                "如需跨 project，请先发送 switch-project <序号|projectId>。"
            ].join("\n");
        }
        return this.bindChatToSession(config, queuePath, chat, globalSession, feishuClient);
    }
    async bindChatToProject(config, queuePath, chat, project, feishuClient) {
        const session = project.latestSession;
        const summary = await this.bindChatToSession(config, queuePath, chat, session, feishuClient);
        return [
            "已为当前群绑定 Codex project，并自动选中最近更新的 active session。",
            "",
            `project: ${project.displayLabel}`,
            `sessions: ${project.sessionCount}`,
            "",
            summary
        ].join("\n");
    }
    async unbindProjectForChat(config, queuePath, command, feishuClient, control) {
        const binding = await deleteChatSessionBinding(queuePath, command.chatId);
        const summary = binding
            ? [
                "已解除当前群与 Codex project / session 的绑定。",
                "",
                `群：${formatChatBindingLabel(binding)}`,
                binding.projectDisplayLabel ? `原 project：${binding.projectDisplayLabel}` : undefined,
                `原 active session：${binding.sessionTitle || "(untitled)"} (${shortId(binding.sessionId)})`,
                "",
                "后续普通任务会先要求重新绑定 Codex project。"
            ].filter((line) => line !== undefined).join("\n")
            : "当前群没有绑定 Codex project，无需解绑。";
        await feishuClient.sendTextMessage(config, {
            receiveIdType: "chat_id",
            receiveId: command.chatId
        }, summary);
        stderrLogger.info("[inbound]", "handled control command", JSON.stringify({
            control,
            status: "done",
            title: "Chat Codex project unbound",
            messageId: command.messageId,
            chatId: command.chatId,
            sessionId: binding?.sessionId
        }));
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
            session.isTemporary
                ? "已为当前群临时介入 Codex 对话。"
                : "已为当前群绑定 Codex project / active session。",
            chatInfo?.name ? `当前群：${chatInfo.name}` : undefined,
            session.projectDisplayLabel ? `当前 project：${session.projectDisplayLabel}` : undefined,
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
    logHandledControl(control, command) {
        stderrLogger.info("[inbound]", "handled control command", JSON.stringify({
            control,
            status: "done",
            messageId: command.messageId,
            chatId: command.chatId
        }));
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
function paginate(items, requestedPage, pageSize) {
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, requestedPage), totalPages);
    const offset = (page - 1) * pageSize;
    return {
        items: items.slice(offset, offset + pageSize),
        info: {
            page,
            pageSize,
            total,
            totalPages,
            hasPrev: page > 1,
            hasNext: page < totalPages
        }
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
function summarizeCodexNewSessionResult(result) {
    const body = (result.lastMessage || result.stdout || result.stderr).trim();
    const status = result.ok
        ? `Codex CLI completed in ${result.durationMs}ms.`
        : result.timedOut
            ? `Codex CLI timed out after ${result.durationMs}ms.`
            : `Codex CLI exited with code ${result.exitCode ?? "null"}${result.signal ? ` signal=${result.signal}` : ""}.`;
    const lines = [status];
    if (body)
        lines.push(body);
    lines.push(`output: ${result.outputPath}`);
    return lines.join("\n");
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
