# 本地化维护指南

本仓库以 `upstream/main` 为上游基线，`origin/main` 为唯一维护与发布分支。英文是默认语言和资源基线，简体中文通过 `packages/coding-agent/src/i18n/` 提供覆盖。上游同步、冲突处理、验证和发行门禁以 [MAINTENANCE.md](MAINTENANCE.md) 为准；本文只说明本地化边界。

## 语言行为

- 默认语言为 English（`en`）。
- 在交互 TUI 中使用 `/language` 查看当前语言。
- 使用 `/language en` 或 `/language zh-CN` 切换语言，也接受 `english`、`中文` 等常用别名。
- 选择会写入当前 OMP profile 的 `config.yml`，下次启动继续生效。
- 未翻译的文本保留英文，避免破坏错误详情、模型输出、插件自定义内容和命令参数。

## 同步上游

本仓库使用全量 merge，而不是在合并后挑选保留哪些上游提交。开始前确认工作区干净并记录精确基线：

```powershell
$env:GIT_TERMINAL_PROMPT = "0"
git fetch upstream main --prune --no-tags
git switch main
git status --short
$base = git rev-parse HEAD
$upstream = git rev-parse upstream/main
git diff --stat main...upstream/main
git merge --no-ff --no-commit upstream/main
```

必须在 merge 前保存 `$base`。遇到冲突时以上游业务逻辑、接口、目录结构、依赖和测试语义为准，再重新接入中文资源与适配层；中文分支不保留缺少本地化或 `omp-cn` 发行身份理由的平行业务实现。无法确认时停止并说明双方行为，不能批量选择 `ours` 或 `theirs`。

重点保留并验证：

1. `src/i18n/` 中的语言类型、资源和翻译测试。
2. `config/settings-schema.ts` 中的 `language` 字段和 profile 持久化。
3. `main.ts`、`settings.ts`、命令注册、ACP、UI helper 和设置面板中的本地化调用。
4. `src/distribution.ts`、`fork-release.json`、更新器和安装器中的 `omp-cn` 身份。
5. 上游新增用户可见英文的 fallback，以及 `zh-CN` 资源中的对应翻译。

README、`CONTRIBUTING.md`、`.github/ISSUE_TEMPLATE/`、`CODE_OF_CONDUCT.md`、`SUPPORT.md`、`docs/CONTRIBUTOR_TASKS.md`、`website/` 和 Pages workflow 属于中文分支的社区与传播入口。同步上游时应吸收适用的事实和质量规则，但不得把中文参与入口、`omp-cn` 身份或分支网站覆盖回上游地址。

不要为了中文发行修改 workspace、Cargo 或 native 版本；版本协议见维护文档。

合并和适配后至少执行：

```powershell
bun run ci:check:full
bun test packages/coding-agent/test/i18n.test.ts
bun run ci:test:smoke
git diff --check
```

大范围上游合并还要按 [维护验证矩阵](MAINTENANCE.md#7-路径驱动的验证矩阵) 增加 coding-agent、workspace、Rust/native 和安装测试。没有执行的矩阵必须明确记录为未验证。

## 设置页翻译

设置页的标签、分组、选项和描述来自 `packages/coding-agent/src/config/settings-schema.ts`，对应中文资源集中在 `packages/coding-agent/src/i18n/locales/zh-CN-settings.ts`。设置行使用原始配置值进行交互，同时通过 `SettingItem.valueLabels` 显示本地化值，因此翻译不会把 `true`、`high` 等显示文本写回配置文件。

上游新增设置时，先保留英文 fallback，再补充设置资源；如果新增的是枚举值，同时确认主列表和子菜单都使用中文显示标签。

## 添加翻译

新增用户可见文本时，优先使用 `t()` 的稳定键；对已有的大量英文出口使用 `localizeUiText()` 作为兼容层。英文资源表达默认行为，中文资源只覆盖同一个键或同一条英文 UI 文本。动态错误详情、路径、模型名、插件名和用户输入必须作为变量或 fallback 保持原样。

完成翻译后，使用隔离 profile 验证启动语言、`/language` 切换、命令自动补全描述、设置面板、错误/警告/状态消息，以及非交互模式。不要以会覆盖现有全局 `omp` 的 `bun setup` 作为人工验收前置。
