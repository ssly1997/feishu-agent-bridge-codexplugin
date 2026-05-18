import * as lark from "@larksuiteoapi/node-sdk";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { clearChatActiveSession, deleteChatSessionBinding, bindingToCommandSession, formatCurrentChatProject, formatCurrentChatSession, getChatSessionBinding, listChatSessionBindingsBySession, updateChatSessionBindingChatName, upsertChatSessionBinding } from "./chatBindings.js";
import { assertAppCredentialsReady, ConfigError, CONFIG_DIR, CONFIG_PATH, loadConfig } from "./config.js";
import { enqueueCommand, getCommandQueueStats, listCommands, resolveCommandQueuePath, updateCommandStatusMetadata } from "./commandQueue.js";
import { findCodexSession, findCodexProject, formatSelectedSessionWithSummary, listCodexProjects, listCodexSessions, parseCodexSessionControlCommand } from "./codexSessions.js";
import { runCodexNewSession } from "./codexCli.js";
import { FeishuClient } from "./feishuClient.js";
import { formatGitBranchLine, formatGitBranchValueForCwd, readGitWorkingTreeStatus } from "./gitStatus.js";
import { buildCodexHelpCard, buildCodexProjectListCard, buildCodexSessionListCard, parseCodexCardActionValue } from "./sessionCard.js";
import { buildCommandStatusCard } from "./statusCard.js";
import { readStandaloneListenerRuntimeStatus } from "./listenerRuntime.js";
const IMAGE_CANDIDATE_TTL_MS = 5 * 60 * 1000;
const IMAGE_CANDIDATE_MAX_PER_SENDER = 5;
const DEFAULT_IMAGE_TASK_TEXT = "请识别并分析这张图片。";
const SESSION_PAGE_SIZE = 10;
const NEW_SESSION_DISCOVERY_RETRIES = 12;
const NEW_SESSION_DISCOVERY_INTERVAL_MS = 250;
const DEFAULT_NEW_SESSION_PROMPT = "新会话初始化";
const STATUS_RECENT_COMMAND_LIMIT = 10;
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
            if (!binding?.projectId) {
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
            const session = bindingToCommandSession(binding);
            if (!session) {
                this.ignoredCount += 1;
                await this.sendSessionPage(config, extracted.command, feishuClient, {
                    mode: "project",
                    page: 1,
                    projectId: binding.projectId,
                    projectLabel: binding.projectDisplayLabel,
                    notice: [
                        "**当前群已绑定 Codex project，但还没有 active session，所以这条任务暂未入队。**",
                        "",
                        "请先选择一个 session，或发送 `new-session` 在当前 project 下开启新会话。然后重新发送刚才的指令。"
                    ].join("\n")
                });
                stderrLogger.info("[inbound]", "ignored command without chat active session", JSON.stringify({
                    messageId: extracted.command.messageId,
                    chatId: extracted.command.chatId,
                    projectId: binding.projectId
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
            const gitBranch = await formatGitBranchValueForCwd(command.sessionCwd ?? config.codex.cwd);
            const result = await feishuClient.sendInteractiveMessageToReceiver(config, {
                receiveIdType: "chat_id",
                receiveId: command.chatId
            }, buildCommandStatusCard(command, config, {
                phase: "queued",
                progressSummary: statusSummary,
                nowMs: Date.parse(statusUpdatedAt),
                gitBranch
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
        if (control.type === "status") {
            const card = await this.buildCurrentChatWorkStatusCard(config, queuePath, command.chatId, {
                full: control.full
            });
            await feishuClient.sendInteractiveMessageToReceiver(config, {
                receiveIdType: "chat_id",
                receiveId: command.chatId
            }, card);
            this.logHandledControl("status", command);
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
        if (control.type === "unbind-project") {
            await this.unbindProjectForChat(config, queuePath, command, feishuClient);
            return;
        }
        if (control.type === "unbind-session") {
            await this.unbindSessionForChat(config, queuePath, command, feishuClient);
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
            notice: options.notice,
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
        const runState = { done: false };
        const runResultPromise = runCodexNewSession(prompt?.trim() || DEFAULT_NEW_SESSION_PROMPT, config.codex, {
            cwd: projectRootPath,
            outputPath
        }).then((result) => {
            runState.done = true;
            runState.result = result;
            return result;
        }, (error) => {
            runState.done = true;
            runState.error = error;
            return undefined;
        });
        let session = await this.findCreatedProjectSession(config, binding.projectId, beforeIds, startedAtSeconds);
        if (!session) {
            const result = await runResultPromise;
            session = await this.findCreatedProjectSession(config, binding.projectId, beforeIds, startedAtSeconds);
            if (session) {
                await this.sendNewSessionCreatedMessage(config, queuePath, chat, session, feishuClient, runState);
                return;
            }
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: chat.chatId
            }, [
                runState.error
                    ? "Codex CLI 创建新会话失败。"
                    : result?.ok
                        ? "Codex CLI 已返回，但暂未在本地 state DB 中识别到新会话。"
                        : "Codex CLI 创建新会话失败。",
                result ? summarizeCodexNewSessionResult(result) : formatError(runState.error),
                "",
                "请稍后发送 list-session 查看是否已落盘，或重试 new-session。"
            ].filter((line) => Boolean(line)).join("\n"));
            return;
        }
        const creationMessageIncludedRunResult = await this.sendNewSessionCreatedMessage(config, queuePath, chat, session, feishuClient, runState);
        if (!creationMessageIncludedRunResult) {
            const result = await runResultPromise;
            await feishuClient.sendTextMessage(config, {
                receiveIdType: "chat_id",
                receiveId: chat.chatId
            }, [
                result?.ok
                    ? "新会话初始化指令已完成。"
                    : "新会话已创建并绑定，但初始化指令执行未正常完成。",
                result ? summarizeCodexNewSessionResult(result) : formatError(runState.error)
            ].filter((line) => Boolean(line)).join("\n"));
        }
    }
    async sendNewSessionCreatedMessage(config, queuePath, chat, session, feishuClient, runState) {
        const summary = await this.bindChatToSession(config, queuePath, chat, session, feishuClient);
        const includesRunResult = runState.done;
        await feishuClient.sendTextMessage(config, {
            receiveIdType: "chat_id",
            receiveId: chat.chatId
        }, [
            "已在当前 project 下创建并绑定新的 active session。",
            "",
            summary,
            !includesRunResult ? "" : undefined,
            !includesRunResult ? "初始化指令仍在执行，完成后会再同步结果。" : undefined,
            includesRunResult && runState.result ? "" : undefined,
            includesRunResult && runState.result ? summarizeCodexNewSessionResult(runState.result) : undefined,
            includesRunResult && runState.error ? "" : undefined,
            includesRunResult && runState.error
                ? `Codex CLI 已创建会话，但初始化指令返回异常：${formatError(runState.error)}`
                : undefined
        ].filter((line) => line !== undefined).join("\n"));
        return includesRunResult;
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
    async buildCurrentChatWorkStatusCard(config, queuePath, chatId, options) {
        const binding = await getChatSessionBinding(queuePath, chatId);
        const gitStatus = await readGitWorkingTreeStatus(binding?.sessionCwd);
        const queue = await getCommandQueueStats(queuePath);
        const runtime = await readStandaloneListenerRuntimeStatus(this.options.configPath ?? CONFIG_PATH);
        const sessionStats = binding?.sessionId
            ? queue.sessions.find((item) => item.sessionId === binding.sessionId)
            : undefined;
        const commands = await listCommands(queuePath, {
            sessionId: binding?.sessionId
        });
        const recentCommands = commands.slice(-STATUS_RECENT_COMMAND_LIMIT).reverse();
        const nowMs = Date.now();
        const activeSessions = runtime?.scheduler?.activeSessions ?? [];
        const currentSessionActive = Boolean(binding?.sessionId && activeSessions.includes(binding.sessionId));
        const runningCommands = commands
            .filter((item) => item.state === "in_progress")
            .reverse();
        const context = {
            config,
            queuePath,
            chatId,
            binding,
            gitStatus,
            queue,
            runtime,
            sessionStats,
            commands,
            recentCommands,
            runningCommands,
            runningCommand: runningCommands[0],
            nowMs,
            currentSessionActive
        };
        return buildWorkStatusCard(context, options);
    }
    async unbindProjectForChat(config, queuePath, command, feishuClient) {
        const binding = await deleteChatSessionBinding(queuePath, command.chatId);
        const summary = binding
            ? [
                "已解除当前群与 Codex project / session 的绑定。",
                "",
                `群：${formatChatBindingLabel(binding)}`,
                binding.projectDisplayLabel ? `原 project：${binding.projectDisplayLabel}` : undefined,
                binding.sessionId
                    ? `原 active session：${binding.sessionTitle || "(untitled)"} (${shortId(binding.sessionId)})`
                    : "原 active session：未绑定",
                "",
                "后续普通任务会先要求重新绑定 Codex project。"
            ].filter((line) => line !== undefined).join("\n")
            : "当前群没有绑定 Codex project，无需解绑。";
        await feishuClient.sendTextMessage(config, {
            receiveIdType: "chat_id",
            receiveId: command.chatId
        }, summary);
        stderrLogger.info("[inbound]", "handled control command", JSON.stringify({
            control: "unbind-project",
            status: "done",
            title: "Chat Codex project unbound",
            messageId: command.messageId,
            chatId: command.chatId,
            sessionId: binding?.sessionId
        }));
    }
    async unbindSessionForChat(config, queuePath, command, feishuClient) {
        const before = await getChatSessionBinding(queuePath, command.chatId);
        const binding = await clearChatActiveSession(queuePath, command.chatId);
        const summary = !before
            ? "当前群没有绑定 Codex project。请先发送 list-project 选择一个 project。"
            : !before.sessionId
                ? [
                    "当前群已绑定 Codex project，但没有 active session，无需解绑 session。",
                    "",
                    before.projectDisplayLabel ? `当前 project：${before.projectDisplayLabel}` : undefined,
                    "后续可以发送 list-session 选择会话，或发送 new-session 在当前 project 下开启新会话。"
                ].filter((line) => line !== undefined).join("\n")
                : [
                    "已解除当前群 active session，保留 Codex project 绑定。",
                    "",
                    before.projectDisplayLabel ? `当前 project：${before.projectDisplayLabel}` : undefined,
                    `原 active session：${before.sessionTitle || "(untitled)"} (${shortId(before.sessionId)})`,
                    "",
                    "后续普通任务会先要求重新选择 session；也可以发送 new-session 在当前 project 下开启新会话。"
                ].filter((line) => line !== undefined).join("\n");
        await feishuClient.sendTextMessage(config, {
            receiveIdType: "chat_id",
            receiveId: command.chatId
        }, summary);
        stderrLogger.info("[inbound]", "handled control command", JSON.stringify({
            control: "unbind-session",
            status: "done",
            title: "Chat Codex active session unbound",
            messageId: command.messageId,
            chatId: command.chatId,
            projectId: binding?.projectId,
            sessionId: before?.sessionId
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
function buildWorkStatusCard(context, options) {
    const elements = [
        statusMarkdownBlock(formatStatusBindingSummary(context)),
        { tag: "hr" },
        statusMarkdownBlock(formatRunningTaskSummary(context)),
        { tag: "hr" },
        statusMarkdownBlock(formatQueueSummary(context)),
        { tag: "hr" },
        statusMarkdownBlock(formatRuntimeSummary(context))
    ];
    if (options.full) {
        elements.push({ tag: "hr" }, statusMarkdownBlock(formatFullRuntimeDetails(context)), { tag: "hr" }, statusMarkdownBlock(formatFullRecentCommands(context)), { tag: "hr" }, statusMarkdownBlock(formatFullConfigDetails(context)));
    }
    else {
        elements.push({ tag: "hr" }, statusMarkdownBlock("完整信息：发送 `status-full`。"));
    }
    return statusCard(options.full ? "当前工作状态（完整）" : "当前工作状态", statusCardTemplate(context), elements);
}
function formatStatusBindingSummary(context) {
    const binding = context.binding;
    return [
        "**绑定**",
        binding?.projectDisplayLabel ? `project: ${truncateSingleLine(binding.projectDisplayLabel, 80)}` : "project: 未绑定",
        binding?.sessionId
            ? `session: ${truncateSingleLine(binding.sessionTitle || "(untitled)", 80)} (${shortId(binding.sessionId)})`
            : "session: 未绑定",
        binding?.sessionCwd ? `cwd: \`${truncateMiddle(binding.sessionCwd, 96)}\`` : undefined,
        formatGitBranchLine(context.gitStatus)
    ].filter((line) => line !== undefined).join("\n");
}
function formatRunningTaskSummary(context) {
    const command = context.runningCommand;
    if (!command) {
        return [
            "**正在执行**",
            "没有正在执行的任务。"
        ].join("\n");
    }
    const extraCount = context.runningCommands.length - 1;
    const runMs = command.claimedAt ? context.nowMs - Date.parse(command.claimedAt) : undefined;
    const validRunMs = runMs !== undefined && Number.isFinite(runMs) ? Math.max(0, runMs) : undefined;
    return [
        "**正在执行**",
        truncateSingleLine(command.text, 120),
        `id: \`${shortId(command.id)}\`  attempts=${command.attempts}`,
        validRunMs !== undefined ? `已运行: ${formatDuration(validRunMs)}` : undefined,
        command.statusNotifyError
            ? `状态卡: 异常，${truncateSingleLine(command.statusNotifyError, 100)}`
            : command.statusMessageId
                ? "状态卡: 正常"
                : "状态卡: 未创建",
        extraCount > 0 ? `另有 ${extraCount} 条 in_progress，请用 status-full 查看。` : undefined
    ].filter((line) => line !== undefined).join("\n");
}
function formatQueueSummary(context) {
    const sessionStats = context.sessionStats;
    return [
        "**队列**",
        context.binding?.sessionId
            ? `当前 session: pending=${sessionStats?.pending ?? 0} in_progress=${sessionStats?.inProgress ?? 0} done=${sessionStats?.done ?? 0} failed=${sessionStats?.failed ?? 0}`
            : "当前 session: 未绑定",
        `全局积压: pending=${context.queue.pending} in_progress=${context.queue.inProgress}`,
        formatQueueHint({
            hasSession: Boolean(context.binding?.sessionId),
            currentSessionActive: context.currentSessionActive,
            pending: sessionStats?.pending ?? context.commands.filter((item) => item.state === "pending").length,
            inProgress: sessionStats?.inProgress ?? context.runningCommands.length,
            runtimeReady: context.runtime?.ready ?? false,
            runtimeRunning: context.runtime?.running ?? false
        })
    ].join("\n");
}
function formatRuntimeSummary(context) {
    const runtime = context.runtime;
    if (!runtime) {
        return [
            "**Runtime**",
            "未检测到活跃 heartbeat。"
        ].join("\n");
    }
    const scheduler = runtime.scheduler;
    return [
        "**Runtime**",
        `ready=${runtime.ready} running=${runtime.running} managedBy=${runtime.managedBy}`,
        scheduler
            ? `scheduler active=${scheduler.activeSessions.length} current=${context.binding?.sessionId ? yesNo(context.currentSessionActive) : "n/a"}`
            : "scheduler: 未上报",
        scheduler
            ? `recovery=${scheduler.recoveryRunning ? "running" : "idle"} recovered=${scheduler.lastRecoveredCount ?? 0}`
            : undefined,
        runtime.lastError ? `last error: ${truncateSingleLine(runtime.lastError, 100)}` : undefined
    ].filter((line) => line !== undefined).join("\n");
}
function formatFullRuntimeDetails(context) {
    return [
        "**Runtime 详情**",
        ...formatStatusRuntimeLines(context.runtime, {
            currentSessionActive: context.currentSessionActive,
            currentSessionId: context.binding?.sessionId
        }).slice(1)
    ].join("\n");
}
function formatFullRecentCommands(context) {
    return [
        `**最近任务**（最多 ${STATUS_RECENT_COMMAND_LIMIT} 条，最新在前）`,
        ...formatStatusCommandLines(context.recentCommands, context.nowMs, context.config.codex.inProgressTimeoutMs)
    ].join("\n");
}
function formatFullConfigDetails(context) {
    return [
        "**补充信息**",
        `queue: \`${context.queuePath}\``,
        `global: total=${context.queue.total} pending=${context.queue.pending} in_progress=${context.queue.inProgress} done=${context.queue.done} failed=${context.queue.failed}`,
        `codex.enabled=${context.config.codex.enabled}`,
        `codex.timeout=${formatDuration(context.config.codex.timeoutMs)}`,
        `in_progress timeout=${formatDuration(context.config.codex.inProgressTimeoutMs)} recovery=${context.config.codex.inProgressRecovery}`
    ].join("\n");
}
function statusCard(title, template, elements) {
    return {
        schema: "2.0",
        config: {
            update_multi: true,
            wide_screen_mode: true
        },
        header: {
            template,
            title: {
                tag: "plain_text",
                content: title
            }
        },
        body: {
            elements
        }
    };
}
function statusMarkdownBlock(content) {
    return {
        tag: "markdown",
        content
    };
}
function statusCardTemplate(context) {
    if (context.runningCommand)
        return "blue";
    if ((context.sessionStats?.pending ?? 0) > 0)
        return "yellow";
    if (!context.runtime?.running || !context.runtime.ready)
        return "yellow";
    return "green";
}
function formatStatusRuntimeLines(runtime, options) {
    if (!runtime) {
        return [
            "Runtime：",
            "listener/runtime: 未检测到活跃 heartbeat（可能未启动、进程已退出，或心跳超过 30s）。"
        ];
    }
    const scheduler = runtime.scheduler;
    return [
        "Runtime：",
        `listener: running=${runtime.running} ready=${runtime.ready} managedBy=${runtime.managedBy}`,
        `pid=${runtime.pid} processAlive=${runtime.processAlive}`,
        `heartbeat=${formatIsoTime(runtime.updatedAt)}`,
        runtime.startedAt ? `started=${formatIsoTime(runtime.startedAt)}` : undefined,
        runtime.lastEventAt ? `last event=${formatIsoTime(runtime.lastEventAt)}` : undefined,
        runtime.lastCommandAt ? `last command=${formatIsoTime(runtime.lastCommandAt)}` : undefined,
        `received counters: enqueued=${runtime.enqueuedCount} ignored=${runtime.ignoredCount}`,
        runtime.lastError ? `last error=${truncateSingleLine(runtime.lastError, 180)}` : undefined,
        scheduler
            ? `scheduler active sessions=${scheduler.activeSessions.length} current=${options.currentSessionId ? yesNo(options.currentSessionActive) : "n/a"}`
            : "scheduler: 未上报",
        scheduler
            ? `scheduler recovery: running=${scheduler.recoveryRunning} last=${formatOptionalIsoTime(scheduler.lastRecoveryAt)} recovered=${scheduler.lastRecoveredCount ?? 0}`
            : undefined,
        scheduler?.lastRecoveryError
            ? `scheduler recovery error=${truncateSingleLine(scheduler.lastRecoveryError, 180)}`
            : undefined
    ].filter((line) => line !== undefined);
}
function formatStatusCommandLines(commands, nowMs, timeoutMs) {
    if (commands.length === 0)
        return ["- 无任务记录。"];
    return commands.flatMap((command) => {
        const runMs = command.claimedAt ? nowMs - Date.parse(command.claimedAt) : undefined;
        const validRunMs = runMs !== undefined && Number.isFinite(runMs) ? Math.max(0, runMs) : undefined;
        const stale = command.state === "in_progress" &&
            validRunMs !== undefined &&
            validRunMs > timeoutMs;
        const lines = [
            [
                `- [${command.state}] ${shortId(command.id)}`,
                `attempts=${command.attempts}`,
                command.receivedAt ? `received=${formatIsoTime(command.receivedAt)}` : undefined,
                command.claimedAt ? `claimed=${formatIsoTime(command.claimedAt)}` : undefined,
                command.completedAt ? `completed=${formatIsoTime(command.completedAt)}` : undefined,
                validRunMs !== undefined ? `run=${formatDuration(validRunMs)}` : undefined,
                command.statusMessageId ? `card=${shortId(command.statusMessageId)}` : "card=none",
                stale ? "stale=yes" : undefined,
                command.attachments?.length ? `attachments=${command.attachments.length}` : undefined
            ].filter((item) => item !== undefined).join(" "),
            `  text: ${truncateSingleLine(command.text, 180)}`,
            command.statusSummary ? `  card summary: ${truncateSingleLine(command.statusSummary, 180)}` : undefined,
            command.statusUpdatedAt ? `  card updated: ${formatIsoTime(command.statusUpdatedAt)}` : undefined,
            command.statusNotifyError ? `  card error: ${truncateSingleLine(command.statusNotifyError, 180)}` : undefined,
            command.resultSummary ? `  result: ${truncateSingleLine(command.resultSummary, 180)}` : undefined
        ].filter((line) => line !== undefined);
        return lines;
    });
}
function formatQueueHint(options) {
    if (!options.hasSession) {
        return "判断：当前群未绑定 active session，普通任务不会入队；先 list-session 或 new-session。";
    }
    if (options.runtimeRunning && !options.runtimeReady) {
        return "判断：runtime 已启动但暂未 ready，可能正在重启或重连；pending 会等 ready 后处理。";
    }
    if (!options.runtimeRunning) {
        return "判断：runtime/listener 当前未运行或心跳过期，pending 任务不会自动推进。";
    }
    if (options.inProgress > 0) {
        return options.currentSessionActive
            ? "判断：当前 session 正在执行任务；同 session pending 会串行等待。"
            : "判断：队列里有 in_progress 任务，但 scheduler 未上报当前 session active；需要关注是否已卡住。";
    }
    if (options.pending > 0) {
        return "判断：当前 session 有 pending 任务，runtime 可用时会按收到时间串行处理。";
    }
    return "判断：当前 session 没有 pending / in_progress 任务。";
}
function formatIsoTime(value) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp))
        return value;
    return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}
function formatOptionalIsoTime(value) {
    return value ? formatIsoTime(value) : "never";
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
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength)
        return normalized;
    return `${normalized.slice(0, maxLength - 1)}…`;
}
function truncateMiddle(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    const keep = Math.max(4, Math.floor((maxLength - 1) / 2));
    return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}
function yesNo(value) {
    return value ? "yes" : "no";
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
