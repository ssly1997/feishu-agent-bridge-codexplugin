import { getPendingSessionIds, recoverInProgressCommands, resolveCommandQueuePath } from "./commandQueue.js";
import { CONFIG_PATH, loadConfig } from "./config.js";
import { processNextCodexCommand } from "./codexWorker.js";
export class CodexRuntimeScheduler {
    options;
    activeSessions = new Set();
    activeRuns = new Map();
    constructor(options = {}) {
        this.options = options;
    }
    getStatus() {
        return {
            activeSessions: Array.from(this.activeSessions).sort()
        };
    }
    async recoverAndWakePending() {
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
    wake(sessionId) {
        if (!sessionId)
            return undefined;
        const existing = this.activeRuns.get(sessionId);
        if (existing)
            return existing;
        this.activeSessions.add(sessionId);
        const run = this.runSession(sessionId).finally(() => {
            this.activeSessions.delete(sessionId);
            this.activeRuns.delete(sessionId);
        });
        this.activeRuns.set(sessionId, run);
        return run;
    }
    async waitForIdle() {
        await Promise.all(Array.from(this.activeRuns.values()));
    }
    async runSession(sessionId) {
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
            if (!result.processed)
                return;
        }
    }
    process(sessionId) {
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
