# 添加 JetBrains pi ACP

新增 `jetbrains-pi-acp` 条目，为 JetBrains IDE 等 ACP 客户端提供 pi coding agent 适配器。

- 通过 `jetbrains-pi-acp@0.1.1` npm 包分发，安装时同时安装 pi `1.2.0`，无需全局 pi。
- 支持 ACP v1/v2、历史会话、权限控制、文件 diff、子会话和后台任务；扩展功能按客户端能力协商。
- 按客户端能力声明终端认证；用户通过 `--setup` 启动 pi 并执行 `/login`。
- 使用 MIT 许可证，附带 16×16、`currentColor` 单色 SVG 图标。

源码：https://github.com/fun90/jetbrains-pi-acp

现有收录申请：https://github.com/agentclientprotocol/registry/pull/691

与现有 `pi-acp` 为不同项目，使用独立 ID 和包名。后续版本沿用此 PR，先发布 npm，再更新 Registry 清单并执行官方在线校验与安装认证检查。

`0.1.1` 本地验证：

- `PI_ACP_SMOKE=1 npm test`：133 项全部通过。
- npm 打包检查通过，包含中英文 README，不包含测试和本地 `.pi` 文件。
- 修复完全访问模式下无 ACP 前台回合的 remote-pi 工具调用被取消的问题，测试覆盖其他权限模式与取消限制。

`0.1.0` 已通过官方 Registry 在线构建校验，以及 Linux x86_64 下从 npm 启动的 `pi-login(terminal)` 认证检查。新版本需要重新执行这两项检查；结果记录在 PR 正文中。

尚未验证真实提供商账号登录及 Windows 实机。
