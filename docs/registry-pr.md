新增 `jetbrains-pi-acp`，通过 ACP 将 JetBrains IDE 等客户端连接到 pi coding agent。

- 使用 npm 包 `jetbrains-pi-acp@0.1.4` 分发，固定依赖 pi `1.3.0`，无需全局安装 pi。
- 支持 ACP v1/v2、会话历史、权限控制、文件 diff、子 agent 和后台任务；扩展功能按客户端能力协商。
- 客户端支持时在 `initialize` 中声明终端认证，通过 `--setup` 启动 pi，再执行 `/login` 登录模型提供商。
- 使用 MIT 许可证，提供 16×16、`currentColor` 单色 SVG 图标，以及中英文 README。
- `0.1.3` 将依赖的 pi 升级到 `1.3.0`；报错、斜杠命令、授权选项、文件报告等全部界面文案按系统语言显示中文或英文，发给模型的工具描述与系统提示统一为英文；模型名称不再附带 provider 后缀；内部按职责拆分 agent 模块，协议行为不变。
- `0.1.4` 将终端 stdin 桥接限制为模型显式传入 `interactive: true` 的 `bash/powershell` 调用；其他命令使用 `/dev/null`，避免误读 stdin 时卡住。

源码：https://github.com/fun90/jetbrains-pi-acp
npm：https://www.npmjs.com/package/jetbrains-pi-acp

`0.1.4` 发布与验证状态：

- `PI_ACP_SMOKE=1 npm test`：139 项全部通过。
- 普通测试：127 项通过，12 项按默认配置跳过。
- 包内容检查通过（26 个文件），包含中英文 README，不包含测试或本地 `.pi` 文件。
- 在项目外独立目录安装本地发布包，`--help` 与 ACP `initialize` 握手成功。
- 已发布包 SHA-1 与本地发布包一致：`76b774f4d3593c2976685edfbfc57f5feada7632`；npm `latest` 已指向 `0.1.4`。
- 在空目录通过 `npx --yes jetbrains-pi-acp@0.1.4` 从 npm 启动，握手返回版本 `0.1.4` 与认证方式 `pi-login(terminal)`。
- 官方构建脚本离线校验通过：`SKIP_URL_VALIDATION=1 build_registry.py --agents jetbrains-pi-acp`。本机 DNS 将 npm 域名解析为保留网段（`198.18.0.90`、`2001:2::5a`），在线 URL 校验被脚本的地址安全检查拦截，以本 PR 的 CI 结果为准。
- 官方 `verify_agents.py --auth-check` 本次未重新执行（本机无 Docker/uv）；`0.1.2` 在 Linux x86_64 下通过，返回 `Auth OK: pi-login(terminal)`，认证流程未改动。

与现有 `pi-acp` 及其他 JetBrains pi 适配器为不同项目，使用独立 Registry ID 和 npm 包名。

尚未验证真实提供商账号登录及 Windows 实机。
