# GitHub Actions 桌面安装包流程

## 目标与边界

GitHub 侧只负责“把分支/PR 的变更打成可安装的桌面测试包”，并支持用 tag 生成 GitHub Release。它不替代仓库现有的 GitLab 正式发布链路：

- 不写 OSS/CDN，不生成或覆盖 `latest*.yml` 更新源，不调用后端 release/gray 接口。
- 不执行签名与公证。所有产物都是未签名包，适合内部分发和回归验收。
- 不改变应用运行时协议、后端选择逻辑或发布版本号规则。

正式发布仍以 [Desktop CI/CD](../desktop-ci-cd.md) 为准。

## 文件职责

| 文件                                         | 职责                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `.github/workflows/desktop-build.yml`        | 矩阵调度、平台依赖安装、构建、产物上传与 GitHub Release 发布             |
| `.github/workflows/ci.yml`                   | 轻量质量门禁：`typecheck`、`lint`、工程工具测试                          |
| `scripts/ci/desktop-build-plan.mjs`          | 触发方式 → 平台矩阵 / 构建画像 / 是否发布的唯一判定点                    |
| `scripts/ci/collect-desktop-artifacts.mjs`   | 从 `packages/desktop/dist` 收敛安装包，生成 `build-info-*.json` 与校验和 |
| `scripts/test/desktop-ci-artifacts.test.mjs` | 上述两个脚本的回归测试，随 `pnpm test:engineering-tools` 执行            |

workflow 中不写平台分支和发布规则；新增平台、调整默认矩阵或改发布策略时只改计划脚本并补测试。

## 触发规则

| 触发                     | 条件                                   | 平台                                      | 构建画像     | 产物去向                     |
| ------------------------ | -------------------------------------- | ----------------------------------------- | ------------ | ---------------------------- |
| PR 到 `main` / `dev`     | PR 带 `desktop-build` 标签             | `macos-arm64`、`windows-x64`              | `production` | Actions artifact，保留 7 天  |
| 分支 push `main` / `dev` | 命中 `paths` 过滤                      | `macos-arm64`、`windows-x64`、`linux-x64` | `production` | Actions artifact，保留 14 天 |
| tag `v*`                 | tag 必须等于 `v<package.json version>` | 上述三平台 + `macos-x64`                  | `production` | GitHub Release + artifact    |
| `workflow_dispatch`      | 手动填写平台与画像                     | 输入值（默认同上三平台）                  | 输入值       | Actions artifact             |

- PR 未打 `desktop-build` 标签时 workflow 仍然触发，但 `plan` 会明确输出跳过原因，不占用 macOS/Windows runner。
- 分支 push 的 `paths` 过滤只覆盖构建相关目录（`apps/`、`packages/`、`scripts/`、`config/` 等）；tag push 不受该过滤影响。
- 同一 ref 的 PR/dispatch 构建会取消旧任务；tag 与分支 push 不取消进行中的构建。

## 平台矩阵

矩阵由 `PLATFORM_CATALOG` 固定，runner 标签不使用 `-latest`，避免镜像迁移改变构建基线：

| 平台标识        | 目标 OS/Arch  | runner             | 默认参与      |
| --------------- | ------------- | ------------------ | ------------- |
| `macos-arm64`   | mac / arm64   | `macos-15`         | PR、分支、tag |
| `macos-x64`     | mac / x64     | `macos-15-intel`   | tag           |
| `windows-x64`   | win / x64     | `windows-2025`     | PR、分支、tag |
| `windows-arm64` | win / arm64   | `windows-11-arm`   | 仅手动        |
| `linux-x64`     | linux / x64   | `ubuntu-22.04`     | 分支、tag     |
| `linux-arm64`   | linux / arm64 | `ubuntu-22.04-arm` | 仅手动        |

Linux 打包 job 需要 `rpm`、`xz-utils` 与 `libarchive-tools`（pacman 目标），workflow 在构建前安装；Windows job 会打开 `core.longpaths`。`windows-arm64` 与 `linux-arm64` 仅保留手动入口，未纳入默认验证，首次使用前应先单独触发确认原生依赖可用。

## 构建画像

安装身份与后端环境是两个轴，由画像同时决定：

