---
name: feishu-agent-bridge
description: Operate Feishu Agent Bridge as a Codex plugin. Use when configuring the plugin, sending Agent results to Feishu, starting/stopping the Feishu listener, handling Feishu group commands, or continuing Codex CLI sessions from Feishu.
---

# Feishu Agent Bridge

## What It Provides

- MCP tools for Feishu task-result cards and test messages.
- A Feishu long-connection listener for group @ commands.
- A local durable command queue under `~/.feishu-agent-bridge`.
- Optional Codex CLI worker support for `codex exec resume`.

## Important Paths

- Config: `~/.feishu-agent-bridge/config.json`
- Queue: `~/.feishu-agent-bridge/commands.json`
- Listener log: `~/.feishu-agent-bridge/listener.log`
- Default Codex state DB: `~/.codex/state_5.sqlite`

## Setup

From the plugin checkout:

```bash
corepack pnpm install
corepack pnpm build
node scripts/install-codex-plugin.mjs
```

Restart Codex or refresh plugins after installation. If MCP tools are missing after the plugin is enabled, first check whether `dist/src/index.js` exists and whether Codex has refreshed the plugin registry.

## Feishu Config

Create `~/.feishu-agent-bridge/config.json` with `appId`, `appSecret`, `receiveIdType`, `receiveId`, and `enabled`. Keep credentials out of the repository.

For inbound commands, prefer:

```json
{
  "inbound": {
    "enabled": true,
    "mode": "long_connection",
    "requireMention": true,
    "botOpenId": "ou_xxx",
    "allowedChatIds": ["oc_xxx"],
    "acknowledgeOnReceive": true,
    "pollingEnabled": false,
    "pollIntervalSeconds": 600
  }
}
```

Keep `allowedChatIds` narrow. Keep polling disabled by default; enable it only as a temporary diagnostic fallback when long connection delivery is broken.

## Codex Session Commands

These commands are handled by the listener and must not be sent into the ordinary Agent task queue:

- `list-session`
- `list-session <index>`
- `list-session <sessionId>`
- `switch-session <index>`
- `switch-session <sessionId>`
- `current-session`

Normal natural-language commands should enter the queue and can be consumed by the Agent or Codex CLI worker.

## Validation

Run:

```bash
corepack pnpm test
corepack pnpm smoke
node scripts/install-codex-plugin.mjs --dry-run
```

For real Feishu verification, call `feishu_send_test`, then start the listener with `feishu_start_command_listener` or `corepack pnpm listen`.
