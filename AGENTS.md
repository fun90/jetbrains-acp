# Agent 工作约定

## 项目与开发

- 本项目是连接 JetBrains IDE 与 pi coding agent 的 ACP 适配器，使用 JavaScript ESM，要求 Node.js `22.19.0+`，无需构建。
- `src/` 为适配器，`extensions/acp.ts` 为 pi 扩展，`test/` 和 `fixtures/` 为测试及替身，`registry/jetbrains-pi-acp/agent.json` 为 ACP Registry 清单。
- 默认用简体中文沟通、写注释及提交信息；英文 README 保持英文，并同步维护中英文使用说明。
- 修改前阅读相关实现和调用方，复用现有模式，不引入任务不需要的依赖或抽象。
- 安装依赖用 `npm ci`。普通检查用 `npm test`；涉及 pi 集成或发布时运行 `PI_ACP_SMOKE=1 npm test`，其中 `npm test` 会将项目的 `node_modules/.bin` 加入 PATH，使用锁定的 pi 依赖。
- 冒烟测试使用本地模型替身，不调用远端模型。真实账号登录和 IDE 界面验证需另行说明结果。

## npm 发布

- 包名为 `jetbrains-pi-acp`，仓库为 `fun90/jetbrains-pi-acp`。
- 发布通过 `.github/workflows/publish.yml` 的 GitHub Actions Trusted Publishing（OIDC）执行；保留 npm 2FA，不配置长期发布 token。
- `main` 的推送和面向 `main` 的 PR 只运行检查。推送 `vX.Y.Z` tag 会在检查通过后发布 npm 正式版本到 `latest`，因此推送版本 tag 等同于执行发布。
- 用户要求配置 CI、修改代码或准备版本，不代表授权发布。只有用户明确授权发布时才推送版本 tag；已有发布授权时不重复索要确认。
- 发布前阅读 `docs/publishing.md`，同步 `package.json`、`package-lock.json`、Registry 清单和使用示例中的版本。不要为了验证流水线发布无意义的新版本。
- 发布前运行测试及 `npm pack --dry-run`，确认包内不含凭据、测试和临时文件，报告版本、主要变更和检查结果。
- 已授权发布时，提交并推送待发布代码，再对该提交创建并推送与 `package.json` 一致的 `vX.Y.Z` tag；当前流程仅支持正式版本。
- 通过 `gh run list`、`gh run watch` 检查对应 tag 的运行结果，再使用 `npm view jetbrains-pi-acp@X.Y.Z version dist.integrity` 和 `npm view jetbrains-pi-acp dist-tags --json` 核对 registry。
- 发布超时或结果不明时，先核对 workflow 和 npm registry，不盲目重试、不移动已发布 tag、不覆盖已发布版本。

## 认证与配置边界

- npm 的 Trusted Publisher 必须绑定 `fun90/jetbrains-pi-acp` 和 `publish.yml`，当前 workflow 不使用 GitHub Environment，npm 对应字段也应留空。
- 首次绑定或更改 npm 信任关系可能需要维护者完成交互式 2FA；说明阻塞原因和准确操作，不循环重试认证。
- 不读取或输出 `.npmrc` 中的凭据，不把 token、OTP、恢复码或 2FA 密钥写入代码、文档或日志。
- 不为解决认证问题关闭 2FA、创建绕过 2FA 的发布 token，或擅自调整包维护者和访问权限。
- `npm publish --dry-run`、`npm whoami` 和本地测试不能证明 CI 的 OIDC 发布权限有效；只有真实 CI 发布成功才能完成端到端验证。
