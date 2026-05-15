# feishu-agent-bridge

`feishu-agent-bridge` 是一个本地 MCP 服务和 Codex 插件，用飞书自建应用机器人把本地 Agent、自动化脚本和 Codex CLI 串到飞书群里。

它不是 Codex 专用工具。任何支持 MCP 的客户端都可以只使用通知能力；启用 `fab-runtime` 后，飞书群里的 `@机器人` 指令可以进入本地 SQLite 队列，并由 Codex CLI 继续指定的 session。

## 当前能力

- 通过飞书自建应用机器人发送 Card 2.0 交互卡片通知。
- 通过飞书长连接接收 `im.message.receive_v1` 群聊或单聊消息事件。
- 通过飞书长连接接收 `card.action.trigger` 卡片按钮回调，用于 project/session 绑定和翻页。
- 通过 stdio 暴露 MCP tools，兼容 Codex、Claude Desktop、Cursor、OpenCode、脚本和 CI。
- 使用本地 SQLite durable queue 保存飞书指令，并按 Codex session 分区调度。
- 使用 `fab-runtime` 单进程负责长连接 listener、入队、session 调度、`codex exec resume` 和状态卡更新。
- 支持每个飞书群单独绑定 Codex project 和 active session。
- 支持 `new-session` 在当前群绑定的 project 下创建新的 Codex 会话并切为 active session。
- 支持图片轻量链路：先发图再 @ 指令，或同条消息里携带图片。
- 飞书凭证只保存在 `~/.feishu-agent-bridge/config.json`，不会进入仓库或插件包。

## 架构

```text
MCP client / Codex plugin
  |
  | stdio
  v
dist/src/index.js
  |
  | tools: feishu_notify / feishu_status / feishu_command_status ...
  v
~/.feishu-agent-bridge/config.json

fab-runtime
  |
  | Feishu long connection
  v
im.message.receive_v1 / card.action.trigger
  |
  v
~/.feishu-agent-bridge/commands.db
  |
  | session-partitioned scheduler
  v
codex exec resume <sessionId> -
  |
  v
Feishu status card update / final result
```

主要入口：

- MCP server: `dist/src/index.js`
- Codex 插件 wrapper: `scripts/codex-plugin-mcp.mjs`
- Runtime: `dist/src/runtime.js`
- Runtime 控制脚本: `scripts/runtime-control.mjs`
- 配置文件: `~/.feishu-agent-bridge/config.json`
- 队列 DB: `~/.feishu-agent-bridge/commands.db`
- Runtime 状态: `~/.feishu-agent-bridge/listener-runtime.json`
- Runtime 日志: `~/.feishu-agent-bridge/runtime.log`
- Codex session DB: `~/.codex/state_5.sqlite`

## 环境要求

- Node.js 20.11 或更新版本。
- pnpm，建议通过 `corepack pnpm` 调用。
- `sqlite3` CLI，用于读取 Codex state DB 和本地队列 DB。
- Codex CLI，仅当需要从飞书群继续 Codex session 时必须。
- `screen` 可选；没有 `screen` 时 runtime 控制脚本会退回后台 shell 启动。
- 一个企业自建飞书应用，且已开启机器人能力。

## 安装与构建

```bash
git clone https://git.corp.kuaishou.com/live-client/feishu-agent-bridge-codexplugin.git
cd feishu-agent-bridge-codexplugin
corepack pnpm install
corepack pnpm build
```

常用脚本：

```bash
corepack pnpm build
corepack pnpm test
corepack pnpm smoke
corepack pnpm smoke:plugin
corepack pnpm runtime:status
corepack pnpm runtime:start
corepack pnpm runtime:restart
corepack pnpm runtime:stop
```

## Codex 插件安装

仓库根目录已经包含 Codex 插件结构：

- `.codex-plugin/plugin.json`：插件展示信息、Skill 和 MCP 入口声明。
- `.mcp.json`：插件模式下的 MCP server 声明。
- `skills/feishu-agent-bridge/SKILL.md`：给 Codex 的项目内操作说明。
- `scripts/codex-plugin-mcp.mjs`：插件模式下的 MCP 启动 wrapper。

