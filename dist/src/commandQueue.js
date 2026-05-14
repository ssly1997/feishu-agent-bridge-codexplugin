import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_DIR } from "./config.js";
export const DEFAULT_COMMAND_QUEUE_PATH = join(CONFIG_DIR, "commands.json");
export function resolveCommandQueuePath(config) {
    return config.inbound.queuePath ?? DEFAULT_COMMAND_QUEUE_PATH;
}
export async function enqueueCommand(input, queuePath = DEFAULT_COMMAND_QUEUE_PATH) {
    const commands = await readCommandQueue(queuePath);
    const existing = commands.find((command) => command.messageId === input.messageId);
    if (existing) {
        return { command: existing, inserted: false };
    }
    const now = new Date().toISOString();
    const command = {
        id: `fcmd_${randomUUID()}`,
        state: "pending",
        text: input.text,
        rawText: input.rawText,
        messageId: input.messageId,
        chatId: input.chatId,
        chatType: input.chatType,
        sender: input.sender,
        source: "feishu",
        eventId: input.eventId,
        tenantKey: input.tenantKey,
        createdAt: input.createdAt,
        receivedAt: now,
        attempts: 0
    };
    commands.push(command);
    await writeCommandQueue(commands, queuePath);
    return { command, inserted: true };
}
export async function getNextCommand(queuePath = DEFAULT_COMMAND_QUEUE_PATH, options = {}) {
    const claim = options.claim ?? true;
    const commands = await readCommandQueue(queuePath);
    const command = commands.find((item) => item.state === "pending");
    if (!command)
        return undefined;
    if (claim) {
        command.state = "in_progress";
        command.claimedAt = new Date().toISOString();
        command.attempts += 1;
        await writeCommandQueue(commands, queuePath);
    }
    return command;
}
export async function listCommands(queuePath = DEFAULT_COMMAND_QUEUE_PATH, options = {}) {
    const commands = await readCommandQueue(queuePath);
    const filtered = options.state
        ? commands.filter((command) => command.state === options.state)
        : commands;
    return filtered.slice(0, options.limit ?? filtered.length);
}
export async function ackCommand(id, state, queuePath = DEFAULT_COMMAND_QUEUE_PATH, resultSummary) {
    const commands = await readCommandQueue(queuePath);
    const command = commands.find((item) => item.id === id);
    if (!command)
        return undefined;
    command.state = state;
    command.completedAt = new Date().toISOString();
    command.resultSummary = resultSummary;
    await writeCommandQueue(commands, queuePath);
    return command;
}
export async function getCommandQueueStats(queuePath = DEFAULT_COMMAND_QUEUE_PATH) {
    const commands = await readCommandQueue(queuePath);
    return {
        queuePath,
        total: commands.length,
        pending: commands.filter((command) => command.state === "pending").length,
        inProgress: commands.filter((command) => command.state === "in_progress").length,
        done: commands.filter((command) => command.state === "done").length,
        failed: commands.filter((command) => command.state === "failed").length
    };
}
export async function readCommandQueue(queuePath = DEFAULT_COMMAND_QUEUE_PATH) {
    let raw;
    try {
        raw = await readFile(queuePath, "utf8");
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error(`Command queue must contain a JSON array: ${queuePath}`);
    }
    return parsed;
}
async function writeCommandQueue(commands, queuePath) {
    await mkdir(dirname(queuePath), { recursive: true });
    const tempPath = `${queuePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(commands, null, 2)}\n`, "utf8");
    await rename(tempPath, queuePath);
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
