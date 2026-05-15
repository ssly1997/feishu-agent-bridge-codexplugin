#!/usr/bin/env node
import { CONFIG_PATH } from "./config.js";
import { startCommandListener } from "./inbound.js";
import { removeStandaloneListenerRuntimeStatus, writeStandaloneListenerRuntimeStatus } from "./listenerRuntime.js";
const STATUS_HEARTBEAT_INTERVAL_MS = 5_000;
try {
    const listener = await startCommandListener();
    const publishStatus = () => {
        void writeStandaloneListenerRuntimeStatus(CONFIG_PATH, listener.getStatus()).catch((error) => {
            const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            console.error(message);
        });
    };
    publishStatus();
    const statusHeartbeat = setInterval(publishStatus, STATUS_HEARTBEAT_INTERVAL_MS);
    console.log(JSON.stringify({
        started: true,
        listener: listener.getStatus()
    }, null, 2));
    const shutdown = (signal) => {
        clearInterval(statusHeartbeat);
        listener.stop();
        void removeStandaloneListenerRuntimeStatus(CONFIG_PATH).finally(() => {
            console.log(`feishu-agent-bridge listener stopped by ${signal}`);
            process.exit(0);
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}
catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(message);
    process.exit(1);
}
