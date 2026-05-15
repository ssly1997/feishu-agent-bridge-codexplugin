# feishu-agent-bridge

`feishu-agent-bridge` 是一个本地 MCP 服务，用来让本地 Agent、自动化工具或脚本把任务结果发送到飞书。

它不是 Codex 专用工具。Codex、Claude Desktop、Cursor、OpenCode、CI 脚本，或任何支持 MCP 的客户端，都可以通过同一套工具接入。

## 功能

- 通过飞书自建应用机器人发送交互卡片通知。
- 通过飞书长连接事件接收群聊里 @机器人的下一步指令。
- 通过 stdio 暴露一组通用 MCP tools。
- 使用本地 SQLite durable queue 保存飞书指令，按 Codex session 分区调度。
- 可选启动独立 `fab-runtime`，把飞书长连接、入队、session 调度和 `codex exec resume` 串成一条常驻链路。
- 飞书凭证保存在 `~/.feishu-agent-bridge/config.json`，不会放进项目仓库。
- 内存缓存 `tenant_access_token`，并避免在输出中暴露 `appSecret` 或 token。

## 环境要求

- Node.js 20.11 或更新版本
- pnpm
- Codex CLI，可选，仅在启用 `fab-runtime` 自动执行飞书指令时需要
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

安装脚本会把当前仓库软链到 `~/plugins/feishu-agent-bridge`，更新 `~/.agents/plugins/marketplace.json`，并在 `~/.codex/config.toml` 中注册本地 marketplace 与启用 `feishu-agent-bridge@local`。如果 `~/.feishu-agent-bridge/config.json` 已存在且 `inbound.enabled=true`，安装脚本会自动清理旧 `fab-listener` / `fab-codex-worker` 并拉起单进程 `fab-runtime`。完成后重启 Codex，或在 Codex 里刷新插件列表。

如果你之前已经在 `~/.codex/config.toml` 里手动配置过同名 `[mcp_servers.feishu-agent-bridge]`，启用插件前建议只保留一种接入方式，避免同一个 MCP server 被重复注册。

如果只想确认会写入什么，不修改本机配置：

```bash
corepack pnpm codex:plugin:dry-run
```

插件包只分发 MCP server、Skill 和本地 runtime 代码；真实飞书凭证仍然只放在 `~/.feishu-agent-bridge/config.json`，不会进入插件包。只有本机配置明确打开 `inbound.enabled=true` 时，安装脚本或插件 MCP wrapper 才会自动拉起 `fab-runtime`。

如果用户先安装插件、后创建本机配置，Codex 下次启动这个插件 MCP server 时也会幂等检查并自动启动 `fab-runtime`。不想自动拉起 runtime 时，可用：

