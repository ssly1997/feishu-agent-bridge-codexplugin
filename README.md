# feishu-agent-bridge

`feishu-agent-bridge` 是一个本地 MCP 服务，用来让本地 Agent、自动化工具或脚本把任务结果发送到飞书。

它不是 Codex 专用工具。Codex、Claude Desktop、Cursor、OpenCode、CI 脚本，或任何支持 MCP 的客户端，都可以通过同一套工具接入。

## 功能

- 通过飞书自建应用机器人发送交互卡片通知。
- 通过飞书长连接事件接收群聊里 @机器人的下一步指令。
- 通过 stdio 暴露一组通用 MCP tools。
- 使用本地 durable queue 保存飞书指令，Agent 可以通过 MCP 取指令、认领、确认完成。
- 可选启动 Codex CLI worker，把飞书队列里的指令交给 `codex exec resume` 继续执行。
- 飞书凭证保存在 `~/.feishu-agent-bridge/config.json`，不会放进项目仓库。
- 内存缓存 `tenant_access_token`，并避免在输出中暴露 `appSecret` 或 token。

## 环境要求

- Node.js 20.11 或更新版本
- pnpm
- Codex CLI，可选，仅在启用 Codex CLI worker 时需要
- 一个已开启机器人能力的飞书自建应用
- 一个机器人可发送消息的目标群聊或用户

## 安装与构建

```bash
git clone https://git.corp.kuaishou.com/live-client/feishu-agent-bridge-codexplugin.git
cd feishu-agent-bridge-codexplugin
corepack pnpm install
corepack pnpm build
```

## Codex 插件安装

仓库根目录已经包含 Codex 插件结构：

- `.codex-plugin/plugin.json`：插件展示信息、Skill 和 MCP 入口声明。
- `.mcp.json`：把 `feishu-agent-bridge` MCP server 暴露给 Codex。
- `skills/feishu-agent-bridge/SKILL.md`：让 Codex 在其它会话里知道如何操作和排查这个桥接服务。
- `scripts/codex-plugin-mcp.mjs`：插件模式下的 MCP 启动 wrapper；如果忘记 `pnpm build`，会直接在 stderr 提示修复命令。

本机安装到 Codex 插件市场：

```bash
cd feishu-agent-bridge-codexplugin
corepack pnpm install
corepack pnpm build
corepack pnpm codex:plugin:install
```

安装脚本会把当前仓库软链到 `~/plugins/feishu-agent-bridge`，更新 `~/.agents/plugins/marketplace.json`，并在 `~/.codex/config.toml` 中注册本地 marketplace 与启用 `feishu-agent-bridge@local`。完成后重启 Codex，或在 Codex 里刷新插件列表。

如果你之前已经在 `~/.codex/config.toml` 里手动配置过同名 `[mcp_servers.feishu-agent-bridge]`，启用插件前建议只保留一种接入方式，避免同一个 MCP server 被重复注册。

如果只想确认会写入什么，不修改本机配置：

```bash
corepack pnpm codex:plugin:dry-run
```

插件化只负责把 MCP server 和 Skill 分发给 Codex；真实飞书凭证仍然只放在 `~/.feishu-agent-bridge/config.json`，不会进入插件包。

创建本机私有配置：

```bash
mkdir -p ~/.feishu-agent-bridge
cat > ~/.feishu-agent-bridge/config.json <<'JSON'
{
  "appId": "cli_xxxxxxxxxxxxxxxx",
  "appSecret": "your-app-secret",
  "receiveIdType": "chat_id",
  "receiveId": "oc_xxxxxxxxxxxxxxxx",
  "enabled": true,
  "defaultTitle": "Agent notification",
  "messageStyle": "card",
  "inbound": {
    "enabled": true,
    "mode": "long_connection",
    "queuePath": "/Users/yourname/.feishu-agent-bridge/commands.json",
    "requireMention": true,
    "botOpenId": "ou_xxxxxxxxxxxxxxxx",
    "allowedChatIds": ["oc_xxxxxxxxxxxxxxxx"],
    "acknowledgeOnReceive": true,
    "acknowledgementText": "收到，已加入 Agent 队列。",
    "pollingEnabled": false,
    "pollIntervalSeconds": 600
  },
  "codex": {
    "enabled": false,
    "command": "codex",
    "sessionId": "019e249d-96bd-75d3-b604-16a0198a4649",
    "useLast": false,
    "cwd": "/path/to/your/project",
    "stateDbPath": "/Users/yourname/.codex/state_5.sqlite",
    "sandbox": "workspace-write",
    "approvalPolicy": "never",
    "extraArgs": ["--skip-git-repo-check"],
    "timeoutMs": 1800000,
    "pollIntervalSeconds": 5,
    "sessionListLimit": 10,
    "outputDir": "/Users/yourname/.feishu-agent-bridge/codex-output",
    "outputMaxBytes": 12000,
    "notifyResult": true
  }
}
JSON
```

