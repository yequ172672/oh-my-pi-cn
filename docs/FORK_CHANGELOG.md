# omp-cn 分支发行变更

本文件只记录 `omp-cn` 分发层的变更，例如包身份、安装、更新、打包和发布流程。上游功能与修复继续保留在各 workspace 包的 `CHANGELOG.md` 中。

## [Unreleased]

### 修复

- 修复 Windows 二进制安装器在替换现有 `omp.exe` 时因空备份路径失败的问题。

## [17.3.5] - 2026-08-17

### 新增

- 同步上游 17.3.5，纳入 Nix flake、包重命名迁移、并发二进制更新保护，以及最新的 agent、TUI、provider 和原生能力改进。

### 变更

- 中文分叉的应用版本继续由 `fork-release.json` 独立管理，同时复用上游 17.3.5 的 workspace 与 native 包。

### 修复

- 修复上游同步后普通分支验证错误地要求当前 workspace 版本与上一已发布分叉版本一致的问题。
- 修复 ACP、更新器和 changelog 测试混淆 `omp-cn` 应用版本与上游 workspace 版本的问题。
- 修复未准备新发行时，CI 尝试把最新源码打包成旧版 `omp-cn` 制品的问题。
## [17.2.13] - 2026-08-11

### 新增

- 增加面向搜索、安装和贡献者招募的 GitHub Pages 项目网站，以及独立的 Pages 发布流程和社交分享图。
- 增加中文贡献指南、社区行为规范、支持入口、可认领维护任务和中文 Issue/PR 模板。
- 增加 Google Search Console 所有权验证合同，用于提交 sitemap 和监控搜索收录状态。
- 增加“使用现有 Codex CLI 登录”入口，通过本机 Codex App Server 复用 ChatGPT 订阅的短期访问令牌，并由 Codex 独占刷新凭据的存储与轮换。

### 变更

- GitHub 仓库启用 Issues 与 Discussions，并补充统一的项目简介和技术主题标签。
- 更新 GitHub Actions 缓存步骤到 Node.js 24 兼容版本，消除即将失效的 Node.js 20 运行时警告。

### 发行

- 稳定版 Release 暂时只构建并发布经过原生 Windows runner 验证的 Windows x64 二进制；macOS 和 Linux 用户继续通过 Bun/npm 安装 `omp-cn`。
## [17.2.12] - 2026-08-09

### 新增

- 增加带 schema 版本的分支发行元数据、真实 tarball 校验和隔离安装 smoke 门禁。
- 增加 `omp-cn-v<version>` 专属标签、原子 Git 推送、GitHub 托管验证和 fork-only 发布状态机。

### 变更

- `omp-cn` 版本现在与上游 workspace/native 版本独立管理，GitHub 默认维护与发布分支统一为 `main`。
- 安装器在自动模式下检测到匹配 Bun 时直接安装 `omp-cn`；没有 Bun 时才校验 Release 二进制的 SHA-256 和精确版本，资产不可用时安装 Bun 并回退 npm，显式 binary/source 模式保持各自语义。

### 修复

- 修复 fork 更新器把 `omp-cn` 目标版本错误用于 native core/平台包、从而请求不存在版本的问题。
- 修复源码安装从临时单包目录解析 `catalog:` 失败或删除目录后破坏全局链接的问题。
- 修复源码-only GitHub Release 缺少二进制资产时，无 Bun 新机器的默认安装路径直接失败的问题。
- 补充 17.2.12 新增交接失败原因的中文提示，同时保留未知提供商错误的原始诊断信息。
