import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ConfigError } from "./config.js";
export async function runCodexResume(prompt, config, options) {
    if (!config.enabled) {
        throw new ConfigError("codex.enabled is false");
    }
    if (!config.sessionId && !config.useLast) {
        throw new ConfigError("codex.sessionId is required unless codex.useLast is true");
    }
    if (!prompt.trim()) {
        throw new ConfigError("prompt must be a non-empty string");
    }
    await mkdir(dirname(options.outputPath), { recursive: true });
    const args = buildCodexResumeArgs(config, options.outputPath);
    const start = options.now?.() ?? Date.now();
    const child = spawn(config.command, args, {
        cwd: config.cwd,
        stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const maxBytes = config.outputMaxBytes;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout = appendLimited(stdout, chunk, maxBytes);
    });
    child.stderr.on("data", (chunk) => {
        stderr = appendLimited(stderr, chunk, maxBytes);
    });
    const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
    }, config.timeoutMs);
    child.stdin.end(`${prompt}\n`);
    const { exitCode, signal } = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, closeSignal) => {
            resolve({ exitCode: code, signal: closeSignal });
        });
    }).finally(() => {
        clearTimeout(timeout);
    });
    const end = options.now?.() ?? Date.now();
    const lastMessage = truncate(await readOptionalFile(options.outputPath), maxBytes);
    return {
        ok: exitCode === 0 && !timedOut,
        command: config.command,
        args,
        cwd: config.cwd,
        exitCode,
        signal,
        timedOut,
        durationMs: Math.max(0, end - start),
        stdout,
        stderr,
        lastMessage,
        outputPath: options.outputPath
    };
}
export function buildCodexResumeArgs(config, outputPath) {
    const args = ["exec"];
    if (config.model)
        args.push("--model", config.model);
    if (config.profile)
        args.push("--profile", config.profile);
    if (config.sandbox)
        args.push("--sandbox", config.sandbox);
    if (config.approvalPolicy)
        args.push("--ask-for-approval", config.approvalPolicy);
    args.push("resume", "--json", "-o", outputPath);
    if (config.extraArgs)
        args.push(...config.extraArgs);
    if (config.sessionId) {
        args.push(config.sessionId);
    }
    else if (config.useLast) {
        args.push("--last");
    }
    args.push("-");
    return args;
}
function appendLimited(current, chunk, maxBytes) {
    return truncate(`${current}${chunk}`, maxBytes);
}
function truncate(value, maxBytes) {
    const buffer = Buffer.from(value, "utf8");
    if (buffer.byteLength <= maxBytes)
        return value;
    return `${buffer.subarray(0, Math.max(0, maxBytes - 16)).toString("utf8")}\n[truncated]`;
}
async function readOptionalFile(path) {
    try {
        return await readFile(path, "utf8");
    }
    catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return "";
        }
        throw error;
    }
}
function isNodeError(error) {
    return error instanceof Error && "code" in error;
}
