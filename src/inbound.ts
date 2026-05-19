import * as lark from "@larksuiteoapi/node-sdk";
import type { EventHandles } from "@larksuiteoapi/node-sdk";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  clearChatActiveSession,
  deleteChatSessionBinding,
  type ChatSessionBinding,
  bindingToCommandSession,
  formatCurrentChatProject,
  formatCurrentChatSession,
  getChatSessionBinding,
  listChatSessionBindingsBySession,
  updateChatSessionBindingChatName,
  updateChatSessionBindingModel,
  upsertChatSessionBinding
} from "./chatBindings.js";
import { assertAppCredentialsReady, ConfigError, CONFIG_DIR, CONFIG_PATH, loadConfig } from "./config.js";
import {
  enqueueCommand,
  getCommandQueueStats,
  listCommands,
  resolveCommandQueuePath,
  updateCommandStatusMetadata,
  type CommandQueueStats,
  type SessionCommandStats
} from "./commandQueue.js";
import { buildNotificationCard } from "./card.js";
import {
  findCodexSession,
  findCodexProject,
  formatSelectedSessionWithSummary,
  listCodexProjects,
  listCodexSessions,
  parseCodexSessionControlCommand,
  type CodexProject,
  type CodexSessionListMode
} from "./codexSessions.js";
import { readCodexMcpList } from "./codexMcp.js";
import { resolveCodexModelStatus } from "./codexModels.js";
import { runCodexNewSession } from "./codexCli.js";
import type { CodexProgressEvent, CodexResumeResult } from "./codexCli.js";
import {
  commandStatusSnapshotPatch,
  resolveCommandStatusSnapshot
} from "./commandStatusSnapshot.js";
import { FeishuClient } from "./feishuClient.js";
import {
  formatGitBranchLine,
  formatGitBranchValueForCwd,
  readGitWorkingTreeStatus,
  type GitWorkingTreeStatus
} from "./gitStatus.js";
import {
  buildCodexFeatureDetailCard,
  buildCodexFeatureCard,
  buildCodexModelCard,
  buildCodexMcpListCard,
  buildCodexHelpCard,
  buildCodexProjectListCard,
  buildCodexSessionListCard,
  parseCodexCardActionValue
} from "./sessionCard.js";
import { buildCommandStatusCard } from "./statusCard.js";
import { readStandaloneListenerRuntimeStatus } from "./listenerRuntime.js";
import type { CodexSession } from "./codexSessions.js";
import type { AgentCommand, AgentCommandAttachment, BridgeConfig, NewAgentCommand, NotifyStatus } from "./types.js";

const IMAGE_CANDIDATE_TTL_MS = 5 * 60 * 1000;
const IMAGE_CANDIDATE_MAX_PER_SENDER = 5;
const DEFAULT_IMAGE_TASK_TEXT = "请识别并分析这张图片。";
const SESSION_PAGE_SIZE = 10;
const NEW_SESSION_DISCOVERY_RETRIES = 12;
const NEW_SESSION_DISCOVERY_INTERVAL_MS = 250;
const NEW_SESSION_PROGRESS_UPDATE_INTERVAL_MS = 10_000;
const DEFAULT_NEW_SESSION_PROMPT = "新会话初始化";
const STATUS_RECENT_COMMAND_LIMIT = 10;
const INITIAL_NEW_SESSION_CLI_HANDOFF_PROGRESS_SUMMARY = "已交接给 Codex CLI 处理，正在创建新的 Codex session。";

export type MessageReceiveEvent = Parameters<
  NonNullable<EventHandles["im.message.receive_v1"]>
>[0];
export type NormalizedCardActionEvent = NonNullable<
  ReturnType<typeof lark.normalizeCardAction>
>;

type ExtractedAgentCommand = Omit<
  NewAgentCommand,
  "sessionId" | "sessionTitle" | "sessionCwd" | "sessionSource" | "sessionGitBranch" | "sessionUpdatedAt" |
  "projectId" | "projectKind" | "projectRootPath" | "projectDisplayName" | "projectSecondaryName" |
  "projectDisplayLabel" | "projectLabelSource"
>;

export interface CommandExtractionResult {
  command?: ExtractedAgentCommand;
  ignoredReason?: string;
}

export interface CommandListenerStatus {
  running: boolean;
  ready: boolean;
  configPath: string;
  queuePath?: string;
  startedAt?: string;
  lastEventAt?: string;
  lastCommandAt?: string;
  enqueuedCount: number;
  ignoredCount: number;
  lastError?: string;
  reconnectInfo?: {
    lastConnectTime: number;
    nextConnectTime: number;
  };
}

interface ImageResourceCandidate {
  chatId: string;
  chatType?: string;
  senderKey: string;
  messageId: string;
  resourceKey: string;
  createdAtMs: number;
}

type RuntimeStatusSnapshot = Awaited<ReturnType<typeof readStandaloneListenerRuntimeStatus>>;

interface WorkStatusContext {
  config: BridgeConfig;
  queuePath: string;
  chatId: string;
  binding?: ChatSessionBinding;
  gitStatus: GitWorkingTreeStatus;
  queue: CommandQueueStats;
  runtime?: RuntimeStatusSnapshot;
  sessionStats?: SessionCommandStats;
  commands: AgentCommand[];
  recentCommands: AgentCommand[];
  runningCommands: AgentCommand[];
  runningCommand?: AgentCommand;
  nowMs: number;
  currentSessionActive: boolean;
}

type NewSessionStatusPhase = "creating" | "bound" | "done" | "failed";

interface NewSessionStatusDetails {
  phase: NewSessionStatusPhase;
  projectRootPath: string;
  startedAtMs: number;
  nowMs?: number;
  projectLabel?: string;
  prompt?: string;
  session?: CodexSession;
  bindingSummary?: string;
  result?: CodexResumeResult;
  error?: unknown;
  progressSummary?: string;
  nextSteps?: string[];
}

export class FeishuCommandListener {
  private wsClient?: lark.WSClient;
  private readonly handledMessageIds = new Set<string>();
  private readonly recentImageCandidates = new Map<string, ImageResourceCandidate[]>();
  private queuePath?: string;
  private startedAt?: string;
  private lastEventAt?: string;
  private lastCommandAt?: string;
  private lastError?: string;
  private ready = false;
  private enqueuedCount = 0;
  private ignoredCount = 0;

  constructor(
    private readonly options: {
      configPath?: string;
      feishuClient?: FeishuClient;
      onCommandEnqueued?: (command: AgentCommand) => void | Promise<void>;
    } = {}
  ) {}