| 画像                 | `ZCODE_ENV`  | `ZCODE_PREVIEW_IDENTITY` | 应用身份        | 产物文件        |
| -------------------- | ------------ | ------------------------ | --------------- | --------------- |
| `production`（默认） | `production` | `0`                      | `ZCode`         | 无 `_TEST` 后缀 |
| `preview-production` | `production` | `1`                      | `ZCode Preview` | 无 `_TEST` 后缀 |
| `preview-test`       | `test`       | `0`                      | `ZCode Preview` | 带 `_TEST` 后缀 |

默认使用 `production`：本仓库是官方开源版的修改版，产物就是 `ZCode`。它和系统内官方安装共享 appId，安装会覆盖/替换官方版本，且自动更新仍指向官方 feed；需要与官方版并排安装、避免被自动更新覆盖时，手动触发 `preview-production` 或 `preview-test`。

## 版本与 tag

- 版本号唯一来源是根目录 `package.json`。分支/PR 构建沿用当前版本，产物通过身份和后缀区分，不做版本号改写。
- tag 必须是 `v<package.json version>`，否则 `plan` 直接失败，避免安装包文件名、应用版本与 Release 标题不一致。
- 发版流程：PR 中提升 `package.json` 版本 → 合并到 `main` → 打 tag `v<version>` → workflow 构建四平台并创建 GitHub Release。

## 产物与校验

每个平台 job 在打包后执行 `collect-desktop-artifacts.mjs`：

- 只保留可安装文件：macOS `.dmg`/`.zip`，Windows `.exe`，Linux `.AppImage`/`.deb`/`.rpm`/`.pkg.tar.zst`。
- 文件名必须匹配当前画像的 `<productName>-<version>-` 前缀；`preview-test` 还要求带 `_TEST`。这样重复构建时 `dist` 里上一次其他身份的残留包不会被带进 artifact。
- `build-info-<platform>.json`：平台、画像、版本、产物名称/大小/SHA-256，以及 `out/metadata/build-meta.json` 中的提交与构建时间。
- `SHA256SUMS-<platform>`：安装包校验和。

Release job 汇总所有平台产物，合并为单个 `SHA256SUMS` 后创建或更新 GitHub Release。找不到安装包时收集脚本直接失败，不会上传空 bundle。

## 缓存与并发

- pnpm store 由 `actions/setup-node` 的 `cache: pnpm` 复用。
- Electron 与 electron-builder 二进制按平台分别缓存，key 由 `pnpm-lock.yaml` 和桌面包 `package.json` 计算。
- GitHub runner 位于境外机房，`ELECTRON_MIRROR` 指向 Electron 官方 Release，不使用 `mise.toml` 中给本地开发准备的内网镜像。

## 未覆盖项：签名与公证

GitHub 产物默认未签名。macOS 首次打开需要在“系统设置 → 隐私与安全性”中放行，或执行 `xattr -dr com.apple.quarantine <App>`；Windows 会触发 SmartScreen 提示。

如需在 GitHub 侧补齐签名，需要额外引入：

1. macOS 证书 `p12`（Base64）与密码，导入临时 Keychain 后设置 `APPLE_SIGNING_IDENTITY` 与 `ZCODE_ENABLE_MAC_SIGN=1`。
2. Apple 公证凭据（`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`），并复用仓库现有的公证脚本。
3. Windows 代码签名证书与 `electron-builder` 的 `CSC_LINK` / `CSC_KEY_PASSWORD`。

签名链路未纳入当前流程，避免 workflow 在缺少密钥时静默生成未签名包却被误认为已签名。

## 本地复现

```bash
pnpm install --frozen-lockfile
node packages/desktop/scripts/bundle.mjs --os mac --arch arm64
node scripts/ci/collect-desktop-artifacts.mjs --platform macos-arm64
```

只验证调度规则时可以离线执行：

```bash
EVENT_NAME=pull_request PR_LABELS=desktop-build node scripts/ci/desktop-build-plan.mjs
```

## 验证

- `pnpm test:engineering-tools`：覆盖 tag 版本校验、PR 标签门禁、平台/画像解析、安装包收集与空产物失败。
- `pnpm lint`、`pnpm typecheck`：CI 门禁与本地一致。
- 首次在仓库启用 Actions 后，建议先手动触发一次单平台构建（例如 `linux-x64`）确认 runner 镜像与下载链路。
