import { resolveCodexModelStatus } from "./codexModels.js";
import { formatGitBranchValueForCwd } from "./gitStatus.js";
import type { AgentCommand, BridgeConfig } from "./types.js";

export interface CommandStatusSnapshot {
  gitBranch?: string;
  model?: string;
  reasoningEffort?: string;
  fastModeEnabled?: boolean;
}

export interface CommandStatusSnapshotOptions {
  refreshGitBranch?: boolean;
}

export async function resolveCommandStatusSnapshot(
  config: BridgeConfig,
  command: AgentCommand,
  options: CommandStatusSnapshotOptions = {}
): Promise<CommandStatusSnapshot> {
  const existing = commandStatusSnapshotFromCommand(command);
  if (hasCommandStatusSnapshot(command) && !options.refreshGitBranch) {
    return existing;
  }

  const gitBranch = options.refreshGitBranch
    ? await formatGitBranchValueForCwd(command.sessionCwd ?? config.codex.cwd)
    : existing.gitBranch
      ?? command.sessionGitBranch
      ?? await formatGitBranchValueForCwd(command.sessionCwd ?? config.codex.cwd);

  const needsModelStatus = existing.model === undefined
    || existing.reasoningEffort === undefined
    || existing.fastModeEnabled === undefined;
  const modelStatus = needsModelStatus
    ? await resolveCodexModelStatus({
        sessionModel: command.model,
        bridgeModel: config.codex.model,
        codexCommand: config.codex.command
      })
    : undefined;

  return {
    gitBranch,
    model: existing.model ?? modelStatus?.effectiveModel,
    reasoningEffort: existing.reasoningEffort ?? modelStatus?.reasoningEffort,
    fastModeEnabled: existing.fastModeEnabled ?? modelStatus?.fastModeEnabled
  };
}

export function commandStatusSnapshotPatch(snapshot: CommandStatusSnapshot) {
  return {
    statusGitBranch: snapshot.gitBranch,
    statusModel: snapshot.model,
    statusReasoningEffort: snapshot.reasoningEffort,
    statusFastModeEnabled: snapshot.fastModeEnabled
  };
}

function commandStatusSnapshotFromCommand(command: AgentCommand): CommandStatusSnapshot {
  return {
    gitBranch: command.statusGitBranch,
    model: command.statusModel,
    reasoningEffort: command.statusReasoningEffort,
    fastModeEnabled: command.statusFastModeEnabled
  };
}

function hasCommandStatusSnapshot(command: AgentCommand): boolean {
  return command.statusGitBranch !== undefined
    || command.statusModel !== undefined
    || command.statusReasoningEffort !== undefined
    || command.statusFastModeEnabled !== undefined;
}