`receiveIdType` 支持 `chat_id`、`open_id` 和 `email`。如果要发到群聊，需要先把应用机器人添加到目标群，然后使用该群的 `chat_id`。

`inbound.botOpenId` 和 `inbound.allowedChatIds` 都是可选项，但建议至少配置 `allowedChatIds`，避免其它群里的 @ 消息进入本地 Agent 队列。

`pollingEnabled` 默认建议保持 `false`。它只是排查长连接事件不通时的临时兜底：开启后 listener 会按 `pollIntervalSeconds` 拉取目标 `chat_id` 的最近消息。由于飞书消息列表接口可能返回最近历史消息，轮询兜底可能重新处理 `current-session`、`list-session` 这类控制消息，所以长连接已经可用时不要开启。

`codex.sessionId` 是要继续的 Codex 会话 id。建议优先显式配置 session id；只有临时验证时才使用 `"useLast": true`。Codex CLI worker 继续的是同一份持久化会话历史，不保证实时注入当前打开的 Codex Desktop 窗口。

如果还没有选定会话，可以先在飞书群里发送 `@机器人 list-session`。这是 listener 直接处理的控制命令，不会进入 Agent 任务队列；listener 会从 `codex.stateDbPath` 读取可用 Codex 会话，并返回带“介入”按钮的互动卡片。`@机器人 current-session`、`@机器人 list-session <序号>` 和 `@机器人 switch-session <序号>` 也是 listener 直处理命令，不应该回复“已加入 Agent 队列”。

“介入”按钮依赖飞书把互动卡片按钮事件推给本地长连接 listener。开放平台除了订阅 `im.message.receive_v1`，还需要在「回调配置」里单独订阅卡片交互回调事件 `card.action.trigger` 并发布生效。注意「事件配置」和「回调配置」是两套配置：消息事件通了，不代表卡片按钮回调已经通。如果点击按钮提示 `code: 200340`，且本地 `listener.log` 里没有 `[card]` 日志，通常说明按钮回调没有送到本地进程；可以先用 `@机器人 list-session 1` 这样的文本命令兜底介入。

## 长连接事件没有推送时的排查路径

如果日志里只有 `ws client ready`，但飞书群里 @机器人 后队列里的 `eventId` 是 `poll:om_...`，说明当前消息是轮询兜底收到的，不是真正的长连接事件。

本地侧先确认：

```bash
tail -200 ~/.feishu-agent-bridge/listener.log
cat ~/.feishu-agent-bridge/commands.json
```

判断标准：

- 真正长连接推送：日志里会出现 SDK 的 `[ws] receive message...` 或本项目的 `[inbound] received message`，且 `eventId` 不是 `poll:` 前缀。
- 轮询兜底：日志里有 `[poll] started message polling fallback`，队列里的 `eventId` 是 `poll:<message_id>`。

如果 API 能拉到群消息、但长连接没推事件，优先去飞书开放平台检查：

- 应用必须是自建应用，并且机器人能力已开启。
- 「事件与回调」->「事件配置」里的订阅方式要选择「使用长连接接收事件」。
- 在 listener 正在运行且日志出现 `ws client ready` 后，回到飞书后台点击验证并保存订阅方式。
- 添加事件时选择「消息与群组」里的「接收消息 v2.0」，事件类型是 `im.message.receive_v1`。
- 确认权限包含「获取用户在群组中@机器人的消息」或等价历史权限，并完成发布/生效。

`ws client ready` 只代表本地 websocket 连上了飞书网关，不等于应用后台已经把 `im.message.receive_v1` 配置成会推给这条连接。

如果文本消息事件正常，但点击卡片按钮报 `code: 200340`，按下面路径单独检查卡片回调：

