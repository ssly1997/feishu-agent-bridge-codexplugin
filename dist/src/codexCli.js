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
    const args = buildCodexResumeArgs(config, options.outputPath);
    return runCodexProcess(prompt, config, args, options, config.cwd);
}
export async function runCodexNewSession(prompt, config, options) {
    if (!config.enabled) {
        throw new ConfigError("codex.enabled is false");
    }
    if (!prompt.trim()) {
        throw new ConfigError("prompt must be a non-empty string");
    }
    if (!options.cwd.trim()) {
        throw new ConfigError("new Codex session cwd is required");
    }
    const args = buildCodexExecArgs(config, options.outputPath, options.cwd);
    return runCodexProcess(prompt, config, args, options, options.cwd);
}
async function runCodexProcess(prompt, config, args, options, cwd) {
    await mkdir(dirname(options.outputPath), { recursive: true });
    const start = options.now?.() ?? Date.now();
    const child = spawn(config.command, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let timedOut = false;
    const maxBytes = config.outputMaxBytes;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout = appendLimited(stdout, chunk, maxBytes);
        stdoutLineBuffer = processProgressLines(stdoutLineBuffer + chunk, (summary) => {
            options.onProgress?.({
                summary,
                receivedAtMs: options.now?.() ?? Date.now()
            });
        });
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
    const trailingSummary = progressSummaryFromJsonLine(stdoutLineBuffer);
    if (trailingSummary) {
        options.onProgress?.({
            summary: trailingSummary,
            receivedAtMs: options.now?.() ?? Date.now()
        });
    }
    const end = options.now?.() ?? Date.now();
    const lastMessage = truncate(await readOptionalFile(options.outputPath), maxBytes);
    return {
        ok: exitCode === 0 && !timedOut,
        command: config.command,
        args,
        cwd,
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
    appendSharedCodexExecArgs(args, config);
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
export function buildCodexExecArgs(config, outputPath, cwd) {
    const args = ["exec"];
    appendSharedCodexExecArgs(args, config);
    args.push("--cd", cwd, "--json", "-o", outputPath);
    if (config.extraArgs)
        args.push(...config.extraArgs);
    args.push("-");
    return args;
}
function appendSharedCodexExecArgs(args, config) {
    if (config.model)
        args.push("--model", config.model);
    if (config.profile)
        args.push("--profile", config.profile);
    if (config.sandbox)
        args.push("--sandbox", config.sandbox);
    if (config.approvalPolicy)
        args.push("--ask-for-approval", config.approvalPolicy);
}
function appendLimited(current, chunk, maxBytes) {
    return truncate(`${current}${chunk}`, maxBytes);
}
function processProgressLines(input, onSummary) {
    const lines = input.split(/\r?\n/);
    const rest = lines.pop() ?? "";
    for (const line of lines) {
        const summary = progressSummaryFromJsonLine(line);
        if (summary)
            onSummary(summary);
    }
    return rest;
}
export function progressSummaryFromJsonLine(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return undefined;
    }
    return progressSummaryFromEvent(parsed);
}
function progressSummaryFromEvent(event) {
    if (!isRecord(event))
        return undefined;
    const type = stringValue(event.type);
    const payload = isRecord(event.payload) ? event.payload : undefined;
    if (type === "response_item" && payload?.type === "message") {
        const summary = publicAssistantMessageSummary(payload);
        if (summary)
            return summary;
    }
    if (type === "event_msg" && payload?.type === "agent_message") {
        const summary = publicAgentMessageSummary(payload);
        if (summary)
            return summary;
    }
    if (type === "agent_message") {
        const summary = publicAgentMessageSummary(event);
        if (summary)
            return summary;
    }
    if (type === "response_item" && payload?.type === "function_call") {
        const summary = publicFunctionCallSummary(payload);
        if (summary)
            return summary;
    }
    if (type === "response_item" && payload?.type === "function_call_output") {
        const summary = publicFunctionCallOutputSummary(payload);
        if (summary)
            return summary;
    }
    if (type === "function_call") {
        const summary = publicFunctionCallSummary(event);
        if (summary)
            return summary;
    }
    return undefined;
}
function publicAgentMessageSummary(event) {
    const phase = stringValue(event.phase);
    const message = stringValue(event.message);
    if (phase === "commentary" && message) {
        return truncateProgress(`进展：${message}`);
    }
    return undefined;
}
function publicAssistantMessageSummary(event) {
    const role = stringValue(event.role);
    const phase = stringValue(event.phase);
    if (role !== "assistant" || phase !== "commentary")
        return undefined;
    const message = contentText(event.content);
    return message ? truncateProgress(`进展：${message}`) : undefined;
}
function publicFunctionCallSummary(event) {
    const name = stringValue(event.name);
    if (!name)
        return undefined;
    if (name === "exec_command") {
        const args = parseJsonObject(stringValue(event.arguments));
        const command = args ? stringValue(args.cmd) : undefined;
        return shellCommandProgressSummary(command) ?? "正在执行本地命令";
    }
    if (name === "apply_patch")
        return "正在修改代码";
    if (name === "update_plan")
        return "正在更新任务计划";
    if (name === "view_image")
        return "正在查看图片";
    if (name === "parallel")
        return "正在并行读取上下文";
    return `正在调用工具：${name}`;
}
function publicFunctionCallOutputSummary(event) {
    const output = stringValue(event.output);
    if (!output)
        return undefined;
    const testMatch = output.match(/# tests (\d+)[\s\S]*# pass \1[\s\S]*# fail 0/);
    if (testMatch)
        return `工具结果：测试通过（${testMatch[1]} passed）`;
    if (/MCP smoke passed/.test(output))
        return "工具结果：插件 smoke 验证通过";
    const exitMatch = output.match(/Process exited with code (-?\d+)/);
    if (exitMatch) {
        return exitMatch[1] === "0"
            ? "工具结果：命令执行成功"
            : `工具结果：命令退出码 ${exitMatch[1]}`;
    }
    return undefined;
}
function shellCommandProgressSummary(command) {
    if (!command)
        return undefined;
    const normalized = command.replace(/\s+/g, " ").trim();
    if (/^corepack pnpm test\b/.test(normalized))
        return "正在运行测试：pnpm test";
    if (/^corepack pnpm smoke:plugin\b/.test(normalized))
        return "正在运行插件 smoke 验证";
    if (/^corepack pnpm codex:plugin:install\b/.test(normalized))
        return "正在刷新本地插件缓存";
    if (/^git status\b/.test(normalized))
        return "正在检查 Git 状态";
    if (/^git diff\b/.test(normalized))
        return "正在查看代码差异";
    if (/^git log\b/.test(normalized))
        return "正在查看 Git 提交记录";
    if (/^(rg|grep)\b/.test(normalized))
        return "正在搜索代码";
    if (/^(sed|nl|cat|tail|head|ls)\b/.test(normalized))
        return "正在读取本地文件";
    if (/^sqlite3\b/.test(normalized))
        return "正在查看本地队列状态";
    if (/^ps\b/.test(normalized))
        return "正在检查本地进程状态";
    if (/^screen\b/.test(normalized))
        return "正在安排后台 runtime 操作";
    return undefined;
}
function parseJsonObject(value) {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(value);
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function contentText(value) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value))
        return undefined;
    const text = value
        .map((item) => isRecord(item) ? stringValue(item.text) : undefined)
        .filter((item) => Boolean(item))
        .join("\n")
        .trim();
    return text || undefined;
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
function truncateProgress(value) {
    return value.length <= 500 ? value : `${value.slice(0, 485)}... [truncated]`;
}
function stringValue(value) {
    return typeof value === "string" ? value : undefined;
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
