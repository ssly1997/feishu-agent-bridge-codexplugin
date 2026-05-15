import {
  CONFIG_PATH,
  ConfigError,
  getConfigReadiness,
  loadConfig,
  sanitizeConfig,
  saveConfigPatch
} from "./config.js";
import { buildNotificationCard } from "./card.js";
import {
  ackCommand,
  getCommandQueueStats,
  getNextCommand,
  initializeCommandQueue,
  listCommands,
  resolveCommandQueuePath,
  resolveLegacyCommandQueuePath
} from "./commandQueue.js";
import { FeishuApiError, FeishuClient } from "./feishuClient.js";
import { readStandaloneListenerRuntimeStatus } from "./listenerRuntime.js";
import type {
  AgentCommandState,
  NotifyInput,
  NotifyStatus,
  ToolDefinition,
  ToolResult
} from "./types.js";

type ToolHandler = (args: unknown) => Promise<ToolResult>;

export interface ToolRegistry {
  listTools(): ToolDefinition[];
  callTool(name: string, args: unknown): Promise<ToolResult>;
}

const notifyProperties = {
  source: {
    type: "string",
    description: "Calling agent or automation source, for example codex, claude-desktop, cursor, ci."
  },
  title: {
    type: "string",
    description: "Notification card title."
  },
  status: {
    type: "string",
    enum: ["info", "success", "failed", "needs_action"],
    description: "High-level notification status."
  },
  summary: {
    type: "string",
    description: "Human-readable result summary."
  },
  cwd: {
    type: "string",
    description: "Working directory or execution context."
  },
  projectLabel: {
    type: "string",
    description: "Preformatted project label for this specific notification."
  },
  codexSessionId: {
    type: "string",
    description: "Codex session id for this specific notification."
  },
  codexSessionTitle: {
    type: "string",
    description: "Human-readable Codex session title for this specific notification."
  },
  codexSessionLabel: {
    type: "string",
    description: "Preformatted Codex session label for this specific notification."
  },
  artifacts: {
    type: "array",
    items: { type: "string" },
    description: "Files, build artifacts, or other local outputs worth showing."
  },
  links: {
    type: "array",
    items: {
      type: "object",
      properties: {
        label: { type: "string" },
        url: { type: "string" }
      },
      required: ["url"],
      additionalProperties: false
    },
    description: "Links to external references."
  },
  nextSteps: {
    type: "array",
    items: { type: "string" },
    description: "Suggested next actions."
  },
  metadata: {
    type: "object",
    additionalProperties: true,
    description: "Client-specific metadata retained by callers. It is not rendered in Feishu cards."
  }
};

const commandStateValues = ["pending", "in_progress", "done", "failed"] as const;