- 「事件与回调」->「回调配置」里的订阅方式要选择「使用长连接接收回调」。
- 在 listener 正在运行且日志出现 `ws client ready` 后，点击验证并保存回调订阅方式。
- 点击「添加回调」，选择「卡片」里的「卡片回传交互」，回调类型是 `card.action.trigger`。
- 保存后必须「创建版本」并发布。页面顶部如果显示“版本发布后，当前修改方可生效”，说明当前回调配置还没有在线生效。
- 成功后点击卡片按钮，本地日志应该出现 `execute card.action.trigger handle` 和 `[card] handled session selection action`。

飞书开发者后台的日志也能辅助判断：如果只有 `im.message.receive_v1` 成功记录，没有 `card.action.trigger` 记录，问题通常还在平台侧回调配置或发布状态。

## MCP Tools

- `feishu_notify`：发送通用飞书通知卡片。
- `feishu_notify_task_result`：发送任务结果卡片，支持 `success`、`failed`、`needs_action`。
- `feishu_send_test`：发送一条短测试消息，用于验证飞书配置。
- `feishu_status`：查看本地配置就绪状态，敏感信息会被脱敏。
- `feishu_set_enabled`：启用或关闭出站通知。
- `feishu_command_status`：查看飞书入站指令队列和长连接 listener 状态。
- `feishu_start_command_listener`：在当前 MCP server 进程内启动飞书长连接 listener。
- `feishu_stop_command_listener`：停止当前 MCP server 进程内的 listener。
- `feishu_next_command`：取下一条 pending 飞书指令，默认会认领为 `in_progress`。
- `feishu_ack_command`：Agent 执行完成后把指令标记为 `done` 或 `failed`。
- `feishu_list_commands`：查看本地队列中的指令。
- `feishu_set_inbound_enabled`：启用或关闭飞书入站指令采集。

通用通知字段示例：

```json
{
  "source": "codex",
  "title": "Build finished",
  "status": "success",
  "summary": "All checks passed.",
  "cwd": "/path/to/project",
  "artifacts": ["/path/to/report.txt"],
  "links": [{ "label": "Run", "url": "https://example.com/run/1" }],
  "nextSteps": ["Review the output"],
  "metadata": { "duration": "42s" }
}
```

`source` 是自由字符串，可以填写 `codex`、`claude-desktop`、`cursor`、`opencode`、`ci`，也可以填写任意本地 Agent 或自动化来源名称。

通知卡片使用飞书 Card 2.0：顶部用紧凑四行展示 `Status`、`Source`、`Project` 和 `Codex session`，正文、链接、步骤和工作目录使用 V2 `markdown` 组件。`metadata` 只保留在调用入参里用于本地/客户端扩展，不默认展示给飞书用户。

`Project` 优先从入参 `cwd` 推导，否则使用 `codex.cwd`；`Codex session` 优先展示 `codex.sessionTitle` 并附带短 id，例如 `会话标题 (#019e249d)`，没有标题时只展示短 id。没有显式绑定时会展示 `useLast` 或 `(unbound)`。因此 Agent 转发到飞书的结果消息应该总能看出归属项目和会话状态，但不会暴露整段 UUID。

## 飞书 -> Agent 指令链路

飞书开放平台侧需要完成这些设置：

- 开启应用的机器人能力，并把机器人加入目标群。
- 订阅 `im.message.receive_v1`，也就是“接收消息 v2.0”事件。
- 在「回调配置」中订阅互动卡片按钮回调事件 `card.action.trigger`，否则 `list-session` 返回的“介入”按钮无法触发本地选会话。
- 给应用开通群聊 @ 消息权限。通常是“获取用户在群组中@机器人的消息”；如果开了群内全量消息权限，建议在本地配置 `botOpenId` 和 `allowedChatIds` 做二次过滤。
- 「事件配置」和「回调配置」都使用长连接模式，本地机器不需要暴露公网 webhook。
- 每次修改开放平台配置后都要创建并发布新版本，确认页面不再提示“版本发布后，当前修改方可生效”。

本地启动长连接 listener：

```bash
cd feishu-agent-bridge-codexplugin
pnpm listen
```

也可以在 MCP client 里调用 `feishu_start_command_listener`，让 listener 跟 MCP server 进程一起跑。

Agent 侧循环可以按这个顺序推进：

