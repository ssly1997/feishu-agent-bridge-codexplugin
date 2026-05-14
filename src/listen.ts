#!/usr/bin/env node
import { startCommandListener } from "./inbound.js";

try {
  const listener = await startCommandListener();
  console.log(
    JSON.stringify(
      {
        started: true,
        listener: listener.getStatus()
      },
      null,
      2
    )
  );

  const shutdown = (signal: NodeJS.Signals) => {
    listener.stop();
    console.log(`feishu-agent-bridge listener stopped by ${signal}`);
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(message);
  process.exit(1);
}
