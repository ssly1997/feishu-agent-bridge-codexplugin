import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitWorkingTreeStatus =
  | { kind: "valid"; branch: string }
  | { kind: "not_git"; reason?: string }
  | { kind: "missing_cwd" }
  | { kind: "error"; error: string };

export async function readGitWorkingTreeStatus(cwd: string | undefined): Promise<GitWorkingTreeStatus> {
  if (!cwd) return { kind: "missing_cwd" };

  try {
    const inside = await execGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") {
      return { kind: "not_git", reason: inside };
    }

    try {
      const branch = await execGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
      if (branch) return { kind: "valid", branch };
    } catch {
      const commit = await execGit(cwd, ["rev-parse", "--short", "HEAD"]);
      if (commit) return { kind: "valid", branch: `detached@${commit}` };
    }

    return { kind: "valid", branch: "(unknown)" };
  } catch (error) {
    const message = formatError(error);
    if (/not a git repository|not a gitdir|cannot change to/i.test(message)) {
      return { kind: "not_git", reason: message };
    }
    return { kind: "error", error: message };
  }
}

export function formatGitBranchValue(
  status: GitWorkingTreeStatus,
  options: { maxBranchLength?: number; maxErrorLength?: number } = {}
): string {
  switch (status.kind) {
    case "valid":
      return truncateSingleLine(status.branch, options.maxBranchLength ?? 64);
    case "not_git":
      return "非有效 git 仓库";
    case "missing_cwd":
      return "未检测（当前 session 无 cwd）";
    case "error":
      return `检测失败（${truncateSingleLine(status.error, options.maxErrorLength ?? 96)}）`;
  }
}

export function formatGitBranchLine(
  status: GitWorkingTreeStatus,
  options: { maxBranchLength?: number; maxErrorLength?: number } = {}
): string {
  return `Git branch: ${formatGitBranchValue(status, options)}`;
}

export async function formatGitBranchValueForCwd(
  cwd: string | undefined,
  options: { maxBranchLength?: number; maxErrorLength?: number } = {}
): Promise<string> {
  return formatGitBranchValue(await readGitWorkingTreeStatus(cwd), options);
}

async function execGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 2000,
    maxBuffer: 64 * 1024
  });
  return stdout.trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function truncateSingleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 15))}... [truncated]`;
}