export function createToolRegistry(options: {
  configPath?: string;
  feishuClient?: FeishuClient;
} = {}): ToolRegistry {
  const configPath = options.configPath ?? CONFIG_PATH;
  const feishuClient = options.feishuClient ?? new FeishuClient();

  const definitions: ToolDefinition[] = [
    {
      name: "feishu_notify",
      description: "Send a generic Feishu notification card from any local agent or automation.",
      inputSchema: {
        type: "object",
        properties: notifyProperties,
        required: ["summary"],
        additionalProperties: false
      }
    },
    {
      name: "feishu_notify_task_result",
      description: "Send a structured task-result card to Feishu.",
      inputSchema: {
        type: "object",
        properties: {
          ...notifyProperties,
          status: {
            type: "string",
            enum: ["success", "failed", "needs_action"],
            description: "Task result status."
          }
        },
        required: ["status", "summary"],
        additionalProperties: false
      }
    },
    {
      name: "feishu_send_test",
      description: "Send a short test notification to validate Feishu app and receiver configuration.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string" },
          title: { type: "string" },
          message: { type: "string" }
        },
        additionalProperties: false
      }
    },
    {
      name: "feishu_status",
      description: "Show local bridge configuration readiness without exposing secrets.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: "feishu_set_enabled",
      description: "Enable or disable outbound Feishu notifications in local bridge config.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "Whether outbound notifications should be sent."
          }
        },
        required: ["enabled"],
        additionalProperties: false
      }
    },
    {
      name: "feishu_command_status",
      description: "Show Feishu inbound command queue and listener status.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: "feishu_start_command_listener",
      description: "Show how to start the standalone Feishu runtime listener.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: "feishu_stop_command_listener",
      description: "Explain how to stop the standalone Feishu runtime listener.",
      inputSchema: {
        type: "object",
        properties: {
          force: {
            type: "boolean",
            description: "Force-close the underlying websocket."
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "feishu_next_command",
      description: "Return the next pending Feishu command for the Agent, optionally claiming it.",
      inputSchema: {
        type: "object",
        properties: {
          claim: {
            type: "boolean",
            description: "Mark the command as in_progress before returning it. Defaults to true."
          },
          sessionId: {
            type: "string",
            description: "Only return commands for this Codex session."
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "feishu_ack_command",
      description: "Mark a Feishu command as done or failed after the Agent handles it.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: {
            type: "string",
            enum: ["done", "failed"]
          },
          summary: {
            type: "string",
            description: "Optional completion summary to keep in the local queue."
          }
        },
        required: ["id", "status"],
        additionalProperties: false
      }
    },
    {
      name: "feishu_list_commands",
      description: "List recent Feishu commands in the local queue.",
      inputSchema: {
        type: "object",
        properties: {
          state: {
            type: "string",
            enum: commandStateValues
          },
          limit: {
            type: "number",
            description: "Maximum commands to return."
          },
          sessionId: {
            type: "string",
            description: "Only list commands for this Codex session."
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "feishu_set_inbound_enabled",
      description: "Enable or disable the Feishu inbound command listener in local bridge config.",
      inputSchema: {
        type: "object",
        properties: {
          enabled: {
            type: "boolean",
            description: "Whether Feishu inbound command collection should be enabled."
          }
        },
        required: ["enabled"],
        additionalProperties: false
      }
    }
  ];

  const handlers = new Map<string, ToolHandler>([
    ["feishu_notify", (args) => sendNotify(args, { defaultStatus: "info", configPath, feishuClient })],
    [
      "feishu_notify_task_result",
      (args) => sendNotify(args, { requireTaskStatus: true, configPath, feishuClient })
    ],
    ["feishu_send_test", (args) => sendTest(args, configPath, feishuClient)],
    ["feishu_status", () => showStatus(configPath, feishuClient)],
    ["feishu_set_enabled", (args) => setEnabled(args, configPath)],
    ["feishu_command_status", () => showCommandStatus(configPath)],
    ["feishu_start_command_listener", () => runtimeGuide(configPath, "start")],
    ["feishu_stop_command_listener", () => runtimeGuide(configPath, "stop")],
    ["feishu_next_command", (args) => nextCommand(args, configPath)],
    ["feishu_ack_command", (args) => acknowledgeCommand(args, configPath)],
    ["feishu_list_commands", (args) => listQueuedCommands(args, configPath)],
    ["feishu_set_inbound_enabled", (args) => setInboundEnabled(args, configPath)]
  ]);

  return {
    listTools: () => definitions,
    callTool: async (name: string, args: unknown): Promise<ToolResult> => {
      const handler = handlers.get(name);
      if (!handler) {
        return errorResult(`Unknown tool: ${name}`);
      }
      try {
        return await handler(args);
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  };
}

async function sendNotify(
  args: unknown,
  options: {
    defaultStatus?: NotifyStatus;
    requireTaskStatus?: boolean;
    configPath: string;
    feishuClient: FeishuClient;
  }
): Promise<ToolResult> {
  const input = parseNotifyInput(args, options);
  const config = await loadConfig(options.configPath);

  if (!config.enabled) {
    return textResult(`skipped: Feishu notifications are disabled in ${options.configPath}`);
  }

  const card = buildNotificationCard(input, config, { useConfiguredCodexSession: false });
  const sendResult = await options.feishuClient.sendInteractiveMessage(config, card);
  return textResult(`sent: Feishu notification delivered${sendResult.messageId ? ` message_id=${sendResult.messageId}` : ""}`);
}

async function sendTest(args: unknown, configPath: string, feishuClient: FeishuClient): Promise<ToolResult> {
  const value = ensureObject(args, "feishu_send_test arguments");
  const message = optionalString(value.message, "message") || "feishu-agent-bridge test message";
  const title = optionalString(value.title, "title") || "Feishu Agent Bridge test";
  const source = optionalString(value.source, "source") || "feishu-agent-bridge";
  return sendNotify(
    {
      source,
      title,
      status: "info",
      summary: message
    },
    { defaultStatus: "info", configPath, feishuClient }
  );
}

async function showStatus(configPath: string, feishuClient: FeishuClient): Promise<ToolResult> {
  const config = await loadConfig(configPath);
  return textResult(
    JSON.stringify(
      {
        configPath,
        readiness: getConfigReadiness(config),
        config: sanitizeConfig(config),
        tokenCached: feishuClient.hasCachedToken()
      },
      null,
      2
    )
  );
}

async function setEnabled(args: unknown, configPath: string): Promise<ToolResult> {
  const value = ensureObject(args, "feishu_set_enabled arguments");
  if (typeof value.enabled !== "boolean") {
    throw new ConfigError("enabled must be a boolean");
  }
  const config = await saveConfigPatch({ enabled: value.enabled }, configPath);
  return textResult(`updated: enabled=${config.enabled}`);
}

async function showCommandStatus(configPath: string): Promise<ToolResult> {
  const config = await loadConfig(configPath);
  const queuePath = resolveCommandQueuePath(config);
  await initializeCommandQueue(queuePath, { legacyJsonPath: resolveLegacyCommandQueuePath(config) });
  const runtimeStatus = await readStandaloneListenerRuntimeStatus(configPath);

  return jsonResult({
    configPath,
    readiness: getConfigReadiness(config),
    inbound: sanitizeConfig(config).inbound,
    listener: runtimeStatus ?? {
          running: false,
          ready: false,
          managedBy: "none",
          configPath,
          queuePath,
          enqueuedCount: 0,
          ignoredCount: 0
        },
    queue: await getCommandQueueStats(queuePath)
  });
}

async function runtimeGuide(
  configPath: string,
  action: "start" | "stop"
): Promise<ToolResult> {
  const runtime = await readStandaloneListenerRuntimeStatus(configPath);
  return jsonResult({
    managedBy: "runtime",
    action,
    runtime: runtime ?? null,
    command: "node dist/src/runtime.js",
    screenCommand: "screen -dmS fab-runtime zsh -lc 'node dist/src/runtime.js >> ~/.feishu-agent-bridge/runtime.log 2>&1'",
    message: action === "start"
      ? "Start the standalone runtime outside the MCP server process. MCP-hosted listeners are deprecated."
      : "Stop the standalone runtime from the process manager that started it, for example: screen -S fab-runtime -X quit."
  });
}

async function nextCommand(args: unknown, configPath: string): Promise<ToolResult> {
  const value = ensureObject(args, "feishu_next_command arguments");
  const claim = optionalBoolean(value.claim, "claim") ?? true;
  const sessionId = optionalString(value.sessionId, "sessionId");
  const config = await loadConfig(configPath);
  const queuePath = resolveCommandQueuePath(config);
  await initializeCommandQueue(queuePath, { legacyJsonPath: resolveLegacyCommandQueuePath(config) });
  const command = await getNextCommand(queuePath, { claim, sessionId });
  return jsonResult({
    queuePath,
    claimed: Boolean(command && claim),
    command: command ?? null
  });
}

async function acknowledgeCommand(args: unknown, configPath: string): Promise<ToolResult> {
  const value = ensureObject(args, "feishu_ack_command arguments");
  const id = requiredString(value.id, "id");
  const status = parseDoneOrFailed(value.status);
  const summary = optionalString(value.summary, "summary");
  const config = await loadConfig(configPath);
  const queuePath = resolveCommandQueuePath(config);
  await initializeCommandQueue(queuePath, { legacyJsonPath: resolveLegacyCommandQueuePath(config) });
  const command = await ackCommand(id, status, queuePath, summary);
  if (!command) {
    throw new ConfigError(`Command not found: ${id}`);
  }
  return jsonResult({
    queuePath,
    command
  });
}

async function listQueuedCommands(args: unknown, configPath: string): Promise<ToolResult> {
  const value = ensureObject(args, "feishu_list_commands arguments");
  const state = optionalCommandState(value.state, "state");
  const limit = optionalPositiveInteger(value.limit, "limit");
  const sessionId = optionalString(value.sessionId, "sessionId");
  const config = await loadConfig(configPath);
  const queuePath = resolveCommandQueuePath(config);
  await initializeCommandQueue(queuePath, { legacyJsonPath: resolveLegacyCommandQueuePath(config) });
  const commands = await listCommands(queuePath, { state, limit, sessionId });
  return jsonResult({
    queuePath,
    commands
  });
}

async function setInboundEnabled(args: unknown, configPath: string): Promise<ToolResult> {
  const value = ensureObject(args, "feishu_set_inbound_enabled arguments");
  if (typeof value.enabled !== "boolean") {
    throw new ConfigError("enabled must be a boolean");
  }
  const config = await saveConfigPatch({ inbound: { enabled: value.enabled } }, configPath);
  return textResult(`updated: inbound.enabled=${config.inbound.enabled}`);
}

function parseNotifyInput(
  args: unknown,
  options: { defaultStatus?: NotifyStatus; requireTaskStatus?: boolean }
): NotifyInput {
  const value = ensureObject(args, "notification arguments");
  const summary = requiredString(value.summary, "summary");
  const status = optionalString(value.status, "status") || options.defaultStatus;

  if (options.requireTaskStatus && !["success", "failed", "needs_action"].includes(String(status))) {
    throw new ConfigError("status must be one of: success, failed, needs_action");
  }

  return {
    source: optionalString(value.source, "source"),
    title: optionalString(value.title, "title"),
    status,
    summary,
    cwd: optionalString(value.cwd, "cwd"),
    projectLabel: optionalString(value.projectLabel, "projectLabel"),
    codexSessionId: optionalString(value.codexSessionId, "codexSessionId"),
    codexSessionTitle: optionalString(value.codexSessionTitle, "codexSessionTitle"),
    codexSessionLabel: optionalString(value.codexSessionLabel, "codexSessionLabel"),
    artifacts: optionalStringArray(value.artifacts, "artifacts"),
    links: parseLinks(value.links),
    nextSteps: optionalStringArray(value.nextSteps, "nextSteps"),
    metadata: parseMetadata(value.metadata)
  };
}

function parseLinks(value: unknown): NotifyInput["links"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ConfigError("links must be an array");
  }
  return value.map((item, index) => {
    const object = ensureObject(item, `links[${index}]`);
    return {
      label: optionalString(object.label, `links[${index}].label`),
      url: requiredString(object.url, `links[${index}].url`)
    };
  });
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return ensureObject(value, "metadata");
}

function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(`${label} must be a string`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigError(`${label} must be an array of strings`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ConfigError(`${label} must be a boolean`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${label} must be a positive integer`);
  }
  return value;
}

function optionalCommandState(value: unknown, label: string): AgentCommandState | undefined {
  if (value === undefined) return undefined;
  if (!commandStateValues.includes(value as AgentCommandState)) {
    throw new ConfigError(`${label} must be one of: ${commandStateValues.join(", ")}`);
  }
  return value as AgentCommandState;
}

function parseDoneOrFailed(value: unknown): Extract<AgentCommandState, "done" | "failed"> {
  if (value === "done" || value === "failed") {
    return value;
  }
  throw new ConfigError("status must be one of: done, failed");
}

function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function textResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }]
  };
}

function errorResult(text: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text }]
  };
}

function formatError(error: unknown): string {
  if (error instanceof ConfigError || error instanceof FeishuApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