```bash
corepack pnpm codex:plugin:install -- --no-start-runtime
```

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
    "queueDbPath": "/Users/yourname/.feishu-agent-bridge/commands.db",
    "queuePath": "/Users/yourname/.feishu-agent-bridge/commands.json",
    "requireMention": true,
    "botOpenId": "ou_xxxxxxxxxxxxxxxx",
    "acknowledgeOnReceive": true,
    "acknowledgementText": "收到，已加入 Agent 队列。"
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
    "inProgressTimeoutMs": 3600000,
    "inProgressRecovery": "mark_failed",
    "sessionListLimit": 10,
    "outputDir": "/Users/yourname/.feishu-agent-bridge/codex-output",
    "outputMaxBytes": 12000,
    "notifyResult": true
  }
}
JSON
```

`receiveIdType` 支持 `chat_id`、`open_id` 和 `email`。如果要发到群聊，需要先把应用机器人添加到目标群，然后使用该群的 `chat_id`。

`inbound.botOpenId` 是可选项，但群聊开启 `requireMention` 时建议配置，用于精确识别 @ 机器人。历史配置里的 `inbound.allowedChatIds` 已废弃，不再作为运行时接入限制；机器人加入任意群且事件权限送达后，都可以通过 `list-project` 接入。

`inbound.queueDbPath` 是新的 SQLite 队列文件，默认是 `~/.feishu-agent-bridge/commands.db`。`inbound.queuePath` 只作为旧版 `commands.json` 迁移来源保留；runtime 首次启动会导入旧历史，但之后不再写 JSON queue。

`inbound.acknowledgeOnReceive=true` 时，普通指令入队后会优先发送一张飞书状态卡，并在任务认领、执行中公开进展、完成或失败时更新同一张卡；如果状态卡发送或更新失败，会退回文本 ACK 或现有结果卡片。

`codex.sessionId` 仍保留给本地通知展示和兼容旧配置。入站飞书任务不再依赖全局 `codex.sessionId`，而是按当前飞书群的绑定关系选择 Codex project 和 active session；普通飞书指令入队时会把群绑定里的 `projectDisplayLabel`、`sessionId`、`sessionTitle`、`cwd` 等信息固化到任务里。

每个飞书群需要单独绑定 project。可以先在群里发送 `@机器人 list-project`，这是 listener 直接处理的控制命令，不会进入 Agent 任务队列；listener 会从 `codex.stateDbPath` 读取 Codex 会话并按 `threads.cwd` 聚合成 project，返回带“绑定项目”和翻页按钮的互动卡片。绑定 project 后会自动选择该 project 最近更新的 session 作为 active session。`@机器人 help`、`@机器人 current-project`、`@机器人 current-session`、`@机器人 unbind-project`、`@机器人 unbind-session`、`@机器人 new-session`、`@机器人 list-session`、`@机器人 list-session --all 2`、`@机器人 list-session --temp 2` 和 `@机器人 switch-session <序号|sessionId>` 也是 listener 直处理命令，不应该回复“已加入 Agent 队列”。

“绑定项目 / 介入”按钮依赖飞书把互动卡片按钮事件推给本地长连接 listener。开放平台除了订阅 `im.message.receive_v1`，还需要在「回调配置」里单独订阅卡片交互回调事件 `card.action.trigger` 并发布生效。注意「事件配置」和「回调配置」是两套配置：消息事件通了，不代表卡片按钮回调已经通。如果点击按钮提示 `code: 200340`，且本地 `listener.log` 里没有 `[card]` 日志，通常说明按钮回调没有送到本地进程；可以先用 `@机器人 bind-project 1` 或 `@机器人 switch-session 1` 这样的文本命令兜底。

## 长连接事件没有推送时的排查路径

本项目不再提供飞书消息 API 轮询兜底。普通指令必须来自飞书长连接 `im.message.receive_v1`；如果事件没有推送，需要修飞书开放平台事件配置，而不是打开本地轮询。

本地侧先确认：

```bash
tail -200 ~/.feishu-agent-bridge/listener.log
sqlite3 ~/.feishu-agent-bridge/commands.db 'select id,state,session_id,text from commands order by received_at desc limit 10;'
```

判断标准：

- 真正长连接推送：日志里会出现 SDK 的 `[ws] receive message...` 或本项目的 `[inbound] received message`。
- 如果日志只有 `ws client ready` 但没有 `[inbound] received message`，本地 websocket 连上了飞书网关，但开放平台还没有把消息事件推给这条连接。

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
- `feishu_command_status`：查看飞书入站指令队列、session 分区统计和 runtime/listener 状态。
- `feishu_start_command_listener`：返回独立 `fab-runtime` 启动指引；不再在 MCP server 进程内常驻 listener。
- `feishu_stop_command_listener`：返回独立 `fab-runtime` 停止指引。
- `feishu_next_command`：调试/外部 Agent 兼容入口，取下一条 pending 飞书指令，默认会认领为 `in_progress`。
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

`Project` 优先使用入参 `projectLabel`，否则从入参 `cwd` 推导，再退回 `codex.cwd`；`Codex session` 优先展示 `codex.sessionTitle` 并附带短 id，例如 `会话标题 (#019e249d)`，没有标题时只展示短 id。没有显式绑定时会展示 `useLast` 或 `(unbound)`。因此 Agent 转发到飞书的结果消息应该总能看出归属项目和会话状态，但不会暴露整段 UUID。

## 飞书 -> Agent 指令链路

飞书开放平台侧需要完成这些设置：

- 开启应用的机器人能力，并把机器人加入目标群。
- 订阅 `im.message.receive_v1`，也就是“接收消息 v2.0”事件。
- 在「回调配置」中订阅互动卡片按钮回调事件 `card.action.trigger`，否则 `list-session` 返回的“介入”按钮无法触发本地选会话。
- 给应用开通群聊 @ 消息权限。通常是“获取用户在群组中@机器人的消息”；如果开了群内全量消息权限，本地仍会遵守 `requireMention`：群聊普通任务必须 @ 机器人，p2p 可直接触发。历史配置 `allowedChatIds` 已废弃，不再过滤群。
- 「事件配置」和「回调配置」都使用长连接模式，本地机器不需要暴露公网 webhook。
- 每次修改开放平台配置后都要创建并发布新版本，确认页面不再提示“版本发布后，当前修改方可生效”。

本地 runtime 默认会在插件安装或插件 MCP server 启动时自动 ensure。手动控制命令：

```bash
cd feishu-agent-bridge-codexplugin
pnpm runtime:status
pnpm runtime:start
pnpm runtime:restart
pnpm runtime:stop
```

如果不用安装脚本，也可以直接临时运行：

```bash
pnpm runtime
```

旧版 `fab-listener` + `fab-codex-worker` 双进程是迁移前形态。现在 `fab-runtime` 一个进程内同时负责长连接、SQLite 入队、session 调度和 Codex CLI 执行。

`fab-runtime` 自动执行顺序：

```text
1. 用户在飞书群里 `@机器人 继续执行下一步`
2. runtime 的 listener 收到 `im.message.receive_v1`
3. runtime 查询当前群绑定的 Codex project 和 active session；未绑定时直接返回 `list-project` 卡片，不入队
4. runtime 把任务写入 SQLite，并固化当前群绑定的 project / session 归属
5. runtime 发送 queued 状态卡并保存飞书 `message_id`
6. runtime 唤醒该 session 的 runner，并把状态卡更新为 in_progress
7. 同一 session 串行执行；不同 session 可以并发执行
8. runner 执行中低频更新公开进展摘要，完成后标记 done/failed 并更新同一张状态卡
```

如果当前群没有绑定 Codex project，普通飞书指令不会入队，runtime 会返回一张明确标注“当前群尚未绑定 Codex project / 这条任务暂未入队”的 project 列表卡片。请先用卡片按钮、`bind-project <序号|projectId>` 或 `switch-project <序号|projectId>` 为当前群绑定 project，绑定成功后重新发送刚才的指令。

一个群默认绑定一个 Codex project，并在该 project 内维护 active session。`list-session` 只展示当前 project 下的会话；`switch-session <序号|sessionId>` 只允许切换当前 project 内的会话，跨 project 会被拒绝并提示先 `switch-project`；`new-session [初始说明]` 会在当前 project root 下新建 Codex 会话并切为 active session。多个群仍可绑定同一个 active session；runner 会按同一个 session 串行执行，避免并发写入同一个上下文。选择一个已被其它群绑定的 session 时，listener 会提示已绑定群名，并说明这些群会共享同一 Codex 上下文。如果要解除当前群绑定，可以发送 `@机器人 unbind-session`，只会影响当前群，不会解绑其它群。

图片消息支持第一版轻量链路：群聊里不 @ 机器人的纯图片不会触发任务，只会作为“最近图片候选”缓存 5 分钟，并按同群同发送人隔离。随后同一个人在同一个群里发送 `@机器人 识别刚才那张图`，runtime 会自动下载最近图片作为附件入队；如果最近连续发送了多张图，未过期候选会一次性全部入队，而不是只取最后 1 张。如果没有文字指令但同条 @ 图片或最近候选图片可用，默认任务文本是 `请识别并分析这张图片。`。下载后的资源保存在 `~/.feishu-agent-bridge/resources/<chatId>/<messageId>/...`，任务状态卡会展示附件数量和文件名摘要。V1 不拉取历史消息，所以不要依赖“先发图、很久以后再 @”的历史检索。

## Codex Runtime

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
    "inProgressTimeoutMs": 3600000,
    "inProgressRecovery": "mark_failed",
    "sessionListLimit": 10,
    "notifyResult": true
  }
}
```

调试时仍可手动处理一条 pending 指令后退出：

```bash
cd feishu-agent-bridge-codexplugin
pnpm codex:once
```

会话选择命令由 listener 直接处理，不进入普通任务队列：

```text
@机器人 help
@机器人 list-project
@机器人 list-project 2
@机器人 current-project
@机器人 bind-project <序号|projectId>
@机器人 new-session [初始说明]
@机器人 list-session
@机器人 list-session --all 2
@机器人 list-session --temp 2
@机器人 switch-session <序号|sessionId>
@机器人 current-session
@机器人 unbind-project
@机器人 unbind-session
```

`help` 会返回帮助卡。无参命令会带快捷按钮；带必填参数的命令只展示说明，不提供按钮；带可选参数且无参也能执行的命令会保留按钮，并在说明里标明按钮执行的是默认无参版本。`list-project` 默认只返回可绑定 project，不展示临时对话，默认每页 10 个，支持 `list-project 2`，互动卡也会提供上一页 / 下一页按钮；每个 project 都有“绑定项目”按钮。project 的唯一标识来自 `realpath(threads.cwd)` 的稳定 hash，展示名优先使用 `~/.codex/.codex-global-state.json` 里的 `electron-workspace-root-labels`，并在需要时附加 git repo basename，例如 `ios-client_chatroom  ios-client`。

绑定后，listener 会把当前飞书群的 `chat_id`、可获取到的群名、project 快照和 active session 快照写入 `commands.db` 的 `chat_session_bindings` 表。后续该群的普通指令才会进入 SQLite queue，并由 `fab-runtime` 继续这个 active session；其它群需要各自绑定自己的 project。`current-project` 返回当前群绑定的 project；`current-session` 返回当前群绑定的 project 和 active session；`unbind-project` 解除当前群的 project/session 绑定，`unbind-session` 作为兼容旧命令保留。

`new-session [初始说明]` 会在当前群绑定的 project root 下启动一次新的 `codex exec`，等待 Codex 本地 state DB 落盘新 session 后，把当前群 active session 切到这个新会话。没有传初始说明时会使用一个轻量初始化 prompt；如果当前群还没绑定 project，会返回 project 选择卡，不会创建临时对话。

`list-session` 在已绑定 project 时只返回当前 project 下的 session；未绑定时返回 project 选择卡。`list-session --all` 保留全局会话查看能力；`list-session --temp` 只列临时对话；二者默认每页 10 个，支持 `list-session --all 2` / `list-session --temp 2`，互动卡也会提供上一页 / 下一页按钮。临时对话来自 Codex `projectless-thread-ids`，或 `~/Documents/Codex/...` 下没有明确 workspace label 的 session，默认不进入 project 列表。

如果按钮回调没有生效，通常是飞书开放平台尚未放通或发布卡片回调事件。临时备用命令仍然可用：

```text
@机器人 bind-project <序号>
@机器人 bind-project <projectId>
@机器人 switch-project <序号>
@机器人 switch-project <projectId>
@机器人 switch-session <序号|sessionId>
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
pnpm runtime:status
```

在任意已添加机器人的飞书群里先 `@机器人 list-project` 并绑定 project，再发送 `@机器人 继续执行测试`。然后通过 MCP 调用 `feishu_command_status`，确认对应 session 的 `pending/in_progress/done/failed` 统计变化。

`feishu_next_command` / `feishu_ack_command` 仍保留给调试和外部 Agent，但 `fab-runtime` 主路径不依赖它们。

## 注意事项

- 飞书 IM API 要求消息 `content` 字段是 JSON 字符串，本项目会按这个格式发送。
- 当 `enabled: false` 时，通知工具会返回 `skipped`，不会请求飞书 API。
- 当 `inbound.enabled: false` 时，长连接 listener 不会启动；已经进入本地队列的指令仍可通过 MCP 查询。
- `commands.db` 和旧 `commands.json` 都是本机状态文件，不要提交到仓库。
