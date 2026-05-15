#!/usr/bin/env node
import { CONFIG_PATH, loadConfig } from "./config.js";
import {
  initializeCommandQueue,
  resolveCommandQueuePath,
  resolveLegacyCommandQueuePath
} from "./commandQueue.js";
import { FeishuClient } from "./feishuClient.js";
import { startCommandListener } from "./inbound.js";
import {
  removeStandaloneListenerRuntimeStatus,
  writeListenerRuntimeStatus
} from "./listenerRuntime.js";
import { CodexRuntimeScheduler } from "./runtimeScheduler.js";

const STATUS_HEARTBEAT_INTERVAL_MS = 5_000;

try {
  const config = await loadConfig(CONFIG_PATH);
  const queuePath = resolveCommandQueuePath(config);
  await initializeCommandQueue(queuePath, {
    legacyJsonPath: resolveLegacyCommandQueuePath(config),
    migrateLegacyJson: true
  });

  const feishuClient = new FeishuClient();
  const scheduler = new CodexRuntimeScheduler({
    configPath: CONFIG_PATH,
    feishuClient,
    logger: (event) => {
      console.log(JSON.stringify(event));
    }
  });
  const recovered = await scheduler.recoverAndWakePending();
  const listener = await startCommandListener({
    configPath: CONFIG_PATH,
    feishuClient,
    onCommandEnqueued: (command) => {
      scheduler.wake(command.sessionId);
    }
  });

  const publishStatus = () => {
    void writeListenerRuntimeStatus(CONFIG_PATH, listener.getStatus(), {
      managedBy: "runtime",
      scheduler: scheduler.getStatus()
    }).catch((error) => {
      console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    });
  };
  publishStatus();
  const statusHeartbeat = setInterval(publishStatus, STATUS_HEARTBEAT_INTERVAL_MS);

  console.log(
    JSON.stringify(
      {
        event: "runtime_started",
        configPath: CONFIG_PATH,
        queuePath,
        recovered,
        listener: listener.getStatus(),
        scheduler: scheduler.getStatus()
      },
      null,
      2
    )
  );

  const shutdown = (signal: NodeJS.Signals) => {
    clearInterval(statusHeartbeat);
    listener.stop();
    void removeStandaloneListenerRuntimeStatus(CONFIG_PATH).finally(() => {
      console.log(`feishu-agent-bridge runtime stopped by ${signal}`);
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exit(1);
}
