# omp-cn 分支发行变更

本文件只记录 `omp-cn` 分发层的变更，例如包身份、安装、更新、打包和发布流程。上游功能与修复继续保留在各 workspace 包的 `CHANGELOG.md` 中。

## [Unreleased]

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
