# 中文分支长期维护与发布流程

本文是 `yequ172672/oh-my-pi-cn` 的规范维护流程。目标是让每次上游同步、中文适配和 `omp-cn` 发行都可审计、可复现，并且在任何不可逆操作前停止失败流程。

## 1. 固定身份与当前状态

| 项目 | 规范值 | 说明 |
| --- | --- | --- |
| 上游仓库 | `upstream = can1357/oh-my-pi` | 只获取和比较，不向其推送 |
| 分叉仓库 | `origin = yequ172672/oh-my-pi-cn` | 中文分支唯一推送目标 |
| 维护与发布分支 | `main` | GitHub 默认分支、CI 分支和发布分支必须一致 |
| npm 包 | `omp-cn` | 唯一允许发布的中文分支包 |
| Git 标签 | `omp-cn-v<forkVersion>` | 不使用上游的 `v<version>` 命名空间 |
| 发行清单 | `packages/coding-agent/fork-release.json` | 中文发行版本的唯一事实源 |
| 中文分支变更日志 | `docs/FORK_CHANGELOG.md` | 只记录分叉发行变化 |

旧的 `agent/zh-cn-localization` 只可作为历史分支或临时兼容别名，不能再作为发布依据。旧的 `v17.2.11` 标签与上游同名且指向不同对象；不要删除或移动历史标签，但不得继续创建同类标签。

### 旧版升级桥接约束

已经发布的 `omp-cn@17.2.11` 使用旧升级器，它会要求 `omp-cn` 和 `@oh-my-pi/pi-natives` 使用同一目标版本。第一次切换到双版本协议时，必须满足以下任一条件：

1. 等上游发布同号原生包，以 `forkVersion == nativeVersion` 发布一次桥接版本；这是默认选择。
2. 经维护者明确批准，采用手动全局安装迁移，并在 README、发行说明和启动提示中写明命令；不得宣称无缝升级。

不满足条件时，发行状态是 **BLOCKED**。可以继续同步和改进代码，但不能运行 npm 发布、创建稳定标签或把源码 Release 标记为 `latest`。

上游已经发布 `@oh-my-pi/pi-natives@17.2.12`，因此以 `forkVersion == upstreamVersion == nativeVersion == 17.2.12` 准备的发行满足默认桥接条件。发行脚本仍必须实时核验 npm 精确版本、旧 `omp-cn@latest` 元数据和未发布版本状态；不能仅凭本文的历史记录跳过门禁。成功发布该桥接版本后，后续 schema 1 客户端才可按双版本元数据分别更新 fork 包与 native 包。

## 2. 双版本协议

`fork-release.json` 同时记录：

- `forkVersion`：`omp-cn` 的用户可见版本，也是 `omp --version` 的输出。
- `upstreamVersion`：本次代码所基于的上游 workspace 版本。
- `nativeVersion`：npm 上真实存在且通过验证的 `@oh-my-pi/pi-natives` 版本。
- `upstreamCommit`：同步基线的完整 40 位上游提交 SHA。

新 `forkVersion` 必须是稳定的 `X.Y.Z`，在 SemVer 顺序上高于 npm `latest`，且从未发布过。稳定发布入口不接受 prerelease 或 build metadata。已经发布 `17.2.11` 后，`17.2.11-cn.1` 反而是更低的 prerelease，不能作为下一版本；首次 schema 1 发行必须按第 1 节使用同号 native 桥接，或走经批准的手动迁移方案。

分叉发行时只改变 `forkVersion` 和相应发行记录。除非上游本身已经改变版本，否则禁止为了让数字看起来一致而修改以下内容：

- 根 workspace catalog 中的 `@oh-my-pi/*` 版本；
- 各 workspace `package.json` 的版本；
- `Cargo.toml`、`Cargo.lock` 或 native sentinel；
- 已发布的 npm 版本或现有 Git 标签。

打包时，发行脚本临时把 coding-agent manifest 覆盖为 `omp-cn@forkVersion`，写入 `ompFork` 元数据，并让 `catalog:` / `workspace:` 依赖解析成已发布的上游精确版本。无论成功或失败，源 manifest 都必须按字节恢复。

## 3. 角色、授权和停止条件

同一人可以兼任多个角色，但每一道门禁必须有记录。

