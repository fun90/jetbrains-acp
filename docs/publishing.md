# 发布到 npm 与 ACP Registry

当前发布版本为 `0.1.0`，包名和 Registry ID 均为 `jetbrains-pi-acp`。这些文件只是待发布材料，不代表 npm 发布或 Registry 收录已经完成。

## 发布前验证

需要 Node.js `22.19.0` 或更高版本。

```bash
npm ci
npm test
PI_ACP_SMOKE=1 npm test
npm pack --dry-run
npm pack
```

普通测试使用本地替身；`PI_ACP_SMOKE=1` 的真实 pi 测试还需要 PATH 中有 pi，或设置 `PI_ACP_PI_COMMAND` 为外部 pi 的绝对路径，测试使用本地模型替身，不调用远端模型。

检查包文件列表：应包含 `src/`、`extensions/`、`scripts/`、`examples/`、`package.json`、README 和许可证，不应包含测试、临时文件、IDE 配置或用户凭据。pi `1.2.0` 与 `typebox` 作为 npm 依赖安装，不嵌入压缩包。固定 pi 版本可避免其接口更新直接破坏适配器。

在项目外的空目录安装生成的压缩包，再通过安装后的命令验证，避免错误地使用源码或全局 pi：

```bash
npm install /绝对路径/jetbrains-pi-acp/jetbrains-pi-acp-0.1.0.tgz
./node_modules/.bin/jetbrains-pi-acp --help
./node_modules/.bin/jetbrains-pi-acp --setup
```

在 pi 终端中输入 `/login` 选择模型提供商，登录完成后退出。API Key 与 OAuth 的存储、更新和退出均由 pi 处理，适配器不另存凭据。v2 的 `auth/logout` 关闭当前连接的会话并阻止该连接继续使用，需要重新连接；提供商凭据仍由用户在 pi 的 `/logout` 中管理。`--setup` 使用交互终端，不是无界面的登录命令；退出后通过 IDE 建立新会话验证实际模型调用。

登录入口透传 pi 的退出码，不独立校验凭据：直接退出 pi 也可能返回成功状态，因此应先完成 `/login`，再退出。当前不自动选择提供商、不发起付费模型调用验证密钥。

默认启动随依赖安装的 pi，不依赖全局 `pi`。如需外部版本，使用 `--pi-command /绝对路径/pi` 或 `PI_ACP_PI_COMMAND`。终端认证按客户端能力协商：v1 支持 `auth.terminal: true` 或旧 `_meta["terminal-auth"]: true`，v2 支持 `auth.terminal: {}`。标准认证描述通过 `PI_ACP_SETUP=1` 保留原始启动参数，旧扩展则返回完整的替换参数。自定义版本需要自行验证兼容性。

## 发布 npm 包

确认当前版本、包名使用权、MIT 许可证和版权信息后执行：

```bash
npm login
npm publish --access public
npm view jetbrains-pi-acp@0.1.0 version
npx --yes jetbrains-pi-acp@0.1.0 --setup
```

`prepublishOnly` 会运行 `npm test`。npm 如要求双重认证，按其提示完成。发布前应将源码、许可证和文档同步到公开 GitHub 仓库，使清单中的链接可访问。Git 提交、推送和 npm 发布均由维护者单独执行。

## 提交 Registry 收录

1. Fork 并克隆 [官方 Registry](https://github.com/agentclientprotocol/registry)。
2. 将本项目的 `registry/jetbrains-pi-acp/` 整个目录复制到该仓库根目录。
3. 确认 npm 版本已发布，`license_url` 指向的文件已公开。
4. 在 Registry 仓库运行官方校验：

   ```bash
   uv run --with jsonschema .github/workflows/build_registry.py
   python3 .github/workflows/verify_agents.py --auth-check --agent jetbrains-pi-acp
   ```

5. 提交 PR，可使用 [PR 文案](registry-pr.md)，等待维护者审核。

清单锁定 npm 的具体版本；`icon.svg` 为 16×16、使用 `currentColor` 的单色图标。`pi-acp` 已是其他项目的 ID，本项目使用独立 ID。

尚未发布 npm 或许可证时，只能执行离线结构校验，不能声称 URL 可访问性和从 npm 安装的官方认证校验已经通过。官方构建脚本支持通过 `SKIP_URL_VALIDATION=1` 跳过 URL 检查。

## 后续升级

更新 `package.json`、`package-lock.json` 和 `registry/jetbrains-pi-acp/agent.json` 中的版本，重新测试并发布。握手中的 Agent 名称和版本直接读取 `package.json`。官方 Registry 会定时检查 npm 新版本；描述、图标、分发方式等变更仍需提交 PR。

首次发布不包含二进制发行包、自动发布流水线或预览通道。Windows 和 Linux 需要实机验证，尤其是 shell 与终端行为。

规范依据：[提交要求](https://github.com/agentclientprotocol/registry/blob/main/CONTRIBUTING.md)、[认证要求](https://github.com/agentclientprotocol/registry/blob/main/AUTHENTICATION.md)、[清单 Schema](https://github.com/agentclientprotocol/registry/blob/main/agent.schema.json)。
