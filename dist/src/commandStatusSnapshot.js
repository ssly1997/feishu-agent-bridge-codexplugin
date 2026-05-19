import { resolveCodexModelStatus } from "./codexModels.js";
import { formatGitBranchValueForCwd } from "./gitStatus.js";
export async function resolveCommandStatusSnapshot(config, command) {
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