安装到本机 Codex 插件市场：

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm codex:plugin:install
```

安装脚本会做这些事：

- 把当前仓库软链到 `~/plugins/feishu-agent-bridge`。
- 刷新插件缓存到 `~/.codex/plugins/cache/local/feishu-agent-bridge/<version>`。
- 更新 `~/.agents/plugins/marketplace.json`。
- 在 `~/.codex/config.toml` 中注册本地 marketplace，并启用 `feishu-agent-bridge@local`。
- 如果 `~/.feishu-agent-bridge/config.json` 已存在且 `inbound.enabled=true`，会停止旧 `fab-listener` / `fab-codex-worker`，然后拉起单进程 `fab-runtime`。

安装后重启 Codex，或在 Codex 里刷新插件列表。

只查看将要写入的内容：

```bash
corepack pnpm codex:plugin:dry-run
```

安装但不自动启动 runtime：

```bash
corepack pnpm codex:plugin:install -- --no-start-runtime
```

如果你已经在 `~/.codex/config.toml` 手动配置过同名 `[mcp_servers.feishu-agent-bridge]`，建议插件接入和手动 MCP 接入只保留一种，避免同一个 MCP server 被重复注册。

## 通用 MCP 客户端配置

非 Codex 插件场景可以直接把 MCP client 指向构建产物：

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

Codex 手动接入示例：

```toml
[mcp_servers.feishu-agent-bridge]
command = "node"
args = ["/absolute/path/to/feishu-agent-bridge-codexplugin/dist/src/index.js"]
enabled = true
```

## 本机配置

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
    "allowedOpenIds": [],
    "acknowledgeOnReceive": true,
    "acknowledgementText": "收到，已加入 Agent 队列。"
  },
  "codex": {
    "enabled": true,
    "command": "codex",
    "stateDbPath": "/Users/yourname/.codex/state_5.sqlite",
    "globalStatePath": "/Users/yourname/.codex/.codex-global-state.json",
    "useLast": false,
    "model": "gpt-5.2",
    "profile": "full_access",
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

字段说明：

| 字段 | 说明 |
| --- | --- |
| `appId` / `appSecret` | 飞书自建应用的应用凭证。MCP server、listener、runtime 都依赖它们换取 `tenant_access_token`。 |
| `receiveIdType` | 出站通知默认接收者类型，支持 `chat_id`、`open_id`、`email`。群聊通常使用 `chat_id`。 |
| `receiveId` | 出站通知默认接收者。`feishu_notify` 和 `feishu_send_test` 会用它；飞书入站任务的回复会发回事件里的 `chat_id`。 |
| `enabled` | 出站通知开关。建议飞书入站链路也保持 `true`，否则后续状态卡更新和兜底结果卡可能被跳过。 |
| `defaultTitle` | 通知卡片默认标题。 |
| `messageStyle` | 当前只支持 `card`。 |
| `inbound.enabled` | 是否允许启动飞书长连接 listener。为 `false` 时 runtime 不会监听新指令。 |
| `inbound.mode` | 当前只支持 `long_connection`。项目不再提供飞书消息 API 轮询兜底。 |
| `inbound.queueDbPath` | 当前 SQLite 队列路径，默认 `~/.feishu-agent-bridge/commands.db`。 |
| `inbound.queuePath` | 旧版 `commands.json` 导入来源。首次初始化会迁移旧数据，之后不再写 JSON queue。 |
| `inbound.requireMention` | 群聊是否必须 @ 机器人。单聊 `p2p` 会直接触发。 |
| `inbound.botOpenId` | 机器人 `open_id`，开启 `requireMention` 时建议配置，避免把 @ 其他机器人误识别成本机器人指令。 |
| `inbound.allowedOpenIds` | 可选的发送人 allowlist。配置后只有这些用户 `open_id` 的指令会被接收。 |
| `inbound.acknowledgeOnReceive` | 普通指令入队后是否发 queued 状态卡。后续 in_progress / done / failed 会尽量更新同一张卡。 |
| `codex.enabled` | 是否允许 runtime 调用 Codex CLI。普通飞书任务和 `new-session` 都需要它为 `true`。 |
| `codex.command` | Codex CLI 命令，默认 `codex`。 |
| `codex.stateDbPath` | Codex 本地 state DB。`list-project` / `list-session` 从 `threads` 表读取会话。 |
| `codex.globalStatePath` | Codex 全局状态文件，用来读取 GUI/workspace label 和 projectless temporary session。 |
| `codex.model` / `codex.profile` | 透传给 `codex exec` 的 `--model` 和 `--profile`。不需要时可删除。 |
| `codex.sandbox` | 透传给 `codex exec --sandbox`，支持 `read-only`、`workspace-write`、`danger-full-access`。 |
| `codex.approvalPolicy` | 透传给 `codex exec --ask-for-approval`，支持 `untrusted`、`on-request`、`on-failure`、`never`。 |
| `codex.extraArgs` | 附加给 `codex exec` 的参数。 |
| `codex.timeoutMs` | 单条 Codex CLI 任务最长执行时间。超时会终止子进程并标记失败。 |
| `codex.inProgressTimeoutMs` | runtime 启动时恢复卡住的 `in_progress` 任务的阈值。 |
| `codex.inProgressRecovery` | 恢复策略，`mark_failed` 或 `reset_pending`。 |
| `codex.sessionListLimit` | 文本模式下 session/project 列表展示数量。卡片分页固定每页 10 个。 |
| `codex.outputDir` | Codex CLI JSON 输出文件目录。 |
| `codex.outputMaxBytes` | Codex CLI stdout/stderr 在内存中保留的最大字节数。 |
| `codex.notifyResult` | 状态卡无法更新时，是否发送最终结果卡兜底。 |

兼容旧配置：

- `codex.sessionId`、`codex.sessionTitle`、`codex.cwd`、`codex.useLast` 仍可用于旧的全局 session 选择和手动调试。
- 当前飞书入站主链路不依赖全局 `codex.sessionId`。普通任务入队时会固化当前飞书群绑定的 `projectDisplayLabel`、`sessionId`、`sessionTitle`、`cwd` 等快照。
- `inbound.allowedChatIds` 仍会通过配置校验，但当前运行时不再用它过滤群。接入边界改为“机器人加入群 + 飞书事件权限送达 + 群内 project 绑定”。如需限制人，可以用 `allowedOpenIds`。

## 飞书开发者后台配置

入口：https://open.feishu.cn/app

### 1. 创建自建应用并开启机器人

1. 创建企业自建应用。
2. 进入「凭证与基础信息」，复制 `App ID` 和 `App Secret` 到 `config.json`。
3. 进入「应用功能」->「机器人」，开启机器人能力。
4. 把机器人添加到目标群。给群发消息时，机器人必须在对应群内。
5. 如果要主动发到单聊，确认应用对目标用户有可用性。

### 2. 开通权限

至少需要：

- `im:message:send_as_bot`：以机器人身份发送消息。通知卡、状态卡、文本 ACK 都需要。
- `im.message.receive_v1` 对应的接收消息权限：通常选择“获取用户在群组中@机器人的消息”。如果要接收单聊，还需要单聊消息权限；如果要接收群内所有消息，可以开群消息权限，但本地仍建议保持 `requireMention=true`。

按功能可能还需要：

- 获取群信息权限：用于把 `chat_id` 解析成群名，失败时不影响主链路，只是不展示群名。
- 获取消息资源权限：如果要支持用户发送图片并由 runtime 下载附件，需要允许读取消息里的资源文件。

权限开通后需要创建版本、提交审批并发布生效。只在后台点了权限但没有发布，运行时仍可能没有权限。

### 3. 配置消息事件

进入「事件与回调」->「事件配置」：

1. 订阅方式选择「使用长连接接收事件」。
2. 本地先启动 runtime，直到日志出现 `ws client ready`。
3. 回到飞书后台点击验证并保存订阅方式。
4. 添加事件：「消息与群组」->「接收消息 v2.0」，事件类型是 `im.message.receive_v1`。
5. 创建版本并发布。

注意：`ws client ready` 只说明本地 WebSocket 连上了飞书网关，不代表后台已经把消息事件推给这条连接。真正收到消息时，本地日志会出现 `[inbound] received message`。

### 4. 配置卡片按钮回调

`list-project`、`list-session`、翻页和“绑定项目 / 介入”按钮依赖卡片回调。

进入「事件与回调」->「回调配置」：

1. 订阅方式选择「使用长连接接收回调」。
2. 本地保持 runtime 运行，直到日志出现 `ws client ready`。
3. 点击验证并保存订阅方式。
4. 添加回调：「卡片」->「卡片回传交互」，回调类型是 `card.action.trigger`。
5. 创建版本并发布。

消息事件和卡片回调是两套配置。`im.message.receive_v1` 正常，不代表 `card.action.trigger` 已生效。点击按钮如果报 `code: 200340`，且本地日志没有 `[card]`，通常是卡片回调没有配置、没有发布，或当前运行的不是已验证的长连接客户端。

临时兜底命令：

```text
@机器人 bind-project <序号|projectId>
@机器人 switch-project <序号|projectId>
@机器人 switch-session <序号|sessionId>
```

### 5. 发布与长连接限制

- 每次修改权限、事件、回调后都要创建版本并发布。
- 长连接模式只适用于自建应用。
- 保存长连接订阅方式时，本地 SDK 客户端需要已经运行并连接成功。
- 长连接是集群模式，不是广播模式。同一个 App ID 如果同时跑多个 listener，飞书只会随机推给其中一个连接，容易造成“这个进程没收到”的误判。
- 不要同时保留旧 `fab-listener` 和新 `fab-runtime`。当前主路径是单进程 `fab-runtime`。

## Runtime 使用

插件安装或插件 MCP wrapper 启动时，会在 `inbound.enabled=true` 的情况下幂等 ensure `fab-runtime`。也可以手动控制：

```bash
corepack pnpm runtime:status
corepack pnpm runtime:start
corepack pnpm runtime:restart
corepack pnpm runtime:stop
```

临时前台运行：

```bash
corepack pnpm runtime
```

`fab-runtime` 做的事情：

```text
1. 启动 Feishu long connection listener
2. 初始化 ~/.feishu-agent-bridge/commands.db，并迁移旧 commands.json
3. 恢复卡住的 in_progress 任务
4. 收到 @机器人 普通指令
5. 检查当前群是否已绑定 Codex project / active session
6. 写入 SQLite 队列，并发送 queued 状态卡
7. 唤醒对应 session runner
8. 调用 codex exec resume <sessionId> -
9. 低频更新 in_progress 摘要
10. 完成后更新 done / failed 状态卡，必要时发送结果卡兜底
```

同一 session 串行执行；不同 session 可以并发执行。这样可以避免多个飞书群同时写入同一个 Codex 上下文。

## 飞书群内命令

控制命令由 listener 直接处理，不进入普通 Agent 队列：

```text
@机器人 help
@机器人 list-project
@机器人 list-project 2
@机器人 current-project
@机器人 bind-project <序号|projectId>
@机器人 switch-project <序号|projectId>
@机器人 new-session [初始说明]
@机器人 list-session
@机器人 list-session --all 2
@机器人 list-session --temp 2
@机器人 switch-session <序号|sessionId>
@机器人 current-session
@机器人 unbind-session
@机器人 unbind-project
```

绑定规则：

- 每个飞书群默认绑定一个 Codex project。
- 绑定 project 后会自动选中该 project 最近更新的 session 作为 active session。
- `list-project` 从 `codex.stateDbPath` 的 `threads` 表读取会话，并按 `threads.cwd` 聚合 project。
- project 展示名优先使用 `~/.codex/.codex-global-state.json` 里的 `electron-workspace-root-labels`，然后附加 git repo basename。
- `list-session` 默认只展示当前 project 下的 session。
- `list-session --all` 展示全局 session。
- `list-session --temp` 展示 temporary session。
- `switch-session` 只能切换当前 project 内的 session。跨 project 需要先 `switch-project`。
- `new-session` 会在当前 project root 下启动新的 `codex exec`，等待本地 state DB 落盘后绑定为 active session。
- `unbind-session` 只解除当前 active session，保留当前 project 绑定；后续可以继续 `list-session` / `new-session`。
- `unbind-project` 会解除当前群与 project 的绑定，并清空 active session；后续普通任务会先要求重新绑定 project。

解绑指令语义：

- `unbind-session` 用在“这个群仍然属于当前 project，但暂时不想继续沿用当前 Codex 会话”的场景。执行后 project 仍保留，普通任务会先要求选择 session 或创建 `new-session`。
- `unbind-project` 用在“这个群不再绑定当前 project”的场景。执行后 project 和 active session 都会被清空，普通任务会先要求重新选择 project。

普通自然语言指令只有在当前群已绑定 project 且有 active session 后才会入队。未绑定 project 时，runtime 会返回 project 选择卡；已绑定 project 但没有 active session 时，会返回当前 project 的 session 选择卡，并要求绑定 session 后重新发送原指令。

## 图片消息

支持两种方式：

- 同条消息里带图片并 @ 机器人说明任务。
- 先在群里发送图片，5 分钟内由同一个人发送 `@机器人 识别刚才那张图`。

行为细节：

- 群聊里不 @ 机器人的纯图片不会触发任务，只会作为最近图片候选缓存。
- 缓存按“群 + 发送人”隔离，最多保留最近 5 张。
- 如果最近连续发送多张图，未过期候选会一次性全部入队。
- 如果同条或最近图片可用但没有文字说明，默认任务文本是 `请识别并分析这张图片。`。
- 下载后的资源保存在 `~/.feishu-agent-bridge/resources/<chatId>/<messageId>/...`。
- V1 不拉取历史消息，所以不要依赖“先发图、很久以后再 @”的历史检索。

## MCP Tools

| Tool | 说明 |
| --- | --- |
| `feishu_notify` | 发送通用飞书通知卡片。 |
| `feishu_notify_task_result` | 发送任务结果卡片，支持 `success`、`failed`、`needs_action`。 |
| `feishu_send_test` | 发送一条短测试消息，用于验证飞书出站配置。 |
| `feishu_status` | 查看本地配置就绪状态，敏感信息会脱敏。 |
| `feishu_set_enabled` | 启用或关闭出站通知。 |
| `feishu_command_status` | 查看入站队列、session 分区统计和 runtime/listener 状态。 |
| `feishu_start_command_listener` | 返回独立 `fab-runtime` 启动指引。不会在 MCP server 进程内常驻 listener。 |
| `feishu_stop_command_listener` | 返回独立 `fab-runtime` 停止指引。 |
| `feishu_next_command` | 调试或外部 Agent 兼容入口，取下一条 pending 指令，默认认领为 `in_progress`。 |
| `feishu_ack_command` | 把指令标记为 `done` 或 `failed`。 |
| `feishu_list_commands` | 查看本地队列中的指令。 |
| `feishu_set_inbound_enabled` | 修改 `inbound.enabled`。 |

通用通知字段示例：

```json
{
  "source": "codex",
  "title": "Build finished",
  "status": "success",
  "summary": "All checks passed.",
  "cwd": "/path/to/project",
  "projectLabel": "ios-client",
  "codexSessionId": "019e249d-96bd-75d3-b604-16a0198a4649",
  "codexSessionTitle": "Fix build failure",
  "artifacts": ["/path/to/report.txt"],
  "links": [{ "label": "Run", "url": "https://example.com/run/1" }],
  "nextSteps": ["Review the output"],
  "metadata": { "duration": "42s" }
}
```

卡片展示规则：

- `Project` 优先使用入参 `projectLabel`，否则从 `cwd` 推导，再退回 `codex.cwd`。
- `Codex session` 优先使用入参 `codexSessionLabel`，否则用 `codexSessionTitle + 短 id`，再退回短 id、`useLast` 或 `(unbound)`。
- 手动 `feishu_notify` / `feishu_notify_task_result` 不会静默继承全局 `codex.sessionId`，避免误导接收人。
- `metadata` 保留给调用方本地扩展，不默认展示到飞书卡片。

## 验证

基础验证：

```bash
corepack pnpm test
corepack pnpm smoke
corepack pnpm smoke:plugin
```

插件安装预检查：

```bash
corepack pnpm codex:plugin:dry-run
```

出站通知验证：

1. 配置 `~/.feishu-agent-bridge/config.json`，并设置 `enabled=true`。
2. 确认机器人已进目标群，`receiveIdType=chat_id`，`receiveId=oc_xxx`。
3. 在 MCP client 中调用 `feishu_send_test`。

入站链路验证：

```bash
corepack pnpm runtime:restart
corepack pnpm runtime:status
tail -200 ~/.feishu-agent-bridge/runtime.log
tail -200 ~/.feishu-agent-bridge/listener.log
sqlite3 ~/.feishu-agent-bridge/commands.db 'select id,state,session_id,text from commands order by received_at desc limit 10;'
```

在飞书群里：

```text
@机器人 list-project
@机器人 bind-project 1
@机器人 current-session
@机器人 继续执行测试
```

然后调用 `feishu_command_status`，确认对应 session 的 `pending/in_progress/done/failed` 统计变化。

## 排查清单

### MCP tools 看不到

- 确认执行过 `corepack pnpm build`，`dist/src/index.js` 存在。
- 插件模式确认 `corepack pnpm codex:plugin:dry-run` 输出的 marketplace 和 plugin key 正常。
- 重启 Codex 或刷新插件列表。
- 如果 `codex mcp list` 能看到服务，但当前旧会话看不到 tools，通常是 Codex 线程没有刷新 MCP server，而不是服务二进制坏了。
- smoke 只能证明 stdio framing 和工具列表正常，不能证明当前 Codex GUI 已经加载这个 MCP server。

### Runtime 没启动

- 确认 `~/.feishu-agent-bridge/config.json` 存在且是合法 JSON。
- 确认 `inbound.enabled=true`。
- 运行 `corepack pnpm runtime:status` 查看 `listener-runtime.json` 中的 `managedBy`、`pid`、`processAlive`、`ready`。
- 查看 `~/.feishu-agent-bridge/runtime.log`。
- 如果旧进程还在，执行 `corepack pnpm runtime:restart`，它会清理旧 `fab-listener` / `fab-codex-worker`。

### `ws client ready` 但群里 @ 没反应

- `ws client ready` 只代表本地连接成功，不代表飞书后台事件配置已发布。
- 检查「事件配置」是否选择「使用长连接接收事件」。
- 检查是否添加 `im.message.receive_v1`。
- 检查权限是否包含群聊 @ 机器人消息权限。
- 检查修改后是否创建版本并发布。
- 确认没有另一个进程用同一个 App ID 建立长连接。长连接是集群模式，多连接时只有一个连接会收到推送。
- 本地真正收到事件时，日志会出现 `[inbound] received message`。

### 卡片按钮报 `code: 200340`

- 消息事件正常不代表卡片按钮回调正常。
- 检查「回调配置」是否选择「使用长连接接收回调」。
- 检查是否添加 `card.action.trigger`。
- 检查是否发布了新版本。
- 点击按钮后本地应看到 `[card] handled codex card action` 或相关 `[card]` 日志。
- 临时用文本命令 `bind-project 1`、`switch-project 1`、`switch-session 1` 兜底。

### 任务一直 queued 或 in_progress

- 查看 `feishu_command_status` 的 queue 和 scheduler 状态。
- 查看 `commands.db` 里该任务的 `state`、`status_message_id`、`status_notify_error`。
- 确认 `codex.enabled=true`。
- 确认绑定的 session 还存在于 `codex.stateDbPath`。
- 确认 `codex exec resume --help` 可用。
- 如果任务卡在 `in_progress`，重启 runtime 会按 `codex.inProgressTimeoutMs` 和 `codex.inProgressRecovery` 恢复。

### `list-project` 没有想要的 project

- 确认 `codex.stateDbPath` 指向当前 Codex 使用的 `state_5.sqlite`。
- 确认目标 project 至少已有一个 Codex session。
- temporary session 默认不进入 project 列表，可用 `list-session --temp` 查看。
- project 名称来自 Codex global state 的 workspace label 和 git repo basename；GUI 没同步 label 时可能只显示目录名。

### 飞书能发消息但不能下载图片

- 图片下载使用消息资源接口读取 `message_id` + `image_key`。
- 检查应用是否有读取消息资源的权限。
- 检查图片是否来自支持的消息类型：`image` 或富文本 `post`。
- 下载失败时 runtime 会在群里回复错误，并把任务忽略，不会入队。

### 常见飞书发送错误

- `230002`：机器人不在对应群。
- `230006`：机器人能力未开启或版本未发布。
- `230027`：缺少必要权限。
- `230034`：`receive_id` 不合法，检查 `chat_id` / `open_id`。
- `230035`：没有发言权限，检查机器人是否在群里、群是否禁言。
- `230099`：卡片内容构造失败，检查卡片 payload。

## 维护约定

- 凭证、队列、runtime 日志和 Codex 输出都在 `~/.feishu-agent-bridge/` 下，不要提交到仓库。
- `commands.db` 是当前队列源，`commands.json` 只作为旧数据导入来源。
- 对飞书入站或状态卡行为做代码改动时，至少运行 `corepack pnpm test` 和 `corepack pnpm smoke:plugin`。
- 对 MCP stdio framing 做改动时，必须保留 newline-delimited JSON 和 `Content-Length` 两种模式的 smoke 覆盖。
- README 要跟源码中的配置字段和运行边界同步，尤其是 `src/config.ts`、`src/inbound.ts`、`src/codexWorker.ts`、`src/runtime.ts`、`scripts/runtime-control.mjs`。
