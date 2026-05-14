#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { CONFIG_PATH } from "./config.js";
import { processNextCodexCommand } from "./codexWorker.js";
async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!options.watch) {
        const result = await processNextCodexCommand({ configPath: options.configPath });
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.processed && result.ackState === "failed" ? 1 : 0;
        return;
    }
    console.log(JSON.stringify({
        event: "worker_started",
        configPath: options.configPath
    }));
    while (true) {
        const result = await processNextCodexCommand({ configPath: options.configPath });
        console.log(JSON.stringify({ event: "tick", ...result }));
        await delay(result.pollIntervalSeconds * 1000);
    }
}
function parseArgs(args) {
    const options = {
        configPath: CONFIG_PATH,
        watch: false
    };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === "--watch") {
            options.watch = true;
            continue;
        }
        if (arg === "--once") {
            options.watch = false;
            continue;
        }
        if (arg === "--config") {
            const next = args[index + 1];
            if (!next) {
                throw new Error("--config requires a path");
            }
            options.configPath = next;
            index += 1;
            continue;
        }
        if (arg === "-h" || arg === "--help") {
            printHelp();
            process.exit(0);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return options;
}
function printHelp() {
    console.log(`Usage: feishu-agent-codex-worker [--once|--watch] [--config PATH]

Consume Feishu Agent Bridge commands and continue a Codex CLI session with:
  codex exec resume <session_id|--last> -

Options:
  --once         Process at most one pending command, then exit. Default.
  --watch        Keep polling the local command queue.
  --config PATH  Bridge config path. Default: ${CONFIG_PATH}
`);
}
main().catch((error) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
});