| 角色 | 职责 | 需要明确授权的外部副作用 |
| --- | --- | --- |
| 维护执行者 | 获取上游、合并、中文适配、运行本地检查 | 无 |
| 版本审批者 | 审核双版本、上游 SHA、变更日志和迁移方案 | 批准发行版本与标签 |
| 凭据持有者 | 管理 GitHub/npm 认证和 2FA | 推送、npm publish、deprecate、GitHub Release |
| 最终验收者 | 审核精确提交、CI、制品和安装结果 | 将 Release 标记为稳定/latest |

以下任一情况必须停止，不得通过 `--skip-check`、强制推送或批量选择 `ours/theirs` 绕过：

- 工作区存在来源不明的改动；
- remote、当前分支、基线 SHA 或发行清单不一致；
- 合并发生冲突，且无法说明业务逻辑与中文边界如何融合；
- `NODE_TLS_REJECT_UNAUTHORIZED=0`，或认证/2FA/网络不安全；
- 所需的上游/native npm 精确版本不存在；
- 精确提交的 GitHub Actions 未成功；
- tgz 校验、隔离安装、二进制 smoke 或安装器测试失败；
- 发布状态与记录不一致，或上一步外部副作用尚未对账。

## 4. 环境预检

在仓库根目录运行并保存输出到本次维护记录：

```powershell
git status --short
git branch --show-current
git remote -v
git remote get-url --all --push origin
git rev-parse HEAD
git rev-parse upstream/main
git merge-base HEAD upstream/main
bun --version
git --version
npm --version
gh --version
rustc --version
cargo --version
if ($env:NODE_TLS_REJECT_UNAUTHORIZED -eq "0") { throw "TLS verification is disabled" }
gh auth status
npm whoami
```

要求：

- 当前分支为 `main`，并跟踪 `origin/main`；
- `origin` 的 fetch/push URL、`upstream` 的 fetch URL 与第 1 节完全一致，且不得使用明文 HTTP；
- `fork-release.json.upstreamCommit` 必须等于 `git merge-base HEAD upstream/main` 的完整 SHA；不能用旧提交、任意祖先或仅凭人工描述代替实际同步基线；
- Bun 满足根 `package.json` 的 `packageManager` 和 coding-agent `engines`；
- 工作区干净，或每项改动都有明确所有者并纳入本次范围；
- TLS 绕过变量未设置；
- 发布任务同时具备 GitHub 和 npm 权限，普通同步不要求 npm 权限。

所有网络 Git 命令使用非交互模式和调用方提供的超时，例如：

```powershell
$env:GIT_TERMINAL_PROMPT = "0"
git fetch upstream main --prune --no-tags
if ($LASTEXITCODE -ne 0) { throw "fetch upstream/main failed" }
```

不要获取上游标签；分叉曾使用过冲突的 `v*` 标签命名空间。

## 5. 上游同步事务

本仓库采用**全量 merge-based fork**。合并 `upstream/main` 会引入完整上游变更；“相关功能才进入本分支”只能作为是否启动本轮同步的判断，不能在完成全量 merge 后声称排除了部分提交。需要选择性引入时，必须另开有记录的 cherry-pick 任务，不得混用两套流程。

### 5.1 建立事务

```powershell
git switch main
git status --short
$base = git rev-parse HEAD
$upstream = git rev-parse upstream/main
git log --oneline --decorate --left-right main...upstream/main
git merge --no-ff --no-commit upstream/main
```

必须在 merge 前记录 `$base`。如果决定放弃且尚未提交，使用 `git merge --abort`；禁止用 `git reset --hard` 清理用户改动。

### 5.2 冲突决策

逐文件回答：

1. 上游改变了什么业务行为或接口？
2. 中文分支拥有的边界是什么？
3. 是否能以“上游逻辑 + 本地化资源/适配层”融合？
4. 新的用户可见英文是否有稳定 fallback？
5. 是否影响发行清单、更新器、安装器或生成文件？

核心原则：上游业务逻辑、接口、目录结构、依赖和测试语义优先；中文分支不维护平行业务实现，只在明确的 i18n、中文文案，以及保证 `omp-cn` 可安装、可更新、可审计所必需的分叉身份和发行边界重新接入差异。没有本地化或发行身份理由时采用上游结果。禁止对目录批量执行 `git checkout --ours` 或 `--theirs`。

### 5.3 中文分支所有权

重点审查：

- `packages/coding-agent/src/i18n/`、语言设置和持久化；
- TUI、命令、设置、首次启动、供应商配置的用户可见文案；
- `packages/coding-agent/src/distribution.ts` 和 `fork-release.json`；
- `scripts/install.*`、fork 打包/发行脚本；
- README、`docs/LOCALIZATION.md` 和本文；
- `CONTRIBUTING.md`、社区健康文件、Issue/PR 模板和 `docs/CONTRIBUTOR_TASKS.md`；
- `website/`、Pages workflow、站点 canonical/结构化数据和 `omp-cn` 社区入口；
- `omp-cn` registry/repository/update URL，不得退回官方包身份。

