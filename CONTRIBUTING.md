# 参与贡献

感谢你愿意帮助维护 **oh-my-pi-cn / omp-cn**。本仓库是
[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 的简体中文本地化分支：
上游负责核心产品演进，本分支重点维护中文界面、中文文档、供应商配置说明、安装更新体验和跨平台验证。

第一次参与时，不需要理解整个代码库。可以先从
[待认领的维护任务](docs/CONTRIBUTOR_TASKS.md) 或带有 `good first issue`、`help wanted` 标签的任务开始。

## 在哪里交流

- 使用 [Discussions](https://github.com/yequ172672/oh-my-pi-cn/discussions) 提问、讨论想法、展示使用方式；
- 使用 [Issues](https://github.com/yequ172672/oh-my-pi-cn/issues) 报告可复现的问题或记录已明确范围的工作；
- 提交代码、翻译或文档时直接创建 Pull Request；
- 安全漏洞不要公开提交 Issue，请按 [安全政策](.github/SECURITY.md) 私下报告。

如果你已经准备实现一个小型本地化或文档改动，不必先创建 Issue；在 Pull Request 中说明问题和验证方式即可。大范围核心行为、依赖或架构改动，应优先在上游讨论和实现。

## 适合本分支的贡献

- 补充遗漏或不自然的简体中文翻译；
- 改进中文设置、首次启动、供应商配置和错误提示；
- 验证 Windows、macOS、Linux、WSL、Alpine 等安装路径；
- 改进中文文档、示例、截图和演示；
- 检查上游同步后新增的用户可见英文；
- 修复 `omp-cn` 打包、安装、更新或 Release 流程；
- 帮助复现、分类和验证现有 Issue。

核心功能缺陷如果同样存在于上游，应优先向上游提交修复。本分支可以保留必要的中文适配，但不维护缺少本地化或发行身份理由的平行业务实现。

## 开始之前

1. Fork 本仓库并从最新 `main` 创建分支。
2. 阅读 [本地化维护指南](docs/LOCALIZATION.md)，确认改动属于本分支维护范围。
3. 搜索现有 Issue 和 Pull Request，避免重复工作。
4. 保持一次 Pull Request 只解决一个明确问题。
5. 不要提交密钥、账号信息、个人路径、构建缓存或无关生成文件。

## 本地开发

需要 Bun 1.3.14 或更高版本。安装依赖：

```sh
bun install --frozen-lockfile
```

常用验证命令：

```sh
bun run ci:check:full
bun test packages/coding-agent/test/i18n.test.ts
bun run ci:test:smoke
git diff --check
```

验证范围应与改动风险匹配：

| 改动 | 至少验证 |
| --- | --- |
| 中文资源或 UI 文案 | i18n 测试，并在隔离 profile 中查看实际界面 |
| README、网站、贡献文档 | 链接、移动端布局、安装命令和公开文案 |
| 安装器或发布脚本 | 对应脚本测试、隔离安装及 smoke test |
| 上游大范围同步 | [维护验证矩阵](docs/MAINTENANCE.md#7-路径驱动的验证矩阵) |

不要用已有的全局 `omp` 作为唯一验证对象。涉及交互界面时使用隔离 profile，避免覆盖个人配置。

## 翻译约定

- 保留命令、参数、模型名、供应商名、路径和错误详情中的必要原文；
- 中文表达优先清晰、自然，不逐字翻译；
- 新增用户可见文本时保留英文 fallback；
- 不修改已经发布的上游 Changelog；中文发行说明写入 `docs/FORK_CHANGELOG.md`；
- 不直接修改生成文件 `packages/catalog/src/models.json`。

详细规则见 [本地化维护指南](docs/LOCALIZATION.md)。

## AI 辅助贡献

可以使用 AI 工具，但提交者必须理解并负责全部改动。提交前请：

- 检查每个修改文件，删除无关变化；
- 运行与改动对应的测试；
- 亲自验证用户能够观察到的结果；
- 不提交代理对话、内部计划或未经核实的生成内容。

## Pull Request 要求

Pull Request 请包含：

- 你本人写的一段“改了什么、为什么”；
- 具体的验证场景、命令和结果；
- 用户可见变化的截图或终端输出（适用时）；
- 关联 Issue（如果存在）；
- 用户可见变更对应的 `docs/FORK_CHANGELOG.md` 条目。

维护者会重点检查行为是否正确、改动是否属于本分支边界，以及验证证据是否覆盖真实使用路径。贡献者无需追求大改动；边界清楚、可验证的小改动更容易合并。
