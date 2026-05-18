import {
  getPendingSessionIds,
  recoverInProgressCommandRecords,
  resolveCommandQueuePath,
  updateCommandStatusMetadata
} from "./commandQueue.js";
import { CONFIG_PATH, loadConfig } from "./config.js";
import { FeishuClient } from "./feishuClient.js";
import {
  processNextCodexCommand,
  type CodexCommandProcessResult
} from "./codexWorker.js";
import { formatGitBranchValueForCwd } from "./gitStatus.js";
import { buildCommandStatusCard } from "./statusCard.js";
import type { AgentCommand, BridgeConfig } from "./types.js";

export interface RecoverAndWakePendingOptions {
  timeoutMs?: number;
  summary?: string;
}

export interface RuntimeSchedulerStatus {
  activeSessions: string[];
  recoveryRunning: boolean;
  lastRecoveryAt?: string;
  lastRecoveredCount?: number;
  lastRecoveryError?: string;
}

export class CodexRuntimeScheduler {
  private readonly activeSessions = new Set<string>();
  private readonly activeRuns = new Map<string, Promise<void>>();
  private recoveryRun: Promise<number> | undefined;
  private lastRecoveryAt: string | undefined;
  private lastRecoveredCount: number | undefined;
  private lastRecoveryError: string | undefined;

  constructor(
    private readonly options: {
      configPath?: string;
      feishuClient?: FeishuClient;
      processor?: (sessionId: string) => Promise<CodexCommandProcessResult>;
      logger?: (event: Record<string, unknown>) => void;
    } = {}
  ) {}

  getStatus(): RuntimeSchedulerStatus {
    return {
      activeSessions: Array.from(this.activeSessions).sort(),
      recoveryRunning: Boolean(this.recoveryRun),
      lastRecoveryAt: this.lastRecoveryAt,
      lastRecoveredCount: this.lastRecoveredCount,
      lastRecoveryError: this.lastRecoveryError
    };
  }

  async recoverAndWakePending(options: RecoverAndWakePendingOptions = {}): Promise<number> {
    if (this.recoveryRun) return this.recoveryRun;
    this.recoveryRun = this.doRecoverAndWakePending(options)
      .then((recovered) => {
        this.lastRecoveryAt = new Date().toISOString();
        this.lastRecoveredCount = recovered;
        this.lastRecoveryError = undefined;
        return recovered;
      })
      .catch((error) => {
        this.lastRecoveryAt = new Date().toISOString();
        this.lastRecoveredCount = undefined;
        this.lastRecoveryError = formatError(error);
        throw error;
      })
      .finally(() => {
        this.recoveryRun = undefined;
      });
    return this.recoveryRun;
  }

  private async doRecoverAndWakePending(options: RecoverAndWakePendingOptions): Promise<number> {
    const configPath = this.options.configPath ?? CONFIG_PATH;
    const config = await loadConfig(configPath);
    const queuePath = resolveCommandQueuePath(config);
    const recoveredCommands = await recoverInProgressCommandRecords(queuePath, {
      timeoutMs: options.timeoutMs ?? config.codex.inProgressTimeoutMs,
      recovery: config.codex.inProgressRecovery,
      summary: options.summary
    });
    await this.updateRecoveredCommandStatusCards(config, queuePath, recoveredCommands);
    for (const sessionId of await getPendingSessionIds(queuePath)) {
      this.wake(sessionId);
    }
    return recoveredCommands.length;
  }

  wake(sessionId: string | undefined): Promise<void> | undefined {
    if (!sessionId) return undefined;
    const existing = this.activeRuns.get(sessionId);
    if (existing) return existing;
    this.activeSessions.add(sessionId);
    const run = this.runSession(sessionId)
      .catch((error) => {
        this.options.logger?.({
          event: "session_error",
          sessionId,
          error: formatError(error)
        });
      })
      .finally(() => {
        this.activeSessions.delete(sessionId);
        this.activeRuns.delete(sessionId);
      });
    this.activeRuns.set(sessionId, run);
    return run;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all(Array.from(this.activeRuns.values()));
  }

  private async runSession(sessionId: string): Promise<void> {
    while (true) {
      const result = await this.process(sessionId);
      this.options.logger?.({
        event: "session_tick",
        sessionId,
        processed: result.processed,
        ackState: result.ackState,
        commandId: result.command?.id,
        reason: result.reason
      });
      if (!result.processed) return;
    }
  }

  private process(sessionId: string): Promise<CodexCommandProcessResult> {
    if (this.options.processor) {
      return this.options.processor(sessionId);
    }
    return processNextCodexCommand({
      configPath: this.options.configPath,
      feishuClient: this.options.feishuClient,
      sessionId
    });
  }

  private async updateRecoveredCommandStatusCards(
    config: BridgeConfig,
    queuePath: string,
    commands: AgentCommand[]
  ): Promise<void> {
    if (commands.length === 0) return;
    await Promise.all(commands.map((command) => (
      this.updateRecoveredCommandStatusCard(config, queuePath, command)
    )));
  }

  private async updateRecoveredCommandStatusCard(
    config: BridgeConfig,
    queuePath: string,
    command: AgentCommand
  ): Promise<void> {
    const statusUpdatedAt = new Date().toISOString();
    const summary = command.resultSummary ?? (
      command.state === "pending"
        ? "Recovered stale in_progress command and returned it to the pending queue."
        : "Recovered stale in_progress command."
    );

    if (!command.statusMessageId || !config.enabled) {
      await updateCommandStatusMetadata(command.id, queuePath, {
        statusUpdatedAt,
        statusSummary: summary
      });
      return;
    }

    try {
      const phase = command.state === "failed" ? "failed" : "queued";
      const gitBranch = await formatGitBranchValueForCwd(command.sessionCwd ?? config.codex.cwd);
      await (this.options.feishuClient ?? new FeishuClient()).updateInteractiveMessage(
        config,
        command.statusMessageId,
        buildCommandStatusCard(command, config, {
          phase,
          nowMs: Date.parse(statusUpdatedAt),
          progressSummary: phase === "queued" ? summary : undefined,
          resultSummary: phase === "failed" ? summary : undefined,
          gitBranch
        })
      );
      await updateCommandStatusMetadata(command.id, queuePath, {
        statusUpdatedAt,
        statusNotifyError: null,
        statusSummary: summary
      });
    } catch (error) {
      await updateCommandStatusMetadata(command.id, queuePath, {
        statusUpdatedAt,
        statusNotifyError: formatError(error),
        statusSummary: summary
      });
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