  async start(): Promise<CommandListenerStatus> {
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
      "card.action.trigger": async (data: unknown) => {
        return await this.handleCardAction(data, feishuClient);
      }
    } as EventHandles & Record<string, (data: unknown) => Promise<unknown>>);

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

  stop(force = false): void {
    if (!this.wsClient) return;
    this.wsClient.close({ force });
    this.wsClient = undefined;
    this.ready = false;
  }

  getStatus(): CommandListenerStatus {
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

  private async handleMessageReceive(
    data: MessageReceiveEvent,
    baseConfig: BridgeConfig,
    feishuClient: FeishuClient
  ): Promise<void> {
    this.lastEventAt = new Date().toISOString();
    const messageId = data.message.message_id;
    if (this.handledMessageIds.has(messageId)) {
      this.ignoredCount += 1;
      stderrLogger.info(
        "[inbound]",
        "ignored duplicate message",
        JSON.stringify({
          eventId: data.event_id,
          messageId,
          chatId: data.message.chat_id
        })
      );
      return;
    }
    this.handledMessageIds.add(messageId);

    stderrLogger.info(
      "[inbound]",
      "received message",
      JSON.stringify({
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
      })
    );
    try {
      const config = await this.loadRuntimeConfig(baseConfig);
      const queuePath = resolveCommandQueuePath(config);
      const imageCandidates = extractImageCandidates(data);
      if (imageCandidates.length > 0 && shouldCacheImageOnly(data, config)) {
        this.cacheImageCandidates(imageCandidates);
        stderrLogger.info(
          "[inbound]",
          "cached image candidate",
          JSON.stringify({
            messageId: data.message.message_id,
            chatId: data.message.chat_id,
            senderKey: imageCandidates[0]?.senderKey,
            imageCount: imageCandidates.length
          })
        );
        return;
      }

      const extracted = extractCommandFromMessage(data, config);
      if (!extracted.command) {
        this.ignoredCount += 1;
        stderrLogger.info(
          "[inbound]",
          "ignored message",
          JSON.stringify({
            messageId: data.message.message_id,
            reason: extracted.ignoredReason
          })
        );
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
      if (
        imageCandidates.length === 0 &&
        resourceCandidates.length === 0 &&
        shouldAttachRecentImage(extracted.command.text)
      ) {
        this.ignoredCount += 1;
        await feishuClient.sendTextMessage(
          config,
          {
            receiveIdType: "chat_id",
            receiveId: extracted.command.chatId
          },
          "没找到最近图片，请重新发送图片或把图片和 @ 指令放在一起。"
        );
        stderrLogger.info(
          "[inbound]",
          "ignored image task without recent candidate",
          JSON.stringify({
            messageId: extracted.command.messageId,
            chatId: extracted.command.chatId
          })
        );
        return;
      }

      let attachments: AgentCommandAttachment[] | undefined;
      if (resourceCandidates.length > 0) {
        try {
          attachments = await this.downloadImageAttachments(config, resourceCandidates, feishuClient);
        } catch (error) {
          this.ignoredCount += 1;
          await feishuClient.sendTextMessage(
            config,
            {
              receiveIdType: "chat_id",
              receiveId: extracted.command.chatId
            },
            `图片下载失败：${formatError(error)}`
          );
          stderrLogger.info(
            "[inbound]",
            "ignored image task after download failure",
            JSON.stringify({
              messageId: extracted.command.messageId,
              chatId: extracted.command.chatId,
              error: formatError(error)
            })
          );
          return;
        }
      }

      const commandText = extracted.command.text || (attachments?.length ? DEFAULT_IMAGE_TASK_TEXT : "");
      if (!commandText) {
        this.ignoredCount += 1;
        await feishuClient.sendTextMessage(
          config,
          {
            receiveIdType: "chat_id",
            receiveId: extracted.command.chatId
          },
          "请补充要执行的指令，或发送图片后 @机器人 说明要识别的内容。"
        );
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
        stderrLogger.info(
          "[inbound]",
          "ignored command without chat project binding",
          JSON.stringify({
            messageId: extracted.command.messageId,
            chatId: extracted.command.chatId
          })
        );
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
        stderrLogger.info(
          "[inbound]",
          "ignored command without chat active session",
          JSON.stringify({
            messageId: extracted.command.messageId,
            chatId: extracted.command.chatId,
            projectId: binding.projectId
          })
        );
        return;
      }

      let { command, inserted } = await enqueueCommand(
        {
          ...extracted.command,
          text: commandText,
          attachments,
          ...session
        },
        queuePath
      );
      stderrLogger.info(
        "[inbound]",
        inserted ? "enqueued command" : "duplicate command",
        JSON.stringify({
          commandId: command.id,
          messageId: command.messageId,
          chatId: command.chatId,
          text: command.text
        })
      );
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
    } catch (error) {
      this.lastError = formatError(error);
      stderrLogger.error("[inbound]", "failed to handle message", this.lastError);
    }
  }

  private async sendQueuedStatusCard(
    config: BridgeConfig,
    command: AgentCommand,
    queuePath: string,
    feishuClient: FeishuClient
  ): Promise<AgentCommand> {
    const statusSummary = "任务已收到，正在等待 runtime 调度。";
    const statusUpdatedAt = new Date().toISOString();
    try {
      const statusSnapshot = await resolveCommandStatusSnapshot(config, command);
      const result = await feishuClient.sendInteractiveMessageToReceiver(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: command.chatId
        },
        buildCommandStatusCard(command, config, {
          phase: "queued",
          progressSummary: statusSummary,
          nowMs: Date.parse(statusUpdatedAt),
          gitBranch: statusSnapshot.gitBranch,
          model: statusSnapshot.model,
          reasoningEffort: statusSnapshot.reasoningEffort,
          fastModeEnabled: statusSnapshot.fastModeEnabled
        })
      );
      const updated = await updateCommandStatusMetadata(command.id, queuePath, {
        statusMessageId: result.messageId,
        statusUpdatedAt,
        statusNotifyError: result.messageId ? null : "Feishu status card did not return message_id",
        statusSummary,
        ...commandStatusSnapshotPatch(statusSnapshot)
      });
      stderrLogger.info(
        "[inbound]",
        "sent queued status card",
        JSON.stringify({
          commandId: command.id,
          chatId: command.chatId,
          statusMessageId: result.messageId
        })
      );
      return updated ?? command;
    } catch (error) {
      const statusNotifyError = formatError(error);
      await updateCommandStatusMetadata(command.id, queuePath, {
        statusUpdatedAt,
        statusNotifyError,
        statusSummary
      });
      await feishuClient.sendTextMessage(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: command.chatId
        },
        config.inbound.acknowledgementText
      );
      stderrLogger.info(
        "[inbound]",
        "sent fallback acknowledgement",
        JSON.stringify({
          commandId: command.id,
          chatId: command.chatId,
          statusNotifyError
        })
      );
      return command;
    }
  }

  private async handleSessionControlCommand(
    control: NonNullable<ReturnType<typeof parseCodexSessionControlCommand>>,
    command: ExtractedAgentCommand,
    config: BridgeConfig,
    queuePath: string,
    feishuClient: FeishuClient
  ): Promise<void> {
    if (control.type === "help") {
      const binding = await getChatSessionBinding(queuePath, command.chatId);
      await feishuClient.sendInteractiveMessageToReceiver(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: command.chatId
        },
        buildCodexHelpCard({
          projectLabel: binding?.projectDisplayLabel,
          sessionTitle: binding?.sessionTitle,
          sessionId: binding?.sessionId,
          isTemporary: binding?.projectKind === "temporary"
        })
      );
      this.logHandledControl("help", command);
      return;
    }

    if (control.type === "features") {
      const binding = await getChatSessionBinding(queuePath, command.chatId);
      await feishuClient.sendInteractiveMessageToReceiver(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: command.chatId
        },
        buildCodexFeatureCard({
          projectLabel: binding?.projectDisplayLabel,
          sessionTitle: binding?.sessionTitle,
          sessionId: binding?.sessionId,
          isTemporary: binding?.projectKind === "temporary",
          model: binding?.sessionModel ?? config.codex.model,
          profile: config.codex.profile,
          sandbox: config.codex.sandbox
        })
      );
      this.logHandledControl("features", command);
      return;
    }

    if (control.type === "feature-detail") {
      const binding = await getChatSessionBinding(queuePath, command.chatId);
      const card = control.feature === "mcp"
        ? buildCodexMcpListCard({
          projectLabel: binding?.projectDisplayLabel,
          sessionTitle: binding?.sessionTitle,
          sessionId: binding?.sessionId,
          isTemporary: binding?.projectKind === "temporary",
          ...(await readCodexMcpList(config.codex))
        })
        : control.feature === "model"
          ? buildCodexModelCard({
            projectLabel: binding?.projectDisplayLabel,
            sessionTitle: binding?.sessionTitle,
            sessionId: binding?.sessionId,
            isTemporary: binding?.projectKind === "temporary",
            modelStatus: await resolveCodexModelStatus({
              sessionModel: binding?.sessionModel,
              bridgeModel: config.codex.model,
              codexCommand: config.codex.command
            })
          })
        : buildCodexFeatureDetailCard(control.feature, {
          projectLabel: binding?.projectDisplayLabel,
          sessionTitle: binding?.sessionTitle,
          sessionId: binding?.sessionId,
          isTemporary: binding?.projectKind === "temporary"
        });
      await feishuClient.sendInteractiveMessageToReceiver(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: command.chatId
        },
        card
      );
      this.logHandledControl("feature-detail", command);
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
      await feishuClient.sendInteractiveMessageToReceiver(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: command.chatId
        },
        card
      );
      this.logHandledControl("status", command);
      return;
    }

    if (control.type === "select-project") {
      const summary = await this.selectProjectForChat(
        config,
        queuePath,
        {
          chatId: command.chatId,
          chatType: command.chatType
        },
        control.selector,
        feishuClient
      );
      await feishuClient.sendTextMessage(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: command.chatId
        },
        summary
      );
      this.logHandledControl("select-project", command);
      return;
    }

    if (control.type === "new-session") {
      await this.createNewSessionForChat(
        config,
        queuePath,
        {
          chatId: command.chatId,
          chatType: command.chatType,
          messageId: command.messageId
        },
        control.prompt,
        feishuClient
      );
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
      await feishuClient.sendTextMessage(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: command.chatId
        },
        formatCurrentChatSession(binding)
      );
      stderrLogger.info(
        "[inbound]",
        "handled control command",
        JSON.stringify({
          control: "current-session",
          status: "done",
          title: "Current chat Codex session",
          messageId: command.messageId,
          chatId: command.chatId
        })
      );
      return;
    }

    if (control.type === "current-project") {
      const binding = await getChatSessionBinding(queuePath, command.chatId);
      await feishuClient.sendTextMessage(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: command.chatId
        },
        formatCurrentChatProject(binding)
      );
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

    const summary = await this.selectSessionForChat(
      config,
      queuePath,
      {
        chatId: command.chatId,
        chatType: command.chatType
      },
      control.selector,
      feishuClient
    );
    await feishuClient.sendTextMessage(
      config,
      {
        receiveIdType: "chat_id",
        receiveId: command.chatId
      },
      summary
    );
    stderrLogger.info(
      "[inbound]",
      "handled control command",
      JSON.stringify({
        control: "select-session",
        status: "done",
        title: "Chat Codex session selected",
        messageId: command.messageId,
        chatId: command.chatId,
        selector: control.selector
      })
    );
  }

  private async sendProjectSelectionCard(
    config: BridgeConfig,
    command: Pick<ExtractedAgentCommand, "messageId" | "chatId">,
    feishuClient: FeishuClient,
    options: {
      title?: string;
      notice?: string;
      page?: number;
    } = {}
  ): Promise<void> {
    const projects = await listCodexProjects(config.codex);
    const page = paginate(projects, options.page ?? 1, SESSION_PAGE_SIZE);
    await feishuClient.sendInteractiveMessageToReceiver(
      config,
      {
        receiveIdType: "chat_id",
        receiveId: command.chatId
      },
      buildCodexProjectListCard(page.items, SESSION_PAGE_SIZE, {
        ...options,
        pageInfo: page.info
      })
    );
    stderrLogger.info(
      "[inbound]",
      "sent project selection card",
      JSON.stringify({
        messageId: command.messageId,
        chatId: command.chatId,
        page: page.info.page,
        total: page.info.total,
        projects: projects.length
      })
    );
  }

  private async sendSessionPage(
    config: BridgeConfig,
    command: Pick<ExtractedAgentCommand, "messageId" | "chatId">,
    feishuClient: FeishuClient,
    options: {
      mode: CodexSessionListMode;
      page: number;
      projectId?: string;
      projectLabel?: string;
      notice?: string;
    }
  ): Promise<void> {
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
    await feishuClient.sendInteractiveMessageToReceiver(
      config,
      {
        receiveIdType: "chat_id",
        receiveId: command.chatId
      },
      buildCodexSessionListCard(page.items, SESSION_PAGE_SIZE, {
        title,
        notice: options.notice,
        mode: options.mode,
        projectId: options.projectId,
        projectLabel: options.projectLabel,
        pageInfo: page.info
      })
    );
    stderrLogger.info(
      "[inbound]",
      "sent session page card",
      JSON.stringify({
        messageId: command.messageId,
        chatId: command.chatId,
        mode: options.mode,
        page: page.info.page,
        total: page.info.total
      })
    );
  }

  private async handleCardAction(data: unknown, feishuClient: FeishuClient): Promise<Record<string, unknown> | undefined> {
    this.lastEventAt = new Date().toISOString();
    const event = lark.normalizeCardAction(data as Parameters<typeof lark.normalizeCardAction>[0], {
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
      stderrLogger.info(
        "[card]",
        "ignored unrelated card action",
        JSON.stringify({
          messageId: event.messageId,
          chatId: event.chatId,
          actionTag: event.action.tag
        })
      );
      return;
    }

    return await this.completeCardAction(event, action, feishuClient);
  }

  private async completeCardAction(
    event: NormalizedCardActionEvent,
    action: NonNullable<ReturnType<typeof parseCodexCardActionValue>>,
    feishuClient: FeishuClient
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const configPath = this.options.configPath ?? CONFIG_PATH;
      const config = await loadConfig(configPath);
      const queuePath = resolveCommandQueuePath(config);

      if (action.type === "list-session-page") {
        const binding = action.mode === "project"
          ? await getChatSessionBinding(queuePath, event.chatId)
          : undefined;
        await this.sendSessionPage(
          config,
          {
            messageId: event.messageId,
            chatId: event.chatId
          },
          feishuClient,
          {
            mode: action.mode,
            page: action.page,
            projectId: action.projectId ?? binding?.projectId,
            projectLabel: binding?.projectDisplayLabel
          }
        );
        return;
      }

      if (action.type === "list-project-page") {
        await this.sendProjectSelectionCard(
          config,
          {
            messageId: event.messageId,
            chatId: event.chatId
          },
          feishuClient,
          {
            page: action.page
          }
        );
        return;
      }

      if (action.type === "enqueue-command") {
        await this.enqueueCardCommand(
          config,
          queuePath,
          event,
          action.command,
          feishuClient
        );
        return;
      }

      if (action.type === "set-model" || action.type === "clear-model") {
        const requestedSessionModel = action.type === "set-model" ? action.model : undefined;
        const binding = await updateChatSessionBindingModel(
          queuePath,
          event.chatId,
          requestedSessionModel
        );
        const renderedSessionModel = binding ? requestedSessionModel : undefined;
        const modelStatus = await resolveCodexModelStatus({
          sessionModel: renderedSessionModel,
          bridgeModel: config.codex.model,
          codexCommand: config.codex.command
        });
        const card = buildCodexModelCard({
          projectLabel: binding?.projectDisplayLabel,
          sessionTitle: binding?.sessionTitle,
          sessionId: binding?.sessionId,
          isTemporary: binding?.projectKind === "temporary",
          modelStatus,
          updatedModel: binding ? renderedSessionModel || "" : undefined
        });
        stderrLogger.info(
          "[card]",
          "responded codex model card",
          JSON.stringify({
            action: action.type,
            storedModel: binding?.sessionModel,
            renderedSessionModel,
            renderedModel: modelStatus.effectiveModel,
            messageId: event.messageId,
            chatId: event.chatId,
            operatorOpenId: event.operator.openId
          })
        );
        return buildCardActionUpdateResponse(card);
      }

      if (action.type === "run-command") {
        const control = parseCodexSessionControlCommand(action.command);
        if (!control) {
          this.ignoredCount += 1;
          return;
        }
        await this.handleSessionControlCommand(
          control,
          {
            text: action.command,
            rawText: action.command,
            messageId: event.messageId,
            chatId: event.chatId,
            sender: {
              openId: event.operator.openId
            }
          },
          config,
          queuePath,
          feishuClient
        );
        return;
      }

      const summary = action.type === "bind-project"
        ? await this.selectProjectForChat(
          config,
          queuePath,
          {
            chatId: event.chatId
          },
          action.projectId,
          feishuClient
        )
        : await this.selectSessionForChat(
          config,
          queuePath,
          {
            chatId: event.chatId
          },
          action.sessionId,
          feishuClient
        );
      await feishuClient.sendTextMessage(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: event.chatId
        },
        summary
      );
      stderrLogger.info(
        "[card]",
        "handled codex card action",
        JSON.stringify({
          status: "done",
          action: action.type,
          messageId: event.messageId,
          chatId: event.chatId,
          operatorOpenId: event.operator.openId
        })
      );
    } catch (error) {
      this.lastError = formatError(error);
      stderrLogger.error("[card]", "failed to handle card action", this.lastError);
    }
  }

  private async enqueueCardCommand(
    config: BridgeConfig,
    queuePath: string,
    event: NormalizedCardActionEvent,
    commandText: string,
    feishuClient: FeishuClient
  ): Promise<void> {
    const cardCommand: ExtractedAgentCommand = {
      text: commandText,
      rawText: commandText,
      messageId: `${event.messageId}:action:${randomUUID()}`,
      chatId: event.chatId,
      sender: {
        openId: event.operator.openId
      },
      eventId: `card:${event.messageId}`
    };

    const binding = await getChatSessionBinding(queuePath, event.chatId);
    if (!binding?.projectId) {
      this.ignoredCount += 1;
      await this.sendProjectSelectionCard(config, cardCommand, feishuClient, {
        title: "当前群尚未绑定 Codex project",
        notice: [
          "**按钮任务暂未入队：当前群尚未绑定 Codex project。**",
          "",
          "请先选择一个 project，绑定后再点击功能按钮。"
        ].join("\n")
      });
      return;
    }

    const session = bindingToCommandSession(binding);
    if (!session) {
      this.ignoredCount += 1;
      await this.sendSessionPage(config, cardCommand, feishuClient, {
        mode: "project",
        page: 1,
        projectId: binding.projectId,
        projectLabel: binding.projectDisplayLabel,
        notice: [
          "**按钮任务暂未入队：当前 project 还没有 active session。**",
          "",
          "请先选择一个 session，或发送 `new-session` 在当前 project 下开启新会话。"
        ].join("\n")
      });
      return;
    }

    let { command, inserted } = await enqueueCommand(
      {
        ...cardCommand,
        ...session
      },
      queuePath
    );
    stderrLogger.info(
      "[card]",
      inserted ? "enqueued feature command" : "duplicate feature command",
      JSON.stringify({
        commandId: command.id,
        messageId: command.messageId,
        chatId: command.chatId,
        text: command.text
      })
    );

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

  private async createNewSessionForChat(
    config: BridgeConfig,
    queuePath: string,
    chat: { chatId: string; chatType?: string; messageId: string },
    prompt: string | undefined,
    feishuClient: FeishuClient
  ): Promise<void> {
    const binding = await getChatSessionBinding(queuePath, chat.chatId);
    if (!binding?.projectId) {
      await this.sendProjectSelectionCard(config, chat, feishuClient, {
        title: "当前群尚未绑定 Codex project",
        notice: "请先绑定 project；绑定后可发送 `new-session` 在当前 project 下开启新会话。"
      });
      return;
    }

    if (binding.projectKind === "temporary") {
      await feishuClient.sendTextMessage(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: chat.chatId
        },
        [
          "当前群绑定的是临时对话，不能在 temporary 下创建新的 project 会话。",
          "请先发送 list-project 绑定一个 Codex project。"
        ].join("\n")
      );
      return;
    }

    const projectRootPath = binding.projectRootPath ?? binding.sessionCwd;
    if (!projectRootPath) {
      await feishuClient.sendTextMessage(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: chat.chatId
        },
        "当前群绑定缺少 project root，无法创建新 Codex 会话。请重新发送 list-project 绑定 project。"
      );
      return;
    }

    if (!config.codex.enabled) {
      await feishuClient.sendTextMessage(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: chat.chatId
        },
        "Codex CLI 未启用，无法创建新会话。请先在配置中设置 codex.enabled=true。"
      );
      return;
    }

    const beforeSessions = await listCodexSessions(config.codex, {
      all: true,
      includeTemporary: true,
      projectId: binding.projectId
    });
    const beforeIds = new Set(beforeSessions.map((session) => session.id));
    const startedAtSeconds = Math.floor(Date.now() / 1000) - 2;
    const newSessionStartedAtMs = Date.now();
    const promptText = prompt?.trim() || DEFAULT_NEW_SESSION_PROMPT;
    const progressSummaries: string[] = [INITIAL_NEW_SESSION_CLI_HANDOFF_PROGRESS_SUMMARY];
    let activeProgressSummary = formatNewSessionProgressSummary(progressSummaries);
    let progressSession: CodexSession | undefined;
    let progressBindingSummary: string | undefined;
    let progressPhase: NewSessionStatusPhase = "creating";
    let statusCardMessageId = await this.publishNewSessionStatusCard(
      config,
      feishuClient,
      {
        chatId: chat.chatId,
        messageId: undefined,
        fallbackTextOnError: true
      },
      {
        phase: "creating",
        projectRootPath,
        startedAtMs: newSessionStartedAtMs,
        nowMs: newSessionStartedAtMs,
        projectLabel: binding.projectDisplayLabel,
        prompt: promptText,
        progressSummary: activeProgressSummary
      }
    );
    let lastProgressUpdatedAt = newSessionStartedAtMs;
    let progressUpdateChain: Promise<void> = Promise.resolve();
    let progressHeartbeat: NodeJS.Timeout | undefined;
    const enqueueStatusCardRefresh = (
      nowMs: number,
      options: { allowSameSummary?: boolean } = {}
    ): void => {
      const nextSummary = formatNewSessionProgressSummary(progressSummaries);
      if (!options.allowSameSummary && nextSummary === activeProgressSummary) {
        return;
      }
      if (nowMs - lastProgressUpdatedAt < NEW_SESSION_PROGRESS_UPDATE_INTERVAL_MS) {
        return;
      }

      activeProgressSummary = nextSummary;
      lastProgressUpdatedAt = nowMs;
      progressUpdateChain = progressUpdateChain
        .catch(() => undefined)
        .then(async () => {
          statusCardMessageId = await this.publishNewSessionStatusCard(
            config,
            feishuClient,
            {
              chatId: chat.chatId,
              messageId: statusCardMessageId,
              fallbackTextOnError: false
            },
            {
              phase: progressPhase,
              projectRootPath,
              startedAtMs: newSessionStartedAtMs,
              nowMs,
              projectLabel: binding.projectDisplayLabel,
              prompt: promptText,
              session: progressSession,
              bindingSummary: progressBindingSummary,
              progressSummary: activeProgressSummary
            }
          );
        })
        .catch(() => {
          // Progress updates must never interrupt new-session creation.
        });
    };
    const enqueueProgressUpdate = (event: CodexProgressEvent): void => {
      const progressSummary = event.summary.replace(/\s+/g, " ").trim();
      if (!progressSummary) return;
      if (progressSummaries[progressSummaries.length - 1] !== progressSummary) {
        progressSummaries.push(progressSummary);
        if (progressSummaries.length > 4) {
          progressSummaries.splice(0, progressSummaries.length - 4);
        }
      }
      enqueueStatusCardRefresh(event.receivedAtMs);
    };
    const stopProgressUpdates = async (): Promise<void> => {
      if (progressHeartbeat) {
        clearInterval(progressHeartbeat);
        progressHeartbeat = undefined;
      }
      await progressUpdateChain.catch(() => undefined);
    };
    progressHeartbeat = setInterval(() => {
      enqueueStatusCardRefresh(Date.now(), { allowSameSummary: true });
    }, NEW_SESSION_PROGRESS_UPDATE_INTERVAL_MS);
    progressHeartbeat.unref?.();

    const outputPath = join(
      config.codex.outputDir ?? join(CONFIG_DIR, "codex-output"),
      `new-session-${safePathSegment(chat.chatId)}-${Date.now()}.txt`
    );
    const runState: {
      done: boolean;
      result?: CodexResumeResult;
      error?: unknown;
    } = { done: false };
    const runResultPromise = runCodexNewSession(promptText, config.codex, {
      cwd: projectRootPath,
      outputPath,
      onProgress: enqueueProgressUpdate
    }).then((result) => {
      runState.done = true;
      runState.result = result;
      return result;
    }, (error: unknown) => {
      runState.done = true;
      runState.error = error;
      return undefined;
    });
    let session = await this.findCreatedProjectSession(
      config,
      binding.projectId,
      beforeIds,
      startedAtSeconds
    );
    if (!session) {
      const result = await runResultPromise;
      activeProgressSummary = formatNewSessionProgressSummary(progressSummaries);
      await stopProgressUpdates();
      session = await this.findCreatedProjectSession(
        config,
        binding.projectId,
        beforeIds,
        startedAtSeconds
      );
      if (session) {
        await progressUpdateChain.catch(() => undefined);
        const created = await this.sendNewSessionCreatedMessage(
          config,
          queuePath,
          chat,
          session,
          feishuClient,
          runState,
          {
            messageId: statusCardMessageId,
            projectRootPath,
            startedAtMs: newSessionStartedAtMs,
            projectLabel: binding.projectDisplayLabel,
            prompt: promptText,
            progressSummary: activeProgressSummary
          }
        );
        statusCardMessageId = created.messageId;
        return;
      }
      await progressUpdateChain.catch(() => undefined);
      statusCardMessageId = await this.publishNewSessionStatusCard(
        config,
        feishuClient,
        {
          chatId: chat.chatId,
          messageId: statusCardMessageId,
          fallbackTextOnError: true
        },
        {
          phase: "failed",
          projectRootPath,
          startedAtMs: newSessionStartedAtMs,
          projectLabel: binding.projectDisplayLabel,
          prompt: promptText,
          result,
          error: runState.error,
          progressSummary: activeProgressSummary,
          nextSteps: ["请稍后发送 list-session 查看是否已落盘，或重试 new-session。"]
        }
      );
      return;
    }

    activeProgressSummary = formatNewSessionProgressSummary(progressSummaries);
    progressSession = session;
    progressPhase = runState.done ? "done" : "bound";
    if (runState.done) {
      await stopProgressUpdates();
    } else {
      await progressUpdateChain.catch(() => undefined);
    }
    const created = await this.sendNewSessionCreatedMessage(
      config,
      queuePath,
      chat,
      session,
      feishuClient,
      runState,
      {
        messageId: statusCardMessageId,
        projectRootPath,
        startedAtMs: newSessionStartedAtMs,
        projectLabel: binding.projectDisplayLabel,
        prompt: promptText,
        progressSummary: activeProgressSummary
      }
    );
    statusCardMessageId = created.messageId;
    progressBindingSummary = created.bindingSummary;
    progressPhase = created.includesRunResult ? "done" : "bound";
    if (!created.includesRunResult) {
      const result = await runResultPromise;
      activeProgressSummary = formatNewSessionProgressSummary(progressSummaries);
      await stopProgressUpdates();
      await this.publishNewSessionStatusCard(
        config,
        feishuClient,
        {
          chatId: chat.chatId,
          messageId: statusCardMessageId,
          fallbackTextOnError: true
        },
        {
          phase: result?.ok ? "done" : "failed",
          projectRootPath,
          startedAtMs: newSessionStartedAtMs,
          projectLabel: binding.projectDisplayLabel,
          prompt: promptText,
          session,
          bindingSummary: progressBindingSummary,
          result,
          error: runState.error,
          progressSummary: activeProgressSummary
        }
      );
    }
  }

  private async sendNewSessionCreatedMessage(
    config: BridgeConfig,
    queuePath: string,
    chat: { chatId: string; chatType?: string },
    session: CodexSession,
    feishuClient: FeishuClient,
    runState: {
      done: boolean;
      result?: CodexResumeResult;
      error?: unknown;
    },
    card: {
      messageId?: string;
      projectRootPath: string;
      startedAtMs: number;
      projectLabel?: string;
      prompt: string;
      progressSummary?: string;
    }
  ): Promise<{ includesRunResult: boolean; messageId?: string; bindingSummary: string }> {
    await this.bindChatToSession(config, queuePath, chat, session, feishuClient);
    const summary = formatNewSessionBindingResult(session);
    const includesRunResult = runState.done;
    const messageId = await this.publishNewSessionStatusCard(
      config,
      feishuClient,
      {
        chatId: chat.chatId,
        messageId: card.messageId,
        fallbackTextOnError: true
      },
      {
        phase: includesRunResult
          ? runState.result?.ok ? "done" : "failed"
        : "bound",
        projectRootPath: card.projectRootPath,
        startedAtMs: card.startedAtMs,
        projectLabel: card.projectLabel,
        prompt: card.prompt,
        session,
        bindingSummary: summary,
        result: runState.result,
        error: runState.error,
        progressSummary: card.progressSummary
      }
    );
    return {
      includesRunResult,
      messageId,
      bindingSummary: summary
    };
  }

  private async publishNewSessionStatusCard(
    config: BridgeConfig,
    feishuClient: FeishuClient,
    target: {
      chatId: string;
      messageId?: string;
      fallbackTextOnError: boolean;
    },
    details: NewSessionStatusDetails
  ): Promise<string | undefined> {
    const card = await this.buildNewSessionStatusCard(config, details);
    try {
      if (target.messageId) {
        const result = await feishuClient.updateInteractiveMessage(config, target.messageId, card);
        return result.messageId ?? target.messageId;
      }
      const result = await feishuClient.sendInteractiveMessageToReceiver(
        config,
        {
          receiveIdType: "chat_id",
          receiveId: target.chatId
        },
        card
      );
      return result.messageId;
    } catch (error) {
      stderrLogger.warn(
        "[inbound]",
        "failed to publish new-session status card",
        JSON.stringify({
          chatId: target.chatId,
          phase: details.phase,
          hasMessageId: Boolean(target.messageId),
          error: formatError(error)
        })
      );
      if (target.fallbackTextOnError) {
        await feishuClient.sendTextMessage(
          config,
          {
            receiveIdType: "chat_id",
            receiveId: target.chatId
          },
          buildNewSessionFallbackText(details)
        );
      }
      return target.messageId;
    }
  }

  private async buildNewSessionStatusCard(
    config: BridgeConfig,
    details: NewSessionStatusDetails
  ): Promise<ReturnType<typeof buildNotificationCard>> {
    const gitBranch = details.session?.gitBranch ?? await formatGitBranchValueForCwd(details.projectRootPath);
    return buildNotificationCard(
      {
        source: "codex-cli",
        title: newSessionStatusTitle(details),
        status: newSessionNotifyStatus(details),
        summary: buildNewSessionStatusSummary(details),
        cwd: details.projectRootPath,
        gitBranch,
        projectLabel: details.projectLabel,
        codexSessionId: details.session?.id,
        codexSessionTitle: details.session?.title,
        codexSessionLabel: details.session ? undefined : "creating...",
        nextSteps: details.nextSteps
      },
      config,
      { useConfiguredCodexSession: false }
    );
  }

  private async findCreatedProjectSession(
    config: BridgeConfig,
    projectId: string,
    beforeIds: Set<string>,
    startedAtSeconds: number
  ): Promise<CodexSession | undefined> {
    for (let attempt = 0; attempt <= NEW_SESSION_DISCOVERY_RETRIES; attempt += 1) {
      const sessions = await listCodexSessions(config.codex, {
        all: true,
        includeTemporary: true,
        projectId
      });
      const newSession = sessions.find((session) => !beforeIds.has(session.id));
      if (newSession) return newSession;

      const recentSession = sessions.find((session) => session.createdAt >= startedAtSeconds);
      if (recentSession) return recentSession;

      if (attempt < NEW_SESSION_DISCOVERY_RETRIES) {
        await sleep(NEW_SESSION_DISCOVERY_INTERVAL_MS);
      }
    }
    return undefined;
  }

  private async selectProjectForChat(
    config: BridgeConfig,
    queuePath: string,
    chat: { chatId: string; chatType?: string },
    selector: string,
    feishuClient: FeishuClient
  ): Promise<string> {
    const project = await findCodexProject(config.codex, selector);
    if (!project) {
      return `没有找到可绑定的 Codex project：${selector}\n\n请先发送 list-project 查看可用 project。`;
    }
    return this.bindChatToProject(config, queuePath, chat, project, feishuClient);
  }

  private async selectSessionForChat(
    config: BridgeConfig,
    queuePath: string,
    chat: { chatId: string; chatType?: string },
    selector: string,
    feishuClient: FeishuClient
  ): Promise<string> {
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

  private async bindChatToProject(
    config: BridgeConfig,
    queuePath: string,
    chat: { chatId: string; chatType?: string },
    project: CodexProject,
    feishuClient: FeishuClient
  ): Promise<string> {
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

  private async buildCurrentChatWorkStatusCard(
    config: BridgeConfig,
    queuePath: string,
    chatId: string,
    options: { full: boolean }
  ): Promise<Record<string, unknown>> {
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
    const context: WorkStatusContext = {
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

  private async unbindProjectForChat(
    config: BridgeConfig,
    queuePath: string,
    command: Pick<ExtractedAgentCommand, "messageId" | "chatId">,
    feishuClient: FeishuClient
  ): Promise<void> {
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
      ].filter((line): line is string => line !== undefined).join("\n")
      : "当前群没有绑定 Codex project，无需解绑。";
    await feishuClient.sendTextMessage(
      config,
      {
        receiveIdType: "chat_id",
        receiveId: command.chatId
      },
      summary
    );
    stderrLogger.info(
      "[inbound]",
      "handled control command",
      JSON.stringify({
        control: "unbind-project",
        status: "done",
        title: "Chat Codex project unbound",
        messageId: command.messageId,
        chatId: command.chatId,
        sessionId: binding?.sessionId
      })
    );
  }

  private async unbindSessionForChat(
    config: BridgeConfig,
    queuePath: string,
    command: Pick<ExtractedAgentCommand, "messageId" | "chatId">,
    feishuClient: FeishuClient
  ): Promise<void> {
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
        ].filter((line): line is string => line !== undefined).join("\n")
        : [
          "已解除当前群 active session，保留 Codex project 绑定。",
          "",
          before.projectDisplayLabel ? `当前 project：${before.projectDisplayLabel}` : undefined,
          `原 active session：${before.sessionTitle || "(untitled)"} (${shortId(before.sessionId)})`,
          "",
          "后续普通任务会先要求重新选择 session；也可以发送 new-session 在当前 project 下开启新会话。"
        ].filter((line): line is string => line !== undefined).join("\n");
    await feishuClient.sendTextMessage(
      config,
      {
        receiveIdType: "chat_id",
        receiveId: command.chatId
      },
      summary
    );
    stderrLogger.info(
      "[inbound]",
      "handled control command",
      JSON.stringify({
        control: "unbind-session",
        status: "done",
        title: "Chat Codex active session unbound",
        messageId: command.messageId,
        chatId: command.chatId,
        projectId: binding?.projectId,
        sessionId: before?.sessionId
      })
    );
  }

  private async bindChatToSession(
    config: BridgeConfig,
    queuePath: string,
    chat: { chatId: string; chatType?: string },
    session: CodexSession,
    feishuClient: FeishuClient
  ): Promise<string> {
    const chatInfo = await this.getChatInfoSafely(config, chat.chatId, feishuClient);
    const sharedNotice = await this.formatSharedSessionNotice(
      config,
      queuePath,
      session.id,
      chat.chatId,
      feishuClient
    );
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
    ].filter((line): line is string => line !== undefined).join("\n");
  }

  private async formatSharedSessionNotice(
    config: BridgeConfig,
    queuePath: string,
    sessionId: string,
    currentChatId: string,
    feishuClient: FeishuClient
  ): Promise<string | undefined> {
    const bindings = await listChatSessionBindingsBySession(queuePath, sessionId, {
      excludeChatId: currentChatId,
      limit: 10
    });
    if (bindings.length === 0) return undefined;

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

  private async getChatInfoSafely(
    config: BridgeConfig,
    chatId: string,
    feishuClient: FeishuClient
  ): Promise<{ name?: string; chatType?: string } | undefined> {
    try {
      return await feishuClient.getChatInfo(config, chatId);
    } catch (error) {
      stderrLogger.info(
        "[inbound]",
        "failed to resolve chat info",
        JSON.stringify({
          chatId,
          error: formatError(error)
        })
      );
      return undefined;
    }
  }

  private cacheImageCandidates(candidates: ImageResourceCandidate[]): void {
    const nowMs = Date.now();
    for (const candidate of candidates) {
      const key = imageCandidateMapKey(candidate.chatId, candidate.senderKey);
      const current = (this.recentImageCandidates.get(key) ?? [])
        .filter((item) => nowMs - item.createdAtMs <= IMAGE_CANDIDATE_TTL_MS);
      current.push(candidate);
      this.recentImageCandidates.set(key, current.slice(-IMAGE_CANDIDATE_MAX_PER_SENDER));
    }
  }

  private consumeRecentImageCandidates(
    command: Pick<ExtractedAgentCommand, "chatId" | "sender" | "text">,
    nowMs: number
  ): ImageResourceCandidate[] {
    if (!shouldAttachRecentImage(command.text)) return [];
    const senderKey = senderCandidateKey(command.sender);
    if (!senderKey) return [];
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

  private async downloadImageAttachments(
    config: BridgeConfig,
    candidates: ImageResourceCandidate[],
    feishuClient: FeishuClient
  ): Promise<AgentCommandAttachment[]> {
    const attachments: AgentCommandAttachment[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const outputPath = join(
        CONFIG_DIR,
        "resources",
        safePathSegment(candidate.chatId),
        safePathSegment(candidate.messageId),
        `image-${index + 1}-${safePathSegment(candidate.resourceKey)}.png`
      );
      const downloaded = await feishuClient.downloadMessageResource(
        config,
        candidate.messageId,
        candidate.resourceKey,
        outputPath
      );
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

  private logHandledControl(control: string, command: Pick<ExtractedAgentCommand, "messageId" | "chatId">): void {
    stderrLogger.info(
      "[inbound]",
      "handled control command",
      JSON.stringify({
        control,
        status: "done",
        messageId: command.messageId,
        chatId: command.chatId
      })
    );
  }

  private async loadRuntimeConfig(fallback: BridgeConfig): Promise<BridgeConfig> {
    const configPath = this.options.configPath;
    if (!configPath) return fallback;
    try {
      return await loadConfig(configPath);
    } catch (error) {
      this.lastError = formatError(error);
      stderrLogger.error("[inbound]", "failed to reload runtime config", this.lastError);
      return fallback;
    }
  }
}

export async function startCommandListener(options: {
  configPath?: string;
  feishuClient?: FeishuClient;
  onCommandEnqueued?: (command: AgentCommand) => void | Promise<void>;
} = {}): Promise<FeishuCommandListener> {
  const listener = new FeishuCommandListener({
    ...options,
    configPath: options.configPath ?? CONFIG_PATH
  });
  await listener.start();
  return listener;
}

export async function getCommandListenerSnapshot(configPath = CONFIG_PATH): Promise<{
  status: CommandListenerStatus;
  queue: Awaited<ReturnType<typeof getCommandQueueStats>>;
}> {
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

function buildCardActionUpdateResponse(card: Record<string, unknown>): Record<string, unknown> {
  return {
    card: {
      type: "raw",
      data: card
    }
  };
}

function paginate<T>(items: T[], requestedPage: number, pageSize: number): {
  items: T[];
  info: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasPrev: boolean;
    hasNext: boolean;
  };
} {
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

function buildWorkStatusCard(
  context: WorkStatusContext,
  options: { full: boolean }
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    statusMarkdownBlock(formatStatusBindingSummary(context)),
    { tag: "hr" },
    statusMarkdownBlock(formatRunningTaskSummary(context)),
    { tag: "hr" },
    statusMarkdownBlock(formatQueueSummary(context)),
    { tag: "hr" },
    statusMarkdownBlock(formatRuntimeSummary(context))
  ];

  if (options.full) {
    elements.push(
      { tag: "hr" },
      statusMarkdownBlock(formatFullRuntimeDetails(context)),
      { tag: "hr" },
      statusMarkdownBlock(formatFullRecentCommands(context)),
      { tag: "hr" },
      statusMarkdownBlock(formatFullConfigDetails(context))
    );
  } else {
    elements.push(
      { tag: "hr" },
      statusMarkdownBlock("完整信息：发送 `status-full`。")
    );
  }

  return statusCard(
    options.full ? "当前工作状态（完整）" : "当前工作状态",
    statusCardTemplate(context),
    elements
  );
}

function formatStatusBindingSummary(context: WorkStatusContext): string {
  const binding = context.binding;
  return [
    "**绑定**",
    binding?.projectDisplayLabel ? `project: ${truncateSingleLine(binding.projectDisplayLabel, 80)}` : "project: 未绑定",
    binding?.sessionId
      ? `session: ${truncateSingleLine(binding.sessionTitle || "(untitled)", 80)} (${shortId(binding.sessionId)})`
      : "session: 未绑定",
    binding?.sessionCwd ? `cwd: \`${truncateMiddle(binding.sessionCwd, 96)}\`` : undefined,
    formatGitBranchLine(context.gitStatus)
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatRunningTaskSummary(context: WorkStatusContext): string {
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
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatQueueSummary(context: WorkStatusContext): string {
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

function formatRuntimeSummary(context: WorkStatusContext): string {
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
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatFullRuntimeDetails(context: WorkStatusContext): string {
  return [
    "**Runtime 详情**",
    ...formatStatusRuntimeLines(context.runtime, {
      currentSessionActive: context.currentSessionActive,
      currentSessionId: context.binding?.sessionId
    }).slice(1)
  ].join("\n");
}

function formatFullRecentCommands(context: WorkStatusContext): string {
  return [
    `**最近任务**（最多 ${STATUS_RECENT_COMMAND_LIMIT} 条，最新在前）`,
    ...formatStatusCommandLines(
      context.recentCommands,
      context.nowMs,
      context.config.codex.inProgressTimeoutMs
    )
  ].join("\n");
}

function formatFullConfigDetails(context: WorkStatusContext): string {
  return [
    "**补充信息**",
    `queue: \`${context.queuePath}\``,
    `global: total=${context.queue.total} pending=${context.queue.pending} in_progress=${context.queue.inProgress} done=${context.queue.done} failed=${context.queue.failed}`,
    `codex.enabled=${context.config.codex.enabled}`,
    `codex.timeout=${formatDuration(context.config.codex.timeoutMs)}`,
    `in_progress timeout=${formatDuration(context.config.codex.inProgressTimeoutMs)} recovery=${context.config.codex.inProgressRecovery}`
  ].join("\n");
}

function statusCard(
  title: string,
  template: string,
  elements: Array<Record<string, unknown>>
): Record<string, unknown> {
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

function statusMarkdownBlock(content: string): Record<string, unknown> {
  return {
    tag: "markdown",
    content
  };
}

function statusCardTemplate(context: WorkStatusContext): string {
  if (context.runningCommand) return "blue";
  if ((context.sessionStats?.pending ?? 0) > 0) return "yellow";
  if (!context.runtime?.running || !context.runtime.ready) return "yellow";
  return "green";
}

function formatStatusRuntimeLines(
  runtime: Awaited<ReturnType<typeof readStandaloneListenerRuntimeStatus>>,
  options: {
    currentSessionActive: boolean;
    currentSessionId?: string;
  }
): string[] {
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
  ].filter((line): line is string => line !== undefined);
}

function formatStatusCommandLines(
  commands: AgentCommand[],
  nowMs: number,
  timeoutMs: number
): string[] {
  if (commands.length === 0) return ["- 无任务记录。"];

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
      ].filter((item): item is string => item !== undefined).join(" "),
      `  text: ${truncateSingleLine(command.text, 180)}`,
      command.statusSummary ? `  card summary: ${truncateSingleLine(command.statusSummary, 180)}` : undefined,
      command.statusUpdatedAt ? `  card updated: ${formatIsoTime(command.statusUpdatedAt)}` : undefined,
      command.statusNotifyError ? `  card error: ${truncateSingleLine(command.statusNotifyError, 180)}` : undefined,
      command.resultSummary ? `  result: ${truncateSingleLine(command.resultSummary, 180)}` : undefined
    ].filter((line): line is string => line !== undefined);
    return lines;
  });
}

function formatQueueHint(options: {
  hasSession: boolean;
  currentSessionActive: boolean;
  pending: number;
  inProgress: number;
  runtimeReady: boolean;
  runtimeRunning: boolean;
}): string {
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

function formatIsoTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

function formatOptionalIsoTime(value: string | undefined): string {
  return value ? formatIsoTime(value) : "never";
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

function truncateSingleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(4, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function newSessionStatusTitle(details: NewSessionStatusDetails): string {
  switch (details.phase) {
    case "creating":
      return "Codex session creating";
    case "bound":
      return "Codex session initializing";
    case "done":
      return "Codex session ready";
    case "failed":
      return details.session || details.result?.ok
        ? "Codex session needs attention"
        : "Codex session failed";
  }
}

function newSessionNotifyStatus(details: NewSessionStatusDetails): NotifyStatus {
  switch (details.phase) {
    case "creating":
    case "bound":
      return "in_progress";
    case "done":
      return "success";
    case "failed":
      return details.session || details.result?.ok ? "needs_action" : "failed";
  }
}

function buildNewSessionStatusSummary(details: NewSessionStatusDetails): string {
  const elapsedLine = formatNewSessionElapsedLine(details);
  const lines = [
    `创建状态：${newSessionPhaseLabel(details)}`,
    elapsedLine,
    `指令摘要：${formatNewSessionCommandSummary(details.prompt)}`,
    details.session
      ? `Active session：${details.session.title || "(untitled)"} (${shortId(details.session.id)})`
      : undefined
  ].filter((line): line is string => Boolean(line));

  if (details.phase === "creating") {
    lines.push("创建进展：正在等待 Codex CLI 建立会话并写入本地 state DB。");
  }
  if (details.phase === "bound") {
    lines.push("初始化指令：仍在执行，完成后会继续更新本卡片。");
  }
  if (details.bindingSummary) {
    lines.push(`绑定结果：\n${details.bindingSummary}`);
  }
  if (details.result) {
    lines.push(`初始化结果：\n${formatNewSessionResultForCard(details.result)}`);
  } else if (details.error) {
    lines.push(`异常信息：${truncateMultiline(formatError(details.error), 900)}`);
  }
  if (details.phase === "failed" && !details.session && details.result?.ok) {
    lines.push("识别结果：Codex CLI 已返回成功，但暂未在本地 state DB 中识别到新会话。");
  }
  if (details.phase === "failed" && !details.session && !details.result?.ok && !details.error) {
    lines.push("失败原因：Codex CLI 未正常完成，且未返回可用错误信息。");
  }
  if (details.progressSummary) {
    lines.push(`最近进展：\n${truncateMultiline(details.progressSummary, 900)}`);
  }
  return lines.join("\n");
}

function formatNewSessionElapsedLine(details: NewSessionStatusDetails): string {
  const nowMs = details.nowMs ?? Date.now();
  const elapsed = formatDuration(nowMs - details.startedAtMs);
  if (details.phase === "done" || details.phase === "failed") {
    return `总耗时：${elapsed}`;
  }
  return `已耗时：${elapsed}`;
}

function buildNewSessionFallbackText(details: NewSessionStatusDetails): string {
  return [
    newSessionStatusTitle(details),
    "",
    buildNewSessionStatusSummary(details),
    details.nextSteps?.length ? "" : undefined,
    ...(details.nextSteps ?? []).map((item) => `下一步：${item}`)
  ].filter((line): line is string => line !== undefined).join("\n");
}

function newSessionPhaseLabel(details: NewSessionStatusDetails): string {
  switch (details.phase) {
    case "creating":
      return "创建中";
    case "bound":
      return "已创建 / 初始化中";
    case "done":
      return "完成";
    case "failed":
      if (details.session || details.result?.ok) return "需要确认";
      return "失败";
  }
}

function formatNewSessionCommandSummary(prompt: string | undefined): string {
  const normalizedPrompt = (prompt ?? "").trim();
  if (!normalizedPrompt || normalizedPrompt === DEFAULT_NEW_SESSION_PROMPT) return "new-session";
  return `new-session ${truncateSingleLine(normalizedPrompt, 160)}`;
}

function formatNewSessionProgressSummary(values: string[]): string | undefined {
  const items = values
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (items.length === 0) return undefined;
  return items.map((item) => `- ${truncateSingleLine(item, 220)}`).join("\n");
}

function formatNewSessionBindingResult(session: CodexSession): string {
  return [
    "- 已绑定为当前群 active session",
    session.projectDisplayLabel ? `- Project：${truncateSingleLine(session.projectDisplayLabel, 120)}` : undefined,
    `- Session：${truncateSingleLine(session.title || "(untitled)", 120)} (${shortId(session.id)})`,
    `- Cwd：${truncateSingleLine(session.cwd, 180)}`
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function formatNewSessionResultForCard(result: CodexResumeResult): string {
  const body = (result.lastMessage || result.stdout || result.stderr).trim();
  const status = result.ok
    ? `Codex CLI 已完成，用时 ${formatDuration(result.durationMs)}。`
    : result.timedOut
      ? `Codex CLI 超时，用时 ${formatDuration(result.durationMs)}。`
      : `Codex CLI 退出码 ${result.exitCode ?? "null"}${result.signal ? `，signal=${result.signal}` : ""}。`;
  const bodySummary = formatNewSessionResultBody(body);
  return bodySummary ? `${status}\n输出摘要：\n${bodySummary}` : status;
}

function formatNewSessionResultBody(value: string): string | undefined {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;
  const selected = lines.slice(0, 6);
  if (lines.length > selected.length) {
    selected.push("...");
  }
  const body = truncateMultiline(selected.join("\n"), 700)
    .replaceAll("```", "'''");
  return ["```", body, "```"].join("\n");
}

function truncateMultiline(value: string, maxLength: number): string {
  const normalized = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("\n")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function extractCommandFromMessage(
  event: MessageReceiveEvent,
  config: BridgeConfig
): CommandExtractionResult {
  if (!config.inbound.enabled) {
    return { ignoredReason: "inbound disabled" };
  }

  const message = event.message;
  const sender = event.sender;
  if (!["text", "image", "post"].includes(message.message_type)) {
    return { ignoredReason: `unsupported message_type=${message.message_type}` };
  }

  const senderOpenId = sender.sender_id?.open_id;
  if (
    config.inbound.allowedOpenIds?.length &&
    (!senderOpenId || !config.inbound.allowedOpenIds.includes(senderOpenId))
  ) {
    return { ignoredReason: "sender not allowed" };
  }

  const rawText = readMessageText(message.message_type, message.content);
  if (!hasRequiredMention(event, config, rawText)) {
    return { ignoredReason: "missing bot mention" };
  }

  const text = stripAtMentions(
    rawText,
    (message.mentions ?? []).map((mention) => mention.key)
  );

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

function extractImageCandidates(event: MessageReceiveEvent): ImageResourceCandidate[] {
  if (event.message.message_type !== "image" && event.message.message_type !== "post") return [];
  const senderKey = senderCandidateKey({
    openId: event.sender.sender_id?.open_id,
    userId: event.sender.sender_id?.user_id,
    unionId: event.sender.sender_id?.union_id,
    senderType: event.sender.sender_type
  });
  if (!senderKey) return [];
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

function shouldCacheImageOnly(event: MessageReceiveEvent, config: BridgeConfig): boolean {
  if (event.message.chat_type === "p2p") return false;
  return !hasRequiredMention(
    event,
    config,
    readMessageText(event.message.message_type, event.message.content)
  );
}

function readTextContent(content: string): string {
  return readOptionalTextContent(content) ?? content;
}

function readMessageText(messageType: string, content: string): string {
  if (messageType === "text") return readTextContent(content);
  if (messageType === "post") return readPostTextContent(content);
  return readOptionalTextContent(content) ?? "";
}

function readOptionalTextContent(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (isObject(parsed) && typeof parsed.text === "string") {
      return parsed.text;
    }
  } catch {
    return content;
  }
  return undefined;
}

function readImageResourceKeys(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  const keys = [
    stringProperty(parsed, "image_key"),
    stringProperty(parsed, "file_key"),
    ...collectPostImageKeys(parsed)
  ].filter((item): item is string => Boolean(item));
  return Array.from(new Set(keys));
}

function readPostTextContent(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return content;
  }
  if (!isObject(parsed)) return "";
  const posts = getPostPayloads(parsed);
  const parts: string[] = [];
  for (const post of posts) {
    const title = stringProperty(post, "title");
    if (title) parts.push(title);
    for (const item of flattenPostContent(post.content)) {
      if (!isObject(item)) continue;
      const tag = stringProperty(item, "tag");
      if (tag === "text" || tag === "a") {
        const text = stringProperty(item, "text");
        if (text) parts.push(text);
      } else if (tag === "at") {
        const userId = stringProperty(item, "user_id") ?? stringProperty(item, "open_id");
        const userName = stringProperty(item, "user_name") ?? stringProperty(item, "text");
        if (userId || userName) {
          parts.push(`<at user_id="${userId ?? ""}">${userName ?? ""}</at>`);
        }
      } else {
        const text = stringProperty(item, "text");
        if (text) parts.push(text);
      }
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function collectPostImageKeys(value: unknown): string[] {
  const keys: string[] = [];
  for (const post of getPostPayloads(value)) {
    for (const item of flattenPostContent(post.content)) {
      if (!isObject(item)) continue;
      const tag = stringProperty(item, "tag");
      if (tag === "img" || tag === "image") {
        const imageKey = stringProperty(item, "image_key") ?? stringProperty(item, "file_key");
        if (imageKey) keys.push(imageKey);
      }
    }
  }
  return keys;
}

function getPostPayloads(value: unknown): Array<Record<string, unknown>> {
  if (!isObject(value)) return [];
  const post = value.post;
  if (isObject(post)) {
    const localized = Object.values(post).filter(isObject);
    return localized.length > 0 ? localized : [post];
  }
  return [value];
}

function flattenPostContent(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => Array.isArray(item) ? flattenPostContent(item) : [item]);
}

function hasRequiredMention(
  event: MessageReceiveEvent,
  config: BridgeConfig,
  rawText: string
): boolean {
  if (!config.inbound.requireMention) return true;
  if (event.message.chat_type === "p2p") return true;

  const mentions = event.message.mentions ?? [];
  if (config.inbound.botOpenId) {
    return mentions.some((mention) => mention.id.open_id === config.inbound.botOpenId);
  }

  return mentions.length > 0 || /<at\b/i.test(rawText);
}

function stripAtMentions(text: string, mentionKeys: string[] = []): string {
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

function shouldAttachRecentImage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /(图|图片|截图|照片|相片|这张|image|photo|screenshot)/i.test(trimmed);
}

function senderCandidateKey(sender: ExtractedAgentCommand["sender"]): string | undefined {
  return sender.openId || sender.userId || sender.unionId;
}

function imageCandidateMapKey(chatId: string, senderKey: string): string {
  return `${chatId}\n${senderKey}`;
}

function dedupeImageCandidates(candidates: ImageResourceCandidate[]): ImageResourceCandidate[] {
  const seen = new Set<string>();
  const deduped: ImageResourceCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.messageId}\n${candidate.resourceKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function parseFeishuTimeMs(value: string | undefined): number {
  if (!value) return Date.now();
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function summarizeCodexNewSessionResult(result: {
  ok: boolean;
  durationMs: number;
  lastMessage: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputPath: string;
}): string {
  const body = (result.lastMessage || result.stdout || result.stderr).trim();
  const status = result.ok
    ? `Codex CLI completed in ${result.durationMs}ms.`
    : result.timedOut
      ? `Codex CLI timed out after ${result.durationMs}ms.`
      : `Codex CLI exited with code ${result.exitCode ?? "null"}${result.signal ? ` signal=${result.signal}` : ""}.`;
  const lines = [status];
  if (body) lines.push(body);
  lines.push(`output: ${result.outputPath}`);
  return lines.join("\n");
}

function formatChatBindingLabel(binding: Pick<ChatSessionBinding, "chatId" | "chatName">): string {
  return binding.chatName
    ? `${binding.chatName} (${shortId(binding.chatId)})`
    : `未知群名 (${binding.chatId})`;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function stringProperty(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const stderrLogger = {
  error: (...message: unknown[]) => {
    console.error("[feishu-agent-bridge][error]", ...message);
  },
  warn: (...message: unknown[]) => {
    console.error("[feishu-agent-bridge][warn]", ...message);
  },
  info: (...message: unknown[]) => {
    console.error("[feishu-agent-bridge][info]", ...message);
  },
  debug: (...message: unknown[]) => {
    console.error("[feishu-agent-bridge][debug]", ...message);
  },
  trace: (...message: unknown[]) => {
    console.error("[feishu-agent-bridge][trace]", ...message);
  }
};
