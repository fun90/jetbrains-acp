# 添加 JetBrains pi ACP

新增 `jetbrains-pi-acp` 条目，为 JetBrains IDE 等 ACP 客户端提供 pi coding agent 适配器。

- 通过 `jetbrains-pi-acp@0.1.0` npm 包分发，安装时同时安装 pi `1.2.0`，无需全局 pi。
- 支持 ACP v1/v2、历史会话、权限控制、文件 diff、子会话和后台任务；部分功能需要客户端协商扩展能力。
- 按客户端能力在 `initialize` 中声明 `terminal` 认证方式；客户端按返回参数启动 `--setup`，用户在 pi 中输入 `/login`，完成后退出并返回 IDE。
- 使用 MIT 许可证，附带 16×16、`currentColor` 单色 SVG 图标。

源码：https://github.com/fun90/jetbrains-pi-acp

与现有 `pi-acp` 为不同项目，使用独立 ID 和包名。

已在 macOS 上完成本地验证：

- 官方 `build_registry.py --agents jetbrains-pi-acp` 离线校验通过（`SKIP_URL_VALIDATION=1`），包含 Schema、版本和图标检查。
- npm 压缩包安装到项目外目录后，通过官方 `client.run_auth_check` 认证握手检查。
- PATH 不含全局 pi 时，仍可创建和关闭真实 pi 会话并加载 ACP 扩展。
- 实际终端能够打开 pi `/login` 认证菜单。
- `PI_ACP_SMOKE=1 npm test` 共 127 项全部通过；Node.js `22.19.0` 下 6 项 CLI 测试通过。
- `npm publish --dry-run --ignore-scripts` 发布预演通过，未实际上传。

提交 PR 前仍需先发布 npm 包、公开许可证文件，再运行官方完整 URL 与 npm 安装认证校验。尚未验证真实账号 OAuth/API Key 登录及 Windows/Linux 实机。
