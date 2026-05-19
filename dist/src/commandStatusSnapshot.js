import { resolveCodexModelStatus } from "./codexModels.js";
import { formatGitBranchValueForCwd } from "./gitStatus.js";
export async function resolveCommandStatusSnapshot(config, command, options = {}) {
    const existing = commandStatusSnapshotFromCommand(command);
    if (hasCommandStatusSnapshot(command) && !options.refreshGitBranch) {
        return existing;
    }
    const gitBranch = options.refreshGitBranch
        ? await formatGitBranchValueForCwd(command.sessionCwd ?? config.codex.cwd)
        : existing.gitBranch
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
export function commandStatusSnapshotPatch(snapshot) {
    return {
        statusGitBranch: snapshot.gitBranch,
        statusModel: snapshot.model,
        statusReasoningEffort: snapshot.reasoningEffort,
        statusFastModeEnabled: snapshot.fastModeEnabled
    };
}
function commandStatusSnapshotFromCommand(command) {
    return {
        gitBranch: command.statusGitBranch,
        model: command.statusModel,
        reasoningEffort: command.statusReasoningEffort,
        fastModeEnabled: command.statusFastModeEnabled
    };
}
function hasCommandStatusSnapshot(command) {
    return command.statusGitBranch !== undefined
        || command.statusModel !== undefined
        || command.statusReasoningEffort !== undefined
        || command.statusFastModeEnabled !== undefined;
}
