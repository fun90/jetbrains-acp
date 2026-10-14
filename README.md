# IDEA 与 pi 的 ACP 适配器

通过 ACP v1/v2 将 IntelliJ IDEA 的 Air 插件聊天界面连接到本机 pi coding agent。

```text
IDEA / Air 插件 ← ACP JSON-RPC / stdio → 本仓库适配器 ← RPC JSONL → pi
```

适配器使用 Node.js 标准库，无需构建；npm 安装会同时安装固定版本 pi `1.2.0` 及扩展需要的 `typebox`。开发及真实启动验证基于 pi `1.1.0`；文件 diff 与历史回放也已在 pi `1.2.0` 验证。

## 快速使用

1. 安装 Node.js `22.19.0` 或更高版本，在本项目运行 `npm ci`。默认使用随依赖安装的 pi；运行 `node src/index.js --setup`，在 pi 中输入 `/login` 完成登录，退出 pi 后返回 IDE。也可继承已有 pi 的用户配置和环境变量。
2. 在本项目目录生成适合当前机器的 IDEA 配置：

   ```bash
   npm run --silent config
   # 使用外部 pi 时，显式传入路径：
   npm run --silent config -- /绝对路径/pi
   ```

3. 在 IDEA 的 Air 插件聊天界面中选择 **Add Custom Agent**，将生成的 `agent_servers.pi` 条目合并到 `~/.jetbrains/acp.json`，保留已有条目。也可参考 [examples/acp.json](examples/acp.json)。
4. 在聊天界面选择 `pi`，发送消息。默认使用“完全访问”，自动允许工具调用；“标准访问”逐次授权，“只读”自动拒绝有副作用的工具，“规划”还会在系统提示中要求只分析并制定计划。