完成适配后才提交 merge。提交前保存 `git diff --stat $base` 和上游完整 SHA。

## 6. 生成文件与依赖

### 6.1 生成文件登记

| 路径 | 事实源/命令 | 网络或凭据 | 提交策略 |
| --- | --- | --- | --- |
| `packages/catalog/src/models.json` | `bun run gen:models`；provider descriptors/resolvers | 可能需要网络/供应商凭据 | 禁止手改；仅模型源变化时生成，记录来源并审查完整 diff |
| `packages/collab-web/src/tool-views.generated.js` | `bun run gen:tool-views` | 否 | 生成器变更时同步提交 |
| coding-agent `dist` bundle/stats | `bun run gen:bundle` | 否 | 发布制品，不把临时生成/重置状态混入维护提交 |
| MuPDF 嵌入文件 | `bun run gen:mupdf` / `gen:mupdf:reset` | 否 | 只在对应源变化时生成，结束时恢复规范状态 |
| native 生成文件 | `bun run gen:native` / `gen:native:reset` | 工具链相关 | 只在 native 源变化时提交并跑平台矩阵 |

执行任何生成命令前后都运行 `git status --short` 和 `git diff --stat`。不属于本次变更的生成差异必须调查来源，不能直接删除或顺手提交。

### 6.2 依赖策略

- 常规依赖和 Bun 版本默认随上游更新，中文分支不独立批量升级。
- fork-only 或紧急安全升级必须独立提交，记录上游 issue/兼容性判断。
- 审核根 catalog、patches 和 `bun.lock` 的精确差异；不得只看 manifest。
- native/optional 依赖变化要跑相关 OS/架构和安装方法矩阵。
- 回退使用新的修复提交/版本；已发布 npm 版本不可覆盖或复用。

## 7. 路径驱动的验证矩阵

所有维护至少运行：

```powershell
bun run ci:check:full
bun test packages/coding-agent/test/i18n.test.ts
bun run ci:test:smoke
git diff --check
```

按改动范围增加：

| 改动范围 | 必须增加的验证 |
| --- | --- |
| coding-agent 运行时/UI | `ci:test:coding-agent:runtime`、`ci:test:coding-agent:ui` |
| workspace 公共包 | `ci:test:ts:workspace`，必要时 `ci:test:full` |
| native/Rust/optional 依赖 | `ci:test:coding-agent:native`、Rust 测试及平台矩阵 |
| 更新、发行元数据、打包 | distribution/update/publish/release 专项测试与 fork dry-run |
| 安装器或二进制 | 安装器行为测试、`ci:test:install-methods` 和目标平台 smoke |
| README、社区入口或网站 | YAML/HTML/JSON/XML 语法、内部链接、canonical/OG/sitemap URL、移动端布局和 Pages workflow；不需要冒充完整代码矩阵 |
| 大范围上游合并 | 可用的完整 TS/Rust 矩阵；未运行项必须在记录中标为未验证，不能写“全部通过” |

`test:scripts` 中可能包含平台专属或上游已知不稳定测试，不能用一个聚合命令掩盖结果。CI 和记录必须列出实际执行的测试文件及失败归属。

当前 GitHub-hosted Linux 无法提供 `shell::tests::kill_builtin_signals_every_process_in_a_jobspec_pipeline` 所需的 stopped-pipeline 会话语义；在有/无 Bazel sandbox、5/15 秒上限下都稳定失败，而同一目标其余 918 项通过。因此 hosted Rust job 明确标为 **limited**，运行其他全部 Rust targets 和 `pi-shell_test` 的其余用例，并把这一项记录为未验证，不能写“完整 Rust 矩阵通过”。任何触及 `crates/pi-shell` job-control、进程组、STOP/CONT 或 jobspec 的变更都必须在兼容 Linux runner 上补跑该精确用例；没有证据时发行状态为 **BLOCKED**。

普通 `main`/PR 验证优先下载与 workspace 同号且已经完整发布的官方 native 包；上游刚完成源码版本提升、精确 native 尚未发布时，CI 必须从本次验证 SHA 构建 Linux x64 测试插件，避免把上游发布时序误判为源码失败。正式 `omp-cn-v*` 发行标签不允许使用该回退：所有平台的官方 native 精确版本必须已在 npm 完整发布，否则发行保持 **BLOCKED**。

