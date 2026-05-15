import {
  getPendingSessionIds,
  recoverInProgressCommands,
  resolveCommandQueuePath
} from "./commandQueue.js";
import { CONFIG_PATH, loadConfig } from "./config.js";
import { FeishuClient } from "./feishuClient.js";
import {
  processNextCodexCommand,
  type CodexCommandProcessResult
} from "./codexWorker.js";

export interface RuntimeSchedulerStatus {
  activeSessions: string[];
}

export class CodexRuntimeScheduler {
  private readonly activeSessions = new Set<string>();
  private readonly activeRuns = new Map<string, Promise<void>>();

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
      activeSessions: Array.from(this.activeSessions).sort()
    };
  }

  async recoverAndWakePending(): Promise<number> {
    const configPath = this.options.configPath ?? CONFIG_PATH;
    const config = await loadConfig(configPath);
    const queuePath = resolveCommandQueuePath(config);
    const recovered = await recoverInProgressCommands(queuePath, {
      timeoutMs: config.codex.inProgressTimeoutMs,
      recovery: config.codex.inProgressRecovery
    });
    for (const sessionId of await getPendingSessionIds(queuePath)) {
      this.wake(sessionId);
    }
    return recovered;
  }

  wake(sessionId: string | undefined): Promise<void> | undefined {
    if (!sessionId) return undefined;
    const existing = this.activeRuns.get(sessionId);
    if (existing) return existing;
    this.activeSessions.add(sessionId);
    const run = this.runSession(sessionId).finally(() => {
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
}