需要支持 ACP 的 IntelliJ IDEA 与兼容的 Air 插件（ID `com.intellij.air`）；菜单位置随版本变化，ACP 配置格式可参考 [JetBrains 官方说明](https://www.jetbrains.com/help/ai-assistant/acp.html)。配置生成命令只打印 JSON，不修改 IDE 配置。

## npm 安装与 Registry

npm 包发布后可以直接运行：

```bash
npx --yes jetbrains-pi-acp@0.1.0 --setup
```

登录入口启动 pi 的终端界面；输入 `/login` 选择提供商，完成登录后退出。适配器不会读取、复制或另存登录凭据。Registry 的终端认证入口使用相同流程，客户端声明终端认证能力后，v1/v2 握手返回对应的 `terminal` 认证方式。

在 `~/.jetbrains/acp.json` 中合并以下配置即可通过 npm 启动：

```json
{
  "agent_servers": {
    "pi": {
      "command": "npx",
      "args": ["--yes", "jetbrains-pi-acp@0.1.0"],
      "use_idea_mcp": true,
      "use_custom_mcp": true
    }
  }
}
```

IDE 需要能找到 `npx`；也可先运行 `npm install --global jetbrains-pi-acp@0.1.0`，再使用命令的绝对路径。Registry 收录需要另行审核，源码仓库存在不代表已经上架。

发布步骤见 [发布指南](docs/publishing.md)，可直接复制的收录材料位于 [registry/jetbrains-pi-acp](registry/jetbrains-pi-acp)。

## 指定模型

把 `--` 及后续 pi 参数加在 IDEA 配置的 `args` 末尾，例如：

```json
["/绝对路径/jetbrains-acp/src/index.js", "--pi-command", "/绝对路径/pi",
 "--", "--model", "openai/你的模型ID", "--thinking", "medium"]
```

`--` 后传递 pi 的配置选项，不传递初始提示、交互模式或会话选择参数。适配器统一指定 `--mode rpc`、会话 ID 或恢复文件及自己的扩展。也可使用 `PI_ACP_PI_COMMAND` 环境变量指定外部 pi 可执行文件。未指定时通过当前 Node.js 启动随依赖安装的 pi，不依赖 PATH 中的全局 pi。IDEA 启动时的 PATH 可能与终端不同，推荐使用生成的绝对路径。

## 已实现的协议功能

| ACP 功能 | 行为 |
| --- | --- |
| `initialize` | 协商 v1，返回实际支持的能力 |
| `session/new` | 每个会话启动独立 pi 进程，使用 IDEA 传入的绝对 `cwd`，按 pi 配置持久保存 |
| `session/list` | 使用 pi 原生会话索引发现历史，可按项目 `cwd` 过滤；返回会话标题和更新时间，支持游标分页；Air 会话索引附带可关联的分叉来源 |
| `session/load` / `session/resume` | 加载会回放当前分支的消息、思考和工具记录；恢复只重新打开，随后均可继续聊天 |
| `session/close` / `session/delete` / `session/fork` | 关闭释放当前 pi 子进程；删除移除对应历史文件；分叉复制当前分支，或按指定助手消息保留其所在整轮，并保留源会话 |
| 模型列表与切换 | 返回 `configOptions` 与兼容旧版的 `models`；支持 `session/set_config_option` 和 `session/set_model` |
| 推理级别 | 通过 `thought_level` 配置选项连接 pi 的推理设置；模型切换后刷新可用级别与实际值 |
| 权限模式 | 默认完全访问，支持规划、只读和标准访问；同时兼容 `session/set_mode` 与 `session/set_config_option` |
| `session/prompt` | 转发文本、内嵌图片、文本资源和资源引用；v1 完成响应附带本轮模型及自动压缩 token 用量 |
| `_session/steering` | 按 Air 扩展约定接收执行中的补充提示，通过 pi steering 引导后续执行；空闲时启动新回合 |
| `session/update` | 转发回答、思考、工具状态、命令列表、上下文用量、会话累计费用和压缩状态；同步 pi 会话名变更及恢复后的标题 |
| 命令与上下文 | 发布 pi 扩展命令、prompt 和 skill；内置 `/status` 与 `/compact [要求]` |
| 终端输出 | `bash/powershell` 发送 terminal 内容、协商后的输出增量及退出码 |
| 终端输入 | Air v1 可在执行中的补充输入入口发送 `/stdin 文本` 或 `/eof`；其他客户端启用 `_meta.terminal_input: true` 后通过 `_terminal/input` 写入 UTF-8 stdin 或 EOF |
| 文件 diff | 内置 `edit/write` 成功后发送标准 ACP diff 和文件位置；编辑提供首个修改行号，Air 可协商 Git patch 及每轮文件报告，历史加载回放同一 diff；Git patch 支持特殊路径与空新文件 |
| 其他工具的文件报告 | 客户端协商并请求文件报告后，对比本轮执行前后工作目录的文件元数据，将命令、MCP、扩展造成的新增、修改、删除、重命名路径并入报告；包含二进制与 Git 忽略文件，其他工具暂不生成逐文件 diff |
| 扩展交互 | 表单桥接 `confirm/select/input/editor`；URL 交互通过扩展事件总线请求及完成通知，均需客户端协商 |
| 子 agent 会话 | `spawn_agent` 创建独立 pi 会话，协商后发布原生父子生命周期，未协商时在父工具中显示回答；支持对子会话取消和关闭 |
| 后台任务 | `background_shell` 启动后台命令，`task_status` 查询，`stop_task` 定向停止；Air 协商 `asyncTasks` 后显示后台任务状态 |
| `session/cancel` | 解除待授权请求、清空 pi 队列并中止执行 |
| `session/request_permission` | pi 扩展在工具执行前阻塞，等待 IDEA 的授权结果 |
| MCP | 转发 stdio 和 HTTP 配置；不支持 SSE |

提示接收成功不等于执行完成。适配器等到 pi 的 `agent_settled` 才返回 `stopReason`；取消返回 `cancelled`，模型长度限制返回 `max_tokens`，模型或进程失败返回 JSON-RPC 错误。同一会话拒绝并发的普通提示，通过 `_session/steering` 接收补充要求，不同会话相互独立。stdout 只输出 ACP JSONL，诊断写到 stderr。

初始化响应通过顶层 `_meta.steering.supported: true` 声明支持 Air steering。Air 客户端声明后还可协商 `diffPatch`、`agentFileChangeReport` 和 `customInstructions`。Air 在执行中发送的 `_session/steering` 复用普通提示的内容格式；适配器串行提交到 pi 的 `prompt`，并指定 `streamingBehavior: "steer"`。补充提示在当前助手回合的工具调用完成后、下一次模型调用前生效，不会立即打断正在执行的工具。响应 `outcome: "injected"` 表示已入队或被输入处理器处理；如果上一轮已经结束，则启动新回合并返回 `startedNewTurn`；提交失败返回 `failed`。原普通提示等待包括补充执行在内的真正完成，取消会清空未消费的补充消息。由 steering 启动的新回合继续通过 `session/update` 输出，执行错误也通过消息更新显示。

启动会话时会检查 ACP 扩展是否加载成功；授权扩展不可用会导致会话创建失败。MCP 配置写入权限为 `0600` 的临时文件，在适配器退出时删除，不修改用户的 pi 配置。IDEA 传入的 MCP 由 pi 原生 MCP 扩展连接，需要保持该扩展启用。

## 终端交互输入

Air ACP v1 无需专用终端输入框：适配器识别 Air 后自动启用 stdin 桥接。更新后重启 Agent 连接，重新创建或恢复会话；在命令运行期间，通过聊天的补充输入入口发送 `/stdin 你好`，适配器直接向当前终端写入 `你好` 加换行；发送 `/stdin` 写入空行，发送 `/eof` 关闭 stdin。文本不会交给模型，也不会进入 pi steering 队列。命令仅在当前会话恰好有一个已授权、可输入的终端时执行，否则返回错误。若客户端运行时无法发送补充消息，该入口仍不可用。

这是本适配器的扩展接口。其他客户端在 v1 `initialize.clientCapabilities._meta`（v2 为 `initialize.capabilities._meta`）声明 `terminal_input: true`；初始化响应的 `_meta.terminal_input` 返回 `{supported: true, controlMethod: "_terminal/input", encoding: "utf8", maxBytes: 65536}`。随后创建或恢复的会话使用可写 stdin 的 shell 工具；未启用的客户端继续使用 pi 原有执行方式。

工具获得授权并成功启动后，v1 `tool_call_update._meta.terminal_info.input_enabled: true`（v2 `terminal_update.inputEnabled: true`）表示当前可输入，`terminalId` 与工具调用 ID 相同。客户端发送请求，例如：

```json
{"jsonrpc":"2.0","id":42,"method":"_terminal/input","params":{"sessionId":"会话ID","terminalId":"工具调用ID","data":"yes\n"}}
```

`data` 是 UTF-8 文本，每次最多 64 KiB，不自动添加换行；可发送空文本并设置 `eof: true` 关闭 stdin。成功写入后返回 `{}`，同时发布 `_meta.terminal_input = {terminal_id, data}`，输入不混入输出流。失败返回 JSON-RPC 错误，不报告成功。会话、进程及权限状态分别校验，待授权、已退出、已取消、规划和只读状态不能输入；`session/cancel` 会终止等待输入的进程及其子进程。

专用终端输入框仍需客户端接入这个新增接口；Air v1 的聊天命令可作为输入入口，v2 不提供此聊天入口。当前提供 stdin 管道，不提供 PTY、终端尺寸、全屏交互、tty 密码提示或快捷键信号；`data: "\u0003"` 是输入字节，不等同于 Ctrl+C，应使用 `session/cancel`。使用 stdin 传递 shell 命令的旧 WSL 配置无法同时用于交互输入。Windows PowerShell 通路已有实现，尚未在 Windows 实机验证。

## 子 agent 与后台任务

模型可使用内置工具：

- `spawn_agent({prompt, name?})`：创建独立上下文的 pi 子会话并在后台执行，继承创建时父会话的模型、推理级别、工作目录、MCP、自定义指令和权限模式；返回 `taskId` 与 `sessionId`。
- `background_shell({command, timeout?})`：启动后台 shell 命令，`timeout` 为秒；返回 `taskId`。命令使用 pi 配置的 shell 和命令前缀。
- `task_status({taskId})`：查询本会话任务的状态及最近最多 256 Ki 个 UTF-16 代码单元的输出，截断时返回 `truncated: true`。
- `stop_task({taskId})`：只停止该任务；后台命令终止整个进程组，子 agent 停止当前执行及其后代任务。

启动任务沿用现有授权流程；规划和只读模式拒绝启动，标准访问逐次授权，查询无需额外授权。任务创建后可在父回合结束后继续运行；根会话 `session/cancel` 只取消前台回合，关闭、删除、归档根会话或适配器正常退出时回收其全部任务。直接对返回的子会话 ID 发送 `session/cancel` 或 `session/close` 可定向操作子会话。

v1 客户端声明 `clientCapabilities.subagents: {}`，或 v1/v2 客户端协商 Air 能力 `nativeSubagentSessions` 后，收到父会话的 `subagent_spawned`、子会话上的消息与工具更新，以及父会话上的 `subagent_state_update`。子会话声明 `cancel: true` 和 `close: true`。未协商时，子回答通过父工具展示。

Air 声明 `asyncTasks` 后，后台命令发布 `async_task_spawned` 和 `async_task_state_update`。客户端也可请求 `_session/async_task/list`，参数为 `{sessionId}`，或 `_session/async_task/stop`，参数为 `{sessionId, asyncTaskId}`。任务 ID 按创建会话校验，不能跨会话停止；成功停止返回 `{stopped: true}`，已结束返回 `{stopped: false}`。后台工具不是自动把普通 `bash` 转到后台，需模型明确调用 `background_shell`；后台命令暂不提供 stdin 或 PTY。

任务关系与终态写入 pi 原生历史。加载父会话会递归重建子会话树，按各自会话 ID 回放消息、思考、工具与终态；`session/resume` 恢复关系和任务控制但不回放消息。分叉不会取得源会话任务的控制权。子会话缺失、关系循环或执行结果未知时报告 `disconnected`，不自动重跑模型任务；有明确完成记录时保留原终态。

后台 shell 由独立 Node.js 进程执行，在会话文件旁的 `.jsonl.tasks/` 目录保存受权限保护的控制信息和有上限的输出。适配器意外退出后，加载或恢复父会话会重新连接仍在运行的命令，并可使用原任务 ID 查询和停止；已结束的命令不会重复执行。正常关闭、删除、归档会话或退出适配器仍会终止其任务；删除会话同时移除该会话的后台命令存储。执行进程本身失联时报告失败，不仅凭历史 PID 发送终止信号，避免误杀其他进程。不要同时用多个适配器写入同一 pi 会话。

第三方 pi 扩展可在已授权工具的 `execute(toolCallId, ...)` 中通过事件总线接入原生子会话：

```ts
const task = await new Promise((resolve, reject) => {
  pi.events.emit('acp:agent:spawn', {
    toolCallId,
    params: { prompt: '需要委派的任务', name: '审查 agent' },
    resolve,
    reject,
  });
});
```

查询和停止分别使用 `acp:task:status`、`acp:task:stop`，`params` 为 `{taskId}`，同样提供 `resolve/reject`。桥接创建的会话使用同一套权限、持久化、原生展示、历史恢复与定向停止。工具须返回可序列化结果，例如 `{content: [{type: 'text', text: JSON.stringify(task)}], details: task}`；也可直接通过 pi 的 `ctx.executeTool('spawn_agent', {prompt, name})` 委派。未采用桥接、使用私有进程或 `--no-session` 的旧扩展仍按其原有工具结果展示，无法从缺少的数据自动推断出可恢复的子会话。更新前未记录父子关系的旧历史也不会被猜测补全。

## 历史会话

适配器声明 `loadSession` 以及 list、resume、close、delete、fork 会话能力。Air 可通过 `session/list` 发现已有 pi 会话，再通过 `session/load` 打开并回放，或通过 `session/resume` 仅重新打开。列表读取 pi 的原生存储，不复制会话到 IDEA；默认按 IDEA 当前项目的绝对 `cwd` 过滤，其他目录下的历史不会出现在该项目的列表中。分叉使用 pi 原生 clone，生成独立历史文件；源会话由新的 pi 子进程继续持有。空闲会话在 `session/load` 或 `session/resume` 收到新的 `mcpServers` 时自动重建 pi 连接，保留历史、模型、推理级别和权限；重连失败保留原连接，有正在运行的后台任务时拒绝切换。分叉可传入当前 IDE 的 `mcpServers` 配置；新会话使用该配置，源会话保持原配置，省略时继承源配置。指定历史消息时，在 `session/fork` 的 `_meta.jetbrains.air.fork` 传入 `{version: 1, messageId}`，仅复制当前分支截至该助手消息所在整轮的历史（含工具结果）。支持 `:segment:<n>` 后缀；可选 `messageFingerprint: "sha256:<64 位十六进制>"` 在 ID 未匹配时按回答文本匹配，`messageOccurrence` 选择重复回答中的第几次（从 1 开始，默认 1）。无效参数或未找到消息返回 `-32602`，不会退回复制整个分支。

指定消息分叉的请求必须带 `_meta.jetbrains.air.fork.messageId`。若日志显示 `Session fork requested ... message=null` 和 `Session fork started ... turn=null`，说明分叉点未传到后端，适配器会按整段会话分叉。仅凭该日志不能判断用户选择了哪个界面入口；从消息或回合菜单出现此行为时，需要继续核对客户端参数传递。

安装在 pi 中的 `session-title` 扩展生成会话名后，适配器会实时推送给 Air；手动改名也使用同一通道。需要保持该扩展启用，Air 的实时刷新取决于其版本是否处理 ACP `session_info_update`。

默认存储位置是 `~/.pi/agent/sessions/`；同时遵循 pi 的 `--session-dir`、`PI_CODING_AGENT_SESSION_DIR` 和 `sessionDir` 设置，以及 `PI_CODING_AGENT_DIR`。新聊天同样持久保存，可从终端 pi 恢复。之前由本适配器以 `--no-session` 创建的临时聊天没有历史文件，无法补回。

更新适配器后，需要重启 Air 的 pi Agent 连接（或重启 IDEA）以重新协商能力。命令列表在会话创建时发布；旧连接不会自动加载代码修改。已兼容 Air 命令输入的类型字段，重连后可在已创建的会话中输入 `/` 检查补全。能否自动显示历史还取决于 Air 版本是否调用 `session/list`。打开历史继续聊天会写入原来的 pi 会话文件，避免同时在终端和 Air 中操作同一会话。

## 验证

```bash
npm test
# 使用本机 pi 验证启动、扩展握手及本地模型替身 steering，不调用远端模型：
PI_ACP_SMOKE=1 npm test
```

自动测试使用可控的 pi RPC 替身，覆盖握手、流式输出、真正完成时机、授权、规划与只读模式、命令发现、用量、压缩、会话关闭/删除/分叉/恢复、steering、终端输出、扩展表单、MCP、文件 diff、Unicode JSONL、原生子会话、后台任务与定向停止及历史回放。显式启用的本机 pi 验证还会使用本地模型替身验证真实工具执行、标题、终端输出、历史发现和跨进程恢复，不调用远端模型。

## URL 交互扩展接口

客户端在 ACP v1 的 `clientCapabilities` 或 v2 的 `capabilities` 中声明 `elicitation: { url: {} }` 后，pi 扩展可通过事件总线请求浏览器交互：

```ts
const request = (event: string, params: object) => new Promise<any>((resolve, reject) => {
  pi.events.emit(event, { params, resolve, reject });
});
const result = await request('acp:elicitation:url', {
  url: 'https://example.com/connect', message: '请授权账号以继续',
});
if (result.action === 'accept') {
  // 由扩展等待自己的网页回调并核实操作结果，再发送完成通知。
  await waitForVerifiedCallback();
  await request('acp:elicitation:complete', { elicitationId: result.elicitationId });
}
```

此代码应放在本适配器加载的 pi 扩展工具或命令处理器中，`waitForVerifiedCallback` 由实际业务实现。请求通过已有 fd 3 双向通道传递；`resolve/reject` 只在扩展进程内使用。

请求返回 `{ action, elicitationId }`，`action` 为 `accept/decline/cancel`；客户端不支持 URL、回合已取消或客户端回复错误时返回 `cancel`。非法参数通过 `reject` 返回错误。`accept` 仅表示同意打开网址；浏览器交互和凭据存储由扩展处理。完成调用返回 `{ completed: true }` 并发送 ACP `elicitation/complete`；未知、重复、未接受或不属于当前会话的 ID 返回 `{ completed: false }`。

只允许 HTTPS 及 `localhost/127.0.0.1/[::1]` 的 HTTP 网址，禁止 URL 内用户名和密码，网址及说明各最多 10000 字符。扩展不得在网址或说明中放入凭据、个人敏感信息或可直接访问受保护资源的授权链接，也不得通过此接口回传网页凭据。适配器生成连接内唯一 ID，最多保留 100 个待完成交互；已接受交互可在模型回合结束后完成，会话取消、关闭、进程失败或切换只读/规划模式时清理。客户端负责展示网址、征求用户同意并打开浏览器。

此接口提供扩展接入契约；尚未自动接入任意 MCP 服务端的 URL elicitation。协议依据：[ACP elicitation 说明](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/elicitation.mdx)。

## ACP v2 协议适配

客户端以 `protocolVersion: 2`、`info: { name, version }` 和可选的 `capabilities` 初始化，适配器自动选择 v2。对照 2026-10-15 的[上游草案 Schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/bacbb62b5f3181719eecec714e19fdb34a764f75/schema/v2/schema.json)，已覆盖会话基础协议及声明的图片、文本内嵌上下文、stdio/HTTP MCP 和删除能力；分叉使用上游可选的实验性 `session.fork`。子 agent 与后台任务仍按 Air 扩展协商，v2 不把 `subagents` 当作标准能力。

- 支持 `session/new/list/resume/close/prompt/cancel` 及 `session/set_config_option`，配置使用 `configId`，设置选择项需要 `type: "id"`。MCP 的可选 `args/env/headers` 可省略。
- 提示正式插入后立即返回 `messageId` 并回显用户消息，后续通过 `state_update` 报告 `running/requires_action/idle`。排队提示按会话串行执行；插入前 `$/cancel_request` 返回 `-32800`，插入后使用 `session/cancel`。执行失败以 `stopReason: "error"` 和结构化 `error` 报告；关闭活动会话先报告取消完成，再返回成功。
- `session/resume` 不指定 `replayFrom` 或传 `null` 时只恢复上下文；`{ type: "start" }` 在响应前回放当前分支。拒绝其他游标；保留用户消息 ID，回放前按消息类型清空旧内容，并重置终端输出，避免重复追加。
- 工具、Git diff、终端字节输出、结构化计划、配置、用量、授权、表单及 URL 交互均转换为 v2 格式。压缩完成及历史回放包含摘要；新压缩使用独立 ID。
- 客户端声明 `capabilities.auth.terminal: {}` 后，握手发布带 `methodId` 和环境变量的终端登录入口。客户端以原启动配置运行交互进程，完成后重新连接；不能对终端方式调用 `auth/login`。`auth/logout` 取消活动与排队提示并关闭当前连接，后续请求返回 `-32000`；不删除 pi 保存的凭据。
- 未声明音频、额外工作目录和实验性 `systemPrompt/NES` 能力；不支持的工作目录及系统提示参数会报错。v1 的 `session/load/set_mode/set_model` 和 Air `_session/steering` 在 v2 中不可用，分别使用恢复、配置和提示队列接口。

自动验证：`node --test test/protocol.test.js test/agent.test.js test/url-elicitation.test.js`；本机 pi 验证：`PI_ACP_SMOKE=1 node --test --test-name-pattern='ACP v2|本机 pi 文件 diff' test/agent.test.js`。协议消息已按上游 Schema 核对，IDEA／其他 v2 客户端的界面展示仍需实机验收。草案后续变更需要重新核对。

## 当前边界

- 历史回放展示当前分支的用户消息、回答、思考和工具记录；v2 压缩事件包含摘要，pi 扩展自定义消息尚未映射为独立的 ACP 展示项。上下文恢复由 pi 原生处理。IDEA 的模型菜单显示 pi 的可用模型，初始模型通过启动参数或 pi 设置选择。
- 文件操作和命令由本机 pi 执行；未接入 ACP `fs/*` 或 `terminal/*`。使用前保存 IDEA 编辑器内容。内置 `edit` 使用 pi 返回的补丁按片段展示 diff；`write` 在授权后捕获旧文本，区分新建与覆盖，并将快照保存在 pi 会话记录中。仅展示不超过 256 KiB 的编辑补丁或写入新旧文本合计；二进制、读取失败、重叠的同文件操作和失败工具只保留原有工具输出。写入快照不受 pi 文件锁保护，外部进程同时修改目标文件可能造成 diff 偏差。旧历史中没有快照的 `write` 无法补回 diff。
- 每轮文件报告仅在客户端协商并请求时扫描工作目录，读取大小、时间戳、权限等元数据，不读取正文。每次快照最多扫描 20000 项或 2 秒，跳过 `.git`，不跟随符号链接；达到限制或读取失败时标注 `truncated: true`，不把未扫描路径误判为新增或删除。重命名报告旧、新两个路径，权限或时间戳变化也可能进入清单。并发外部修改无法归属，轮内新增后删除、目录外和轮次结束后的后台修改可能遗漏，因此保留 `declaredComplete: false`。失败工具已留下的修改可进入正常结束轮次的报告；取消或整轮失败仍沿用 `unavailable`。
- 权限模式不是操作系统沙箱。完全访问自动允许全部工具；标准访问自动允许内置只读工具，其他工具逐次授权；只读与规划模式自动拒绝其他工具。规划模式同时给模型增加只制定计划的指令，但不等价于容器或系统级隔离。选择“本会话允许全部工具”等同于切换完全访问。用户安装的 pi 扩展自身仍属于受信任代码，其直接副作用不属于工具授权边界。
- 客户端声明 ACP form elicitation 时，pi 扩展的 `select`、`input`、`editor` 和普通 `confirm` 会转成结构化表单；客户端未声明时返回取消。v1 通知需客户端声明 notices，v2 可直接转发；状态、widget 和编辑器控制仍不映射到 ACP 展示。
- 图片支持最终取决于所选模型；不支持音频和二进制内嵌资源。资源引用只转发 URI，由 pi 根据可用工具读取。
- 已有归档/列表订阅、结构化计划和长期目标状态管理；goal 不提供自主续跑或预算管理。客户端 `fs/*` / `terminal/*` 执行和完整账户/provider 管理仍未接入；登录复用终端入口。指定消息分叉支持当前分支中的助手消息，保留所在完整回合；分叉来源在父会话仍处于查询范围时发布。详见 [功能对比](docs/功能对比.md)。

## 协议依据

- [ACP v1 总览](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP v2 草案 Schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/bacbb62b5f3181719eecec714e19fdb34a764f75/schema/v2/schema.json)
- [ACP 初始化](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP 会话创建与 MCP](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP 历史会话列表](https://agentclientprotocol.com/protocol/v1/session-list)
- [ACP 提示回合与取消](https://agentclientprotocol.com/protocol/v1/prompt-turn)
- [ACP 工具调用与授权](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [Air steering 扩展约定](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/air-extensions.md#jetbrains-shared-keys)
- [pi RPC 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [pi 扩展官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

子会话与后台任务展示遵循 [Air 原生子会话约定](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/subagent-sessions.md)及 [Air 异步任务约定](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/air-extensions.md#async-tasks)。