人工 TUI 验收使用临时 profile/目录，不先运行会覆盖现有全局 `omp` 的 `bun setup`。至少检查首次启动、语言切换、设置页、供应商向导、错误提示和非交互命令。

### 7.1 社区与网站发布

- GitHub 仓库必须保持 Issues 与 Discussions 开启，Topics、简介、README 和网站使用一致的 `oh-my-pi-cn` / `omp-cn` / “Oh My Pi 中文版”身份。
- root、coding-agent、fork 打包清单和可选 Homebrew 元数据的 homepage 统一指向项目网站，repository/bugs 仍指向 GitHub；网站域名变化时同步更新对应合同测试。
- `website/` 是无构建依赖的静态站点，发布入口为 `.github/workflows/pages.yml`，只上传该目录，不能把仓库、凭据或构建产物整体发布。提交前及 workflow 中运行 `bun run ci:site`，验证 HTML 元数据、结构化数据、内部资源、YAML、sitemap 和社交图合同。
- 站点 canonical、Open Graph、JSON-LD、`robots.txt` 和 `sitemap.xml` 统一指向 `https://yequ172672.github.io/oh-my-pi-cn/`；更换域名时必须一次性更新并验证全部入口。
- 首页的 `google-site-verification` 标记用于维持 Google Search Console 所有权，不能在上游同步或页面改版时删除；如需轮换，必须同步更新站点验证脚本并重新完成在线验证。
- Pages workflow 成功后才能把 GitHub Homepage 改为站点 URL。站点尚未部署、部署失败或返回 404 时不得提前制造公开死链。
- 每次站点变更检查桌面和窄屏内容层级、键盘焦点、安装命令、贡献链接、社交预览图和外部链接。公开页面只面向最终用户与贡献者，不写入内部制作过程。

## 8. 精确制品准备与验证

发行审批后更新 `fork-release.json` 和 `docs/FORK_CHANGELOG.md`，但不修改 workspace/Cargo/native sentinel。先运行 fork 发行准备命令；它必须：

1. 验证 SemVer、上游 SHA 和 npm 上游/native 精确版本。
2. 对 legacy latest 执行桥接版本门禁。
3. 生成一次候选 tgz，并输出其路径与 SHA-256。
4. 断言打包 manifest 的 name、version、bin、license、repository、homepage、`ompFork` 和全部 `@oh-my-pi/*` 依赖版本。
5. 在隔离 prefix/Bun home 安装**同一个 tgz**，运行 `omp --version`、`omp --help`、`omp --smoke-test`。
6. 可保留候选 tgz供人工审查，退出时恢复源 manifest，并用 `git diff --exit-code` 验证没有残留。

推荐本地检查：

```powershell
bun run publish:fork:dry -- --output .artifacts/fork
```

`.artifacts` 仅是示例临时输出目录，不得加入提交。候选 tgz用于推送前验证，不跨机器冒充最终制品。正式 tag 触发后，CI 的 `release_package` job 必须从标签的精确 SHA 只 pack 一次，将该 tgz 隔离安装、记录哈希并作为 workflow artifact 传给 npm job；npm job发布的必须是这个同一文件，不能二次 pack。`--skip-check` 只允许 CI 在同一 SHA 的前置门禁已经成功时使用，不能作为人工捷径。

## 9. 不可逆发布状态机

正式发布必须按以下顺序推进，并在维护记录中写入每步的 SHA、URL、run ID、npm 版本或制品 hash：

1. **PREPARED**：工作区检查、版本审批、变更日志、候选 tgz 和隔离安装全部通过。
2. **GIT_PUBLISHED**：使用下面的 fork 发行命令创建发行提交与 `omp-cn-v<forkVersion>`，并将 `main` 与新标签一次 `git push --atomic` 到 `origin`。标签必须指向已审核的精确提交。
3. **CI_VERIFIED**：GitHub 托管 runner 对该精确提交成功；不存在 runner 或只验证了其他 SHA 时不能继续。
4. **ASSETS_READY**：CI 从精确 SHA 生成并验证唯一发行 tgz；当前承诺的 Windows x64 二进制经过 Windows runner 启动 smoke，`LICENSE` 与 `THIRD-PARTY-NOTICES.txt` 随制品分发，校验和已生成，所有文件先上传到 draft GitHub Release。重跑时必须清除 draft 的陈旧资产，并把重新下载的精确资产集合逐字节对回本轮可信构建。
5. **NPM_PUBLISHED**：发布 CI 验证并传递的同一个 tgz，核对 `npm view omp-cn@<version>` 的版本、dist-tag、校验值和元数据。
6. **RELEASE_COMPLETE**：GitHub Release 使用 fork 变更日志，安装器路径完成回归，最后显式取消 draft/prerelease 并标记 latest。

