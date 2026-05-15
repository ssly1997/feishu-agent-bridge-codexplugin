export type ReceiveIdType = "chat_id" | "open_id" | "email";

export type MessageStyle = "card";

export type NotifyStatus = "info" | "success" | "failed" | "needs_action";

export type InboundMode = "long_connection";

export type AgentCommandState = "pending" | "in_progress" | "done" | "failed";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type CodexApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";

export type CodexInProgressRecovery = "mark_failed" | "reset_pending";

export interface BridgeConfig {
  appId?: string;
  appSecret?: string;
  receiveIdType: ReceiveIdType;
  receiveId?: string;
  enabled: boolean;
  defaultTitle: string;
  messageStyle: MessageStyle;
  inbound: InboundConfig;
  codex: CodexCliConfig;
}

export interface InboundConfig {
  enabled: boolean;
  mode: InboundMode;
  /**
   * Legacy JSON queue path. Kept only as an import source for commands.db.
   */
  queuePath?: string;
  queueDbPath?: string;
  requireMention: boolean;
  botOpenId?: string;
  allowedChatIds?: string[];
  allowedOpenIds?: string[];
  acknowledgeOnReceive: boolean;
  acknowledgementText: string;
}

export interface CodexCliConfig {
  enabled: boolean;
  command: string;
  sessionId?: string;
  sessionTitle?: string;
  sessionSource?: string;
  sessionUpdatedAt?: number;
  sessionGitBranch?: string;
  useLast: boolean;
  cwd?: string;
  outputDir?: string;
  stateDbPath?: string;
  model?: string;
  profile?: string;
  sandbox?: CodexSandboxMode;
  approvalPolicy?: CodexApprovalPolicy;
  extraArgs?: string[];
  timeoutMs: number;
  inProgressTimeoutMs: number;
  inProgressRecovery: CodexInProgressRecovery;
  sessionListLimit: number;
  outputMaxBytes: number;
  notifyResult: boolean;
}

export interface LinkItem {
  label?: string;
  url: string;
}

export interface NotifyInput {
  source?: string;
  title?: string;
  status?: NotifyStatus | string;
  summary: string;
  cwd?: string;
  codexSessionId?: string;
  codexSessionTitle?: string;
  codexSessionLabel?: string;
  artifacts?: string[];
  links?: LinkItem[];
  nextSteps?: string[];
  metadata?: Record<string, unknown>;
}

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentCommandSender {
  openId?: string;
  userId?: string;
  unionId?: string;
  senderType?: string;
}

export interface AgentCommand {
  id: string;
  state: AgentCommandState;
  text: string;
  rawText: string;
  messageId: string;
  chatId: string;
  chatType?: string;
  sender: AgentCommandSender;
  source: "feishu";
  eventId?: string;
  tenantKey?: string;
  createdAt?: string;
  receivedAt: string;
  sessionId?: string;
  sessionTitle?: string;
  sessionCwd?: string;
  sessionSource?: string;
  sessionGitBranch?: string;
  sessionUpdatedAt?: number;
  claimedAt?: string;
  completedAt?: string;
  attempts: number;
  resultSummary?: string;
}

export interface NewAgentCommand {
  text: string;
  rawText: string;
  messageId: string;
  chatId: string;
  chatType?: string;
  sender: AgentCommandSender;
  eventId?: string;
  tenantKey?: string;
  createdAt?: string;
  sessionId: string;
  sessionTitle?: string;
  sessionCwd?: string;
  sessionSource?: string;
  sessionGitBranch?: string;
  sessionUpdatedAt?: number;
}
