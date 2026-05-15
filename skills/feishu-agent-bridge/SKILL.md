---
name: feishu-agent-bridge
description: Operate Feishu Agent Bridge as a Codex plugin. Use when configuring the plugin, sending Agent results to Feishu, starting/stopping the Feishu listener, handling Feishu group commands, or continuing Codex CLI sessions from Feishu.
---

# Feishu Agent Bridge

## What It Provides

- MCP tools for Feishu task-result cards and test messages.
- A standalone `fab-runtime` for Feishu long-connection group @ commands.
- A local SQLite durable command queue under `~/.feishu-agent-bridge`.
- Session-partitioned Codex CLI execution through `codex exec resume`.

## Important Paths

- Config: `~/.feishu-agent-bridge/config.json`
- Queue DB: `~/.feishu-agent-bridge/commands.db`
- Legacy JSON import source: `~/.feishu-agent-bridge/commands.json`
- Runtime log: `~/.feishu-agent-bridge/runtime.log`
- Default Codex state DB: `~/.codex/state_5.sqlite`

## Setup

From the plugin checkout:

```bash
corepack pnpm install
corepack pnpm build
node scripts/install-codex-plugin.mjs
```

The installer refreshes the local Codex plugin cache. If `~/.feishu-agent-bridge/config.json` exists with `inbound.enabled=true`, it also migrates old `fab-listener` / `fab-codex-worker` processes and starts the standalone `fab-runtime`. The plugin MCP wrapper also runs the same idempotent runtime check when Codex starts the plugin. Restart Codex or refresh plugins after installation. If MCP tools are missing after the plugin is enabled, first check whether `dist/src/index.js` exists and whether Codex has refreshed the plugin registry.

## Feishu Config

Create `~/.feishu-agent-bridge/config.json` with `appId`, `appSecret`, `receiveIdType`, `receiveId`, and `enabled`. Keep credentials out of the repository.

For inbound commands, prefer:

```json
{
  "inbound": {
    "enabled": true,
    "mode": "long_connection",
    "queueDbPath": "/Users/you/.feishu-agent-bridge/commands.db",
    "requireMention": true,
    "botOpenId": "ou_xxx",
    "allowedChatIds": ["oc_xxx"],
    "acknowledgeOnReceive": true
  }
}
```

Keep `allowedChatIds` narrow. There is no Feishu message polling fallback; if long connection delivery is broken, fix the Feishu Developer Console event/callback configuration.

## Codex Session Commands

These commands are handled by the listener and must not be sent into the ordinary Agent task queue:

- `list-session`
- `list-session <index>`
- `list-session <sessionId>`
- `switch-session <index>`
- `switch-session <sessionId>`
- `current-session`

Normal natural-language commands enter the SQLite queue only after a Codex session is selected. The command records the selected session at enqueue time, so different sessions can run concurrently while each individual session stays serial.

## Validation

Run:

```bash
corepack pnpm test
corepack pnpm smoke
node scripts/install-codex-plugin.mjs --dry-run
```

For real Feishu verification, call `feishu_send_test`, then check the runtime with:

```bash
corepack pnpm runtime:status
```

`feishu_start_command_listener` and `feishu_stop_command_listener` now return standalone runtime guidance; they do not host a listener inside the MCP process.
