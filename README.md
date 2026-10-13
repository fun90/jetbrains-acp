# IDEA 与 pi 的 ACP 适配器

通过 ACP v1 将 IntelliJ IDEA 的聊天界面连接到本机 pi coding agent。

```text
IDEA / AI Assistant ← ACP JSON-RPC / stdio → pi-acp ← RPC JSONL → pi
```

使用 Node.js 标准库，无第三方依赖、无需构建。开发及真实启动验证基于 pi `1.1.0`。

## 快速使用

1. 安装 Node.js 22 或更高版本及 pi。先在终端运行 `pi`，完成模型提供商的登录或 API Key 配置，确认能正常聊天。适配器继承 pi 的用户配置和环境变量。
2. 在本项目目录生成适合当前机器的 IDEA 配置：

   ```bash
   npm run --silent config
   # pi 不在 PATH 时，显式传入路径：
   npm run --silent config -- /绝对路径/pi
   ```

3. 在 IDEA 的 AI Chat 中选择 **Add Custom Agent**，将生成的 `agent_servers.pi` 条目合并到 `~/.jetbrains/acp.json`，保留已有条目。也可参考 [examples/acp.json](examples/acp.json)。
4. 在聊天界面选择 `pi`，发送消息。默认使用“完全访问”，自动允许工具调用。需要逐次授权时，将权限模式切换为“标准访问”；弹窗支持“允许本次”“本会话允许全部工具”和“拒绝本次”。

需要支持 ACP 的 JetBrains IDE 与 AI Assistant 插件；菜单位置随版本变化，见 [JetBrains 官方配置说明](https://www.jetbrains.com/help/ai-assistant/acp.html)。配置生成命令只打印 JSON，不修改 IDE 配置。

## 指定模型

把 `--` 及后续 pi 参数加在 IDEA 配置的 `args` 末尾，例如：

```json
["/绝对路径/jetbrains-acp/src/index.js", "--pi-command", "/绝对路径/pi",
 "--", "--model", "openai/你的模型ID", "--thinking", "medium"]
```

`--` 后传递 pi 的配置选项，不传递初始提示、交互模式或会话选择参数。适配器统一指定 `--mode rpc`、`--no-session` 和自己的扩展。也可使用 `PI_ACP_PI_COMMAND` 环境变量指定 pi 可执行文件。IDEA 启动时的 PATH 可能与终端不同，推荐使用生成的绝对路径。

## 已实现的协议功能

| ACP 功能 | 行为 |
| --- | --- |
| `initialize` | 协商 v1，返回实际支持的能力 |
| `session/new` | 每个会话启动独立 pi 进程，使用 IDEA 传入的绝对 `cwd` |
| 模型列表与切换 | 返回 `configOptions` 与兼容旧版的 `models`；支持 `session/set_config_option` 和 `session/set_model` |
| 推理级别 | 通过 `thought_level` 配置选项连接 pi 的推理设置；模型切换后刷新可用级别与实际值 |
| 权限模式 | 默认完全访问，支持标准访问；同时兼容 `session/set_mode` 与 `session/set_config_option` |
| `session/prompt` | 转发文本、内嵌图片、文本资源和资源引用 |
| `session/update` | 转发回答、思考内容、工具状态与工具输出 |
| `session/cancel` | 解除待授权请求、清空 pi 队列并中止执行 |
| `session/request_permission` | pi 扩展在工具执行前阻塞，等待 IDEA 的授权结果 |
| MCP | 转发 stdio 和 HTTP 配置；不支持 SSE |

提示接收成功不等于执行完成。适配器等到 pi 的 `agent_settled` 才返回 `stopReason`；取消返回 `cancelled`，模型长度限制返回 `max_tokens`，模型或进程失败返回 JSON-RPC 错误。同一会话拒绝并发提示，不同会话相互独立。stdout 只输出 ACP JSONL，诊断写到 stderr。

启动会话时会检查 ACP 扩展是否加载成功；授权扩展不可用会导致会话创建失败。MCP 配置写入权限为 `0600` 的临时文件，在适配器退出时删除，不修改用户的 pi 配置。IDEA 传入的 MCP 由 pi 原生 MCP 扩展连接，需要保持该扩展启用。

## 验证

```bash
npm test
# 使用本机 pi 验证实际启动与扩展握手，不调用模型：
PI_ACP_SMOKE=1 npm test
```

自动测试使用可控的 pi RPC 替身，覆盖握手、流式输出、真正完成时机、授权允许/拒绝/取消、并发提示、进程退出、MCP 转换及 Unicode JSONL 分帧。

## 当前边界

- 会话只在适配器运行期间保留；未实现 `session/load` 和历史恢复。IDEA 的模型菜单显示 pi 的可用模型，初始模型通过启动参数或 pi 设置选择。
- 文件操作和命令由本机 pi 执行；未接入 ACP `fs/*` 或 `terminal/*`。使用前保存 IDEA 编辑器内容，工具状态中会提供文件位置，但尚未生成 ACP 文件 diff。
- 工具授权不是操作系统沙箱。完全访问自动允许全部工具，包括写文件、执行命令和 MCP 调用；标准访问自动允许内置 `read`、`grep`、`find`、`ls`，其他工具每次请求授权。选择“本会话允许全部工具”等同于切换完全访问；模式只影响当前会话，新会话默认完全访问。用户安装的 pi 扩展自身仍属于受信任代码，扩展直接执行的副作用不属于此工具授权边界。
- 一般 pi 扩展的 `select`、`input`、`editor`、自定义 `confirm` 交互会返回取消，并在当前回合提示不支持；只桥接本适配器的工具授权对话框。
- 图片支持最终取决于所选模型；不支持音频和二进制内嵌资源。资源引用只转发 URI，由 pi 根据可用工具读取。
- 已验证协议流程及本机 pi 启动；IDEA 界面联调、真实模型执行和真实 MCP 服务器调用需要在目标环境验证。

## 协议依据

- [ACP v1 总览](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP 初始化](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP 会话创建与 MCP](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP 提示回合与取消](https://agentclientprotocol.com/protocol/v1/prompt-turn)
- [ACP 工具调用与授权](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [pi RPC 官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [pi 扩展官方文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