```text
1. 用户在飞书群里 @机器人：继续执行下一步
2. listener 收到 `im.message.receive_v1`，把文本写入本地 commands queue
3. Agent 调用 `feishu_next_command` 获取并认领指令
4. Agent 执行用户的新指令
5. Agent 调用 `feishu_ack_command` 标记 done/failed
6. Agent 调用 `feishu_notify_task_result` 把执行结果发回飞书
```

如果要让 Codex CLI 在无人操作时消费普通任务队列，可以启动本项目内置 worker。

## Codex CLI worker

先确认本机 Codex CLI 支持 resume：

```bash
codex exec resume --help
```

配置 `~/.feishu-agent-bridge/config.json` 里的 `codex`：

```json
{
  "codex": {
    "enabled": true,
    "command": "codex",
    "sessionId": "019e249d-96bd-75d3-b604-16a0198a4649",
    "useLast": false,
    "cwd": "/path/to/your/project",
    "stateDbPath": "/Users/yourname/.codex/state_5.sqlite",
    "sandbox": "workspace-write",
    "approvalPolicy": "never",
    "timeoutMs": 1800000,
    "pollIntervalSeconds": 5,
    "sessionListLimit": 10,
    "notifyResult": true
  }
}
```

处理一条 pending 指令后退出：

```bash
cd feishu-agent-bridge-codexplugin
pnpm codex:once
```

持续轮询本地 queue：

```bash
cd feishu-agent-bridge-codexplugin
pnpm codex:worker
```

worker 的执行顺序：

```text
1. 从 commands queue 认领下一条 pending 指令
2. 通过 stdin 调用 `codex exec resume <sessionId> -`
3. 用 `-o` 保存 Codex 最后一条回复到 `codex.outputDir`
4. 根据 Codex CLI exit code 把指令标记为 done 或 failed
5. 如果 `enabled=true` 且 `codex.notifyResult=true`，发送任务结果卡片到飞书
```

会话选择命令由 listener 直接处理，不需要 Codex CLI worker：

```text
@机器人 list-session
@机器人 current-session
```

`list-session` 返回最近可用会话列表，每个会话都有“介入”按钮；`current-session` 返回当前已绑定的 Codex 会话。点击按钮后，listener 会处理 `card.action.trigger` 回调并完成会话选择。

选择后，listener 会把 `codex.sessionId`、`codex.sessionTitle`、`codex.cwd` 和 `codex.enabled=true` 写回 `~/.feishu-agent-bridge/config.json`。后续普通指令才会进入 queue，并由 Codex CLI worker 继续这个 Codex 会话。

如果按钮回调没有生效，通常是飞书开放平台尚未放通或发布卡片回调事件。临时备用命令仍然可用：

```text
@机器人 list-session <序号>
@机器人 list-session <sessionId>
@机器人 switch-session <序号>
@机器人 switch-session <sessionId>
```

## 通用 MCP 客户端配置

使用 stdio，把 MCP client 指向构建后的入口文件：

```json
{
  "mcpServers": {
    "feishu-agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/feishu-agent-bridge-codexplugin/dist/src/index.js"]
    }
  }
}
```

Codex 接入示例：

```toml
[mcp_servers.feishu-agent-bridge]
command = "node"
args = ["/absolute/path/to/feishu-agent-bridge-codexplugin/dist/src/index.js"]
enabled = true
```

## 验证

```bash
pnpm test
pnpm smoke
```

如果要验证真实飞书链路，先配置 `~/.feishu-agent-bridge/config.json` 并设置 `"enabled": true`，然后在任意 MCP client 中连接该服务，调用 `feishu_send_test`。

入站链路验证：

```bash
pnpm listen
```

在飞书目标群里 `@机器人 继续执行测试`，然后通过 MCP 调用：

```json
{
  "name": "feishu_next_command",
  "arguments": {}
}
```

看到 `command.text` 返回 `继续执行测试` 后，调用 `feishu_ack_command` 标记处理结果。

## 注意事项

- 飞书 IM API 要求消息 `content` 字段是 JSON 字符串，本项目会按这个格式发送。
- 当 `enabled: false` 时，通知工具会返回 `skipped`，不会请求飞书 API。
- 当 `inbound.enabled: false` 时，长连接 listener 不会启动；已经进入本地队列的指令仍可通过 MCP 查询。
- `commands.json` 是本机状态文件，不要提交到仓库。
