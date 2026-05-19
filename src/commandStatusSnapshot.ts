import { resolveCodexModelStatus } from "./codexModels.js";
import { formatGitBranchValueForCwd } from "./gitStatus.js";
import type { AgentCommand, BridgeConfig } from "./types.js";

export interface CommandStatusSnapshot {
  gitBranch?: string;
  model?: string;
  reasoningEffort?: string;
  fastModeEnabled?: boolean;
}

export async function resolveCommandStatusSnapshot(
  config: BridgeConfig,
  command: AgentCommand
): Promise<CommandStatusSnapshot> {
  const existing = commandStatusSnapshotFromCommand(command);
  if (hasCommandStatusSnapshot(command)) {
    return existing;
  }

  const gitBranch = command.sessionGitBranch
    ?? await formatGitBranchValueForCwd(command.sessionCwd ?? config.codex.cwd);
  const modelStatus = await resolveCodexModelStatus({
    sessionModel: command.model,
    bridgeModel: config.codex.model,
    codexCommand: config.codex.command
  });

  return {
    gitBranch,
    model: modelStatus.effectiveModel,
    reasoningEffort: modelStatus.reasoningEffort,
    fastModeEnabled: modelStatus.fastModeEnabled
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
