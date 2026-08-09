# 可认领的维护任务

本页为第一次参与 oh-my-pi-cn 的开发者提供低风险、可独立完成的任务方向。开始前请先搜索 [现有 Issues](https://github.com/yequ172672/oh-my-pi-cn/issues)，避免重复工作；准备认领时在对应 Issue 留言，或创建一份范围明确的 Pull Request。

## 中文本地化

### 排查仍然显示英文的界面文本

在隔离 profile 中依次检查首次启动、设置、模型选择、供应商登录、错误提示、更新提示和 `/changelog`。记录可复现路径，并只修复能够确认属于应用 UI 的文本；模型输出、插件内容、命令和动态错误详情应保留原文。

**适合标签：** `good first issue`、`i18n`、`help wanted`

### 校对现有中文表达

寻找逐字翻译、术语不一致或在窄终端中难以阅读的文本。Pull Request 中同时给出原文、现有译文和建议译文，并截图验证实际显示。

**适合标签：** `good first issue`、`i18n`

## 安装与平台验证

### 验证一种干净环境安装路径

选择 Windows、macOS、Ubuntu、WSL 或 Alpine，在未安装官方 `omp` 的隔离环境中验证安装、`omp --version`、`omp --help` 和 `omp --smoke-test`。不要在报告中包含用户名、个人路径或令牌。

**适合标签：** `testing`、`installer`、`help wanted`

### 验证从官方包迁移到 omp-cn

在可丢弃环境中安装官方包，再按 README 指引卸载并安装 `omp-cn`。确认最终命令来源、版本和更新路径都属于中文分支。

**适合标签：** `testing`、`installer`

## 文档与演示

### 为一个常见供应商补充中文配置示例

选择一个现有供应商，验证登录或 API 配置流程，并补充不包含密钥的最小中文示例。优先改进用户真正会卡住的步骤，不重复上游已有的大段说明。

**适合标签：** `documentation`、`good first issue`

### 制作短演示或截图

展示安装、语言切换、模型选择或一次真实编码任务。素材中不得出现 API Key、账号、私人仓库、用户目录或会话隐私；成品应允许项目在 README 和网站中引用。

**适合标签：** `documentation`、`help wanted`

## 上游同步与质量

### 审查一次上游更新中的用户可见文本

对比上游新版本，列出新增或改变的用户可见英文，判断哪些需要中文资源、哪些应保留动态原文。不要直接维护与上游平行的业务实现。

**适合标签：** `upstream-sync`、`i18n`

### 复核一个现有 Issue 的可复现性

使用与报告者不同的平台或安装方式复现问题，补充精确版本、最小步骤和结果。无法复现也有价值，但应说明环境差异和已排除的条件。

**适合标签：** `testing`、`help wanted`

## 提交前

阅读 [参与贡献](../CONTRIBUTING.md) 和 [本地化维护指南](LOCALIZATION.md)。每个 Pull Request 只解决一个任务，并报告真实验证结果。用户可见变更需要在 `docs/FORK_CHANGELOG.md` 的 `[Unreleased]` 中增加条目。
