import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const DEFAULT_MCP_LIST_TIMEOUT_MS = 20_000;
const MAX_MCP_LIST_BUFFER_BYTES = 256 * 1024;
export async function readCodexMcpList(config, options = {}) {
    const args = ["mcp", "list"];
    const commandLabel = `${config.command} ${args.join(" ")}`;
    try {
        const { stdout } = await execFileAsync(config.command, args, {
            cwd: config.cwd,
            timeout: options.timeoutMs ?? DEFAULT_MCP_LIST_TIMEOUT_MS,
            maxBuffer: MAX_MCP_LIST_BUFFER_BYTES
        });
        return {
            command: commandLabel,
            servers: parseCodexMcpListOutput(stdout)
        };
    }
    catch (error) {
        return {
            command: commandLabel,
            servers: [],
            error: formatMcpListError(error)
        };
    }
}
export function parseCodexMcpListOutput(output) {
    const servers = [];
    let table;
    for (const line of output.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (/^Name\s+Command\s+Args\s+Env\s+Cwd\s+Status\s+Auth\s*$/i.test(trimmed)) {
            table = "stdio";
            continue;
        }
        if (/^Name\s+Url\s+Bearer Token Env Var\s+Status\s+Auth\s*$/i.test(trimmed)) {
            table = "http";
            continue;
        }
        if (!table || /^Name\s+/i.test(trimmed))
            continue;
        const columns = trimmed.split(/\s{2,}/).map((value) => sanitizeCodexCliText(value.trim()));
        if (table === "stdio" && columns.length >= 7) {
            const [name, command, args, env, cwd, status, auth] = columns;
            servers.push({
                name,
                transport: "stdio",
                command: normalizeMcpField(command),
                args: normalizeMcpField(args),
                env: normalizeMcpField(sanitizeMcpEnvText(env)),
                cwd: normalizeMcpField(cwd),
                status,
                auth
            });
            continue;
        }
        if (table === "http" && columns.length >= 5) {
            const [name, url, bearerTokenEnvVar, status, auth] = columns;
            servers.push({
                name,
                transport: "http",
                url: normalizeMcpField(url),
                bearerTokenEnvVar: normalizeMcpField(bearerTokenEnvVar),
                status,
                auth
            });
        }
    }
    return servers;
}
export function sanitizeCodexCliText(value) {
    return value
        .replace(/figd_[A-Za-z0-9_-]+/g, "figd_***")
        .replace(/(--[A-Za-z0-9_-]*(?:api[-_]?key|token|secret|password)[A-Za-z0-9_-]*=)[^\s]+/gi, "$1***")
        .replace(/\b([A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|ACCESS_TOKEN)[A-Za-z0-9_]*)=([^\s,;]+)/gi, "$1=***")
        .replace(/\b((?:api[-_]?key|token|secret|password|access[-_]?token)=)([^\s,;]+)/gi, "$1***")
        .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***");
}
function sanitizeMcpEnvText(value) {
    return value.replace(/\b([A-Za-z_][A-Za-z0-9_]*)=([^\s,;]+)/g, (_match, key, rawValue) => {
        return `${key}=${rawValue === "*****" ? "*****" : "***"}`;
    });
}
function normalizeMcpField(value) {
    if (!value || value === "-")
        return undefined;
    return value;
}
function formatMcpListError(error) {
    if (!(error instanceof Error))
        return sanitizeCodexCliText(String(error));
    const detail = error;
    const parts = [
        detail.message,
        detail.code ? `code=${detail.code}` : undefined,
        detail.signal ? `signal=${detail.signal}` : undefined,
        detail.killed ? "killed=true" : undefined,
        detail.stderr?.trim() ? `stderr=${detail.stderr.trim()}` : undefined
    ].filter((part) => Boolean(part));
    return sanitizeCodexCliText(parts.join("\n"));
}