fork CI 只允许发布 `omp-cn` 和 fork Release；禁止触发上游 `@oh-my-pi/*`、native leaf、Homebrew 或上游 `v*` 发布路径。普通 `main` push 只运行验证；正式发布由 `omp-cn-v*` 精确标签或受控 workflow dispatch 触发。

发行命令会产生提交、标签和原子远程推送，必须在版本审批者与凭据持有者明确授权后运行：

```powershell
bun run release:fork <forkVersion> `
  --upstream-version <upstreamVersion> `
  --native-version <nativeVersion> `
  --upstream-commit <40位SHA>
```

GitHub 仓库必须在发布前配置 `NPM_TOKEN`，或在 npm 为本 workflow 配置信任发布者。两者都没有时 npm job 会停止，GitHub Release 必须保持 draft。当前凭据状态需要每次发行重新核验，不能从以往成功记录推断。

源码-only Release 不能成为安装器使用的 stable/latest。当前稳定 Release 只承诺 Windows x64 二进制；macOS、Linux 和其他架构通过 Bun/npm 安装。稳定 Release 必须包含经过原生 Windows runner 验证的 Windows x64 二进制、tgz、`LICENSE`、`THIRD-PARTY-NOTICES.txt` 和校验和；缺少任一资产时应保持 draft/prerelease 并停止发布状态机。

## 10. 安装器合同

- 默认模式：有 Bun 时安装 `omp-cn`；无 Bun 时尝试匹配当前 fork Release 的精确二进制。
- 二进制必须先下载到临时文件并运行 `--version`/启动 smoke，成功后再原子替换，失败不得破坏已有 `omp`。
- 自动模式下二进制不可用时，可以安装 Bun 并回退 npm `omp-cn`；显式 `--binary` / `-Binary` 必须失败退出，不能静默改变安装方法。
- 显式源码模式必须把完整仓库保存在版本化持久目录，在根目录 `bun install --frozen-lockfile` 后 link coding-agent。禁止从临时 clone 对单个 workspace 包执行全局安装后再删除目录。
- 安装器默认 ref 和 README URL 都使用 `main`。

## 11. 故障恢复与对账

外部发布不可回滚成“从未发生”。按实际状态恢复：

| 已发生状态 | 处理 |
| --- | --- |
| 仅本地 PREPARED | 修复后重新生成并验证 tgz；旧 tgz 作废 |
| main/tag 原子 push 失败 | 先查询远端；只有发行提交的父提交仍是 `origin/main`、提交只改发行清单与 fork 变更日志且内容精确匹配时，才可补建标签并重试同一次原子 push |
| Git 已发布、CI 失败 | 不发布 npm；用新提交和新标签/版本修复，不移动公开标签 |
| Assets 部分上传 | 保持 draft/prerelease，补齐并重新 smoke 后继续 |
| npm 已发布、后续失败 | 版本不可复用；经授权 deprecate 坏版本并发补丁版，保留事故说明 |
| GitHub Release 已 stable 但安装失败 | 立即停止 latest 推广，记录受影响平台，修复后发新版本 |

若重跑时同名 GitHub Release 已经公开，CI 只能在资产集合及每项字节与本轮可信构建、SHA-256、标题、发行说明、stable/latest 状态、npm manifest、npm tarball shasum 与 `dist-tags.latest` 全部精确一致后将事务判为已完成；任何差异都必须停止，不能覆盖公开状态。

禁止删除公开 npm 版本来伪装恢复，也禁止把现有标签移动到另一提交。

## 12. 维护记录模板

每轮同步或发行至少保存：

```text
日期/执行者：
任务类型：sync / localization / dependency / release / incident
起始 HEAD：
upstream/main SHA：
合并后 HEAD：
forkVersion / upstreamVersion / nativeVersion：
改动范围与冲突决策：
生成文件与来源：
实际执行的本地检查及结果：
远程 CI URL、run ID、精确 SHA：
tgz 路径与 SHA-256：
Git tag / GitHub Release / npm 外部 ID：
人工验收结果：
未验证项、风险与下一步：
各门禁审批人：
```

只有所有适用门禁都成功、外部状态完成对账，且没有把未执行项目写成“通过”时，本轮维护或发行才算完成。
