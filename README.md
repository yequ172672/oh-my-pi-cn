<p align="center">
  <img src="https://github.com/yequ172672/oh-my-pi-cn/blob/main/assets/hero.png?raw=true" alt="omp">
</p>

<p align="center">
  <strong>面向中文用户的终端 AI 编程代理。</strong>
  <strong><a href="https://github.com/yequ172672/oh-my-pi-cn">oh-my-pi-cn</a></strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/omp-cn"><img src="https://img.shields.io/npm/v/omp-cn?style=flat&colorA=222222&colorB=CB3837" alt="npm 版本"></a>
  <a href="https://yequ172672.github.io/oh-my-pi-cn/"><img src="https://img.shields.io/badge/website-访问-9F6BF4?style=flat&colorA=222222" alt="项目网站"></a>
  <a href="https://github.com/yequ172672/oh-my-pi-cn/blob/main/docs/FORK_CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="变更日志"></a>
  <a href="https://github.com/yequ172672/oh-my-pi-cn/actions"><img src="https://img.shields.io/github/actions/workflow/status/yequ172672/oh-my-pi-cn/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="持续集成"></a>
  <a href="https://github.com/yequ172672/oh-my-pi-cn/blob/main/LICENSE"><img src="https://img.shields.io/github/license/yequ172672/oh-my-pi-cn?style=flat&colorA=222222&colorB=58A6FF" alt="许可证"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://discord.gg/4NMW9cdXZa"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  基于 <a href="https://github.com/badlogic/pi-mono">Pi</a> 与
  <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a> 的简体中文本地化分支
</p>

## 中文本地化分支

本仓库是 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 的简体中文本地化分支，
由 yequ172672 维护，B 站 ID：夜曲_flac。分支在保留上游核心能力和提交历史的基础上，
持续同步上游更新，并将中文用户实际使用到的界面、提示和安装体验作为重点维护范围。
项目也可通过 `ohmypi-cn`、`omp-cn` 或“Oh My Pi 中文版”搜索；完整介绍见
[项目网站](https://yequ172672.github.io/oh-my-pi-cn/)。

当前分支的特色包括：

- 设置中心的中文界面，覆盖外观、模型、交互、上下文、记忆、文件、终端等栏目及其选项提示；
- 供应商配置和首次启动向导的中文说明，降低模型登录与 Web 搜索配置门槛；
- 主界面随机 tip 提示、模型思考等级和常用操作说明的中文本地化；
- 语言设置持久化，重启后继续使用已选择的语言；
- 独立的 omp-cn 安装、更新和 npm 发布路径，避免覆盖官方 omp 安装；
- 以上游仓库 can1357/oh-my-pi 为基础，保留上游功能演进，同时持续维护中文翻译和本分支体验。

上游原作者、版权声明和开源协议保持不变；本分支维护者信息见文末的“分支维护与致谢”。

面向终端工作流打造的完整 AI 编程代理：开箱即用，并保留从 CLI 到底层工具链的可扩展能力。

**60+** 个供应商 · **31** 个内置工具 · **14** 个 LSP 操作 · **28** 个 DAP 操作 · **约 8 万** 行 Rust 核心代码。

> [!NOTE]
> 本分支以简体中文本地化为维护重点，同时跟踪
> [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) 的核心能力更新。
> 安装和更新请使用本仓库提供的 omp-cn 路径。官方包和中文包都会提供 `omp` 命令，不能依靠 PATH 同时维护两套全局安装。

## 安装

> [!WARNING]
> 本中文分支在 npm 上的包名是 **`omp-cn`**，不是官方的 **`@oh-my-pi/pi-coding-agent`**。
> 两者都会安装名为 `omp` 的命令，安装后请确认来源是 `omp-cn`，否则可能实际运行的是官方英文版本。
> 如果之前安装过官方包，请先执行 `npm uninstall -g @oh-my-pi/pi-coding-agent`，再安装本分支：
>
> ```sh
> npm install -g omp-cn
> ```

**macOS · Linux**

```sh
curl -fsSL https://raw.githubusercontent.com/yequ172672/oh-my-pi-cn/main/scripts/install.sh | sh
```

> **Alpine / musl：**预构建的 musl 二进制文件会动态链接 libstdc++/libgcc，而标准 Alpine 默认不提供它们。请先执行：apk add libstdc++ libgcc。

**GitHub 发布版本二进制文件**

当前 Release 只提供经过原生 Windows runner 验证的 Windows x64 二进制。macOS 和 Linux 用户请使用上面的 Bun/npm 安装方式；也可以从[本分支的 Release 页面](https://github.com/yequ172672/oh-my-pi-cn/releases)下载 Windows 版本。

**Bun（推荐）**

```sh
bun install -g omp-cn
```

**Nix**

```sh
# 无需安装直接运行
nix run github:yequ172672/oh-my-pi-cn

# 或安装到当前 profile
nix profile install github:yequ172672/oh-my-pi-cn
```

Flake 使用者可以使用 `packages.<system>.omp`、`overlays.default`、`nixosModules.default` 或 `homeManagerModules.default`。Home Manager 配置可以声明式安装 OMP 并管理设置：

```nix
{
  inputs.omp.url = "github:yequ172672/oh-my-pi-cn";

  # 在 Home Manager 模块中：
  imports = [ inputs.omp.homeManagerModules.default ];
  programs.omp = {
    enable = true;
    settings.startup.quiet = true;
  };
}
```

**Windows（PowerShell）**

```powershell
irm https://raw.githubusercontent.com/yequ172672/oh-my-pi-cn/main/scripts/install.ps1 | iex
```

**固定版本（mise）**

```sh
mise use -g "github:yequ172672/oh-my-pi-cn[version_prefix=omp-cn-v]"
```

支持 macOS、Linux、Windows，以及 bun ≥ 1.3.14。

安装脚本默认使用 `yequ172672/oh-my-pi-cn` 的 `main` 分支和 `omp-cn` npm 包。有可用 Bun 时直接安装 npm 包；没有 Bun 时优先安装同时通过 Release SHA-256 和精确版本校验的二进制，资产不可用时再安装 Bun 并走 npm。显式源码安装会保留完整 workspace，避免临时目录被删除后全局链接失效。

### Shell 补全

omp 会根据实时的命令和参数元数据生成 bash、zsh 和 fish 补全脚本，因此补全内容不会与实际 CLI 脱节。子命令、参数和枚举值会静态补全；--model、--smol、--slow、--plan 的模型名称会从内置模型目录解析，--resume 会从本地会话中解析。

```sh
# zsh：添加到 ~/.zshrc，或将输出写入 $fpath 中的文件
eval "$(omp completions zsh)"

# bash：添加到 ~/.bashrc
eval "$(omp completions bash)"

# fish
omp completions fish > ~/.config/fish/completions/omp.fish
```

## 每一个工具都经过充分打磨

让编辑一次成功，让读取操作总结文件而不是倾倒全部内容，让搜索立即返回结果。无论选择哪一个模型，omp 都会尽力给出可靠结果。

| 模型 | 指标 | 说明 |
| --- | --- | --- |
| Grok Code Fast 1 | 6.7% → 68.3% | 编辑格式不再吞掉模型输出后，成功率提升近十倍。 |
| Gemini 3 Flash | +5 个百分点 | 相比 str_replace 更稳定，也超过 Google 自己在该格式上的最佳尝试。 |
| Grok 4 Fast | 减少 61% Token | 修复错误 diff 的重试循环消失后，输出量显著下降。 |
| MiniMax | 2.1 倍 | 通过率翻倍以上，模型权重不变。 |

- read：返回摘要片段，拥有理想默认值和选择器命中率；
- grep：快速完成全局搜索；
- lsp：IDE 能做的事情，代理也能做；
- prompts：针对不同模型持续调整提示词。

[阅读完整文章 ↗](https://blog.can.ac/2026/02/12/the-harness-problem/)

## 你熟悉的 Pi，能力一应俱全

本项目最初基于 [Mario Zechner](https://github.com/mariozechner) 的
[Pi](https://github.com/badlogic/pi-mono)，并在此基础上补齐完整的 AI 编程工作流。

### 01 · 支持工具调用的代码执行

许多代理只提供一个 Python 沙盒就宣称支持代码执行。本项目提供持久化 Python 环境和 Bun worker，任一运行时都可以通过回环桥接调用代理自己的 read、search、task 工具。代理可以在 Python 中使用 tool.read 读取 CSV，再用 JavaScript 绘图，整个过程始终留在同一个单元格中。

![omp TUI：单次 eval 会话先用 Python 输出真实的 DataFrame.describe() 表格，再用 JavaScript 执行 reduce，底部显示两个内核在同一会话中运行。](https://omp.sh/captures/eval.webp)

### 02 · 每次写入都接入 LSP

请求重命名就会真正执行重命名。调用会经过 workspace/willRenameFiles，因此文件移动前会同步更新重新导出、桶文件和别名导入。IDE 能理解的内容，代理也能理解。

![omp TUI：LSP references 在三个文件中返回 formatBytes 的五处引用，随后 LSP rename 修改 format.ts、report.ts 和 cli.ts，最后确认搜索不到 formatBytes。](https://omp.sh/captures/lsp.webp)

_[阅读 LSP 配置文档](docs/lsp-config.md)_

### 03 · 驱动真正的调试器

C 程序发生段错误时，代理可以连接 lldb，单步执行并读取栈帧；Go 服务卡住时，可以连接 dlv 检查 goroutine；Python 进程无响应时，可以使用 debugpy 暂停、检查和求值。代理不必只会插入打印语句。

![omp TUI：针对 /tmp/omp-native/demo 中的原生二进制运行 lldb-dap，显示停止状态、xorshift32 栈帧和调试变量。](https://omp.sh/clips/dap-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/dap.mp4)_

### 04 · 支持时间旅行式的流规则

规则默认处于休眠状态，直到模型偏离要求。正则匹配后，系统会在 Token 中途终止流式请求，将规则作为系统提醒注入，再从同一个位置重试。这样可以在不为每轮请求支付额外上下文成本的情况下纠正方向。压缩上下文后，注入内容仍然保留，因此修正能够持续生效。

![omp TUI：代理读取 src.rs 后准备写入 Box.leak，请求被终止并显示规则注入卡片，随后代理改用 Arc.str 并请求用户确认。](https://omp.sh/clips/ttsr-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/ttsr.mp4)_

### 05 · 一等公民级别的子代理

将工作拆分给多个 worker，并获得类型安全的结果。task 会把任务分发到隔离的 worktree，每个 worker 都拥有自己的工具面，最终结果经过 schema 校验后由父代理直接读取。不需要解析散文式回答，也不会出现兄弟任务之间的合并冲突或遗留修改。

![omp TUI：task 启动 ComponentsExports 和 RoutesExports 两个子代理，显示每个子代理的状态、费用和耗时，最后列出两个导出结果。](https://omp.sh/clips/irc-poster.webp)

运行过程中可以按 Alt+A 打开 [Agent Hub](docs/agent-hub.md)，查看所有子代理的活动和用量。打开某个子代理后，可以阅读实时记录、发送引导消息、唤醒暂停的 worker，或终止卡住的任务，而不会中止父会话。

### 06 · 第二个模型观察每一轮

将审查模型绑定到 advisor 角色后，它会阅读主代理的每一轮操作，并以内联方式注入旁注、疑问或阻断性问题。它使用独立的上下文和模型，可以发现执行代理匆忙跳过的问题。主代理会看到这些意见并修正方向，或者解释为什么不采纳。

![omp TUI：advisor 使用 openai-codex/gpt-5.5 运行，在主代理缩小 ENOENT 捕获范围后显示一条提醒，指出修复不再符合用户的字面验收标准。](https://omp.sh/clips/advisor-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/advisor.mp4)_

### 07 · 分享一个链接，别人立即加入

/collab 会把实时会话放到 relay 上，并返回链接和二维码。队友可以在另一个终端执行 omp join，也可以直接在浏览器中打开。通过读写模式共同操作同一个代理，或使用 /collab view 生成只读链接，让任何人都能观看但不能控制。画面在客户端加密，relay 不会看到你的密钥。

![omp TUI：/collab view 输出会话已启动、omp join 命令、浏览器链接和只读提示，并显示一个可扫描的二维码。](https://omp.sh/clips/collab-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/collab.mp4)_

### 08 · 读取 arXiv PDF，当然可以

web_search 会串联二十三个按排名排列的供应商，并将找到的 URL 直接交给 read。arXiv PDF、GitHub 页面和 Stack Overflow 讨论会转换为保留锚点的结构化 Markdown，与本地文件使用同一套工具接口。可以引用、跟进和摘录，并始终保留来源位置。

![omp TUI：web_search 返回关于推理时计算扩展的十个 Perplexity 来源，代理选择一篇 arXiv 论文并读取 PDF，然后用真实数据总结论文结果。](https://omp.sh/clips/web-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/web.mp4)_

### 09 · 真正的原生能力，Windows 也一样

其他代理需要启动 rg、grep、find 和 bash。很多机器根本没有这些二进制文件，即使存在，每次调用也要付出一次 fork-exec 往返成本。omp 将真实实现直接链接到进程中：ripgrep、glob、find 都在进程内运行；brush 提供 bash，跨调用保留会话；58 个命令行工具（包括 ls、sed、sort、xargs 和 jq）已移植到 `pi-builtins` crate，并作为内置功能在进程内运行，无需 fork/exec。同一个 omp 二进制文件可以运行在 macOS、Linux 和 Windows 上，无需 WSL 桥接。

### 10 · 带优先级和结论的代码审查

清楚判断某项改动是否可以发布，并将每个问题按 P0 到 P3 分级，同时给出置信度评分。/review 会启动专用审查子代理，并行检查分支、单个提交或未提交的工作。先处理阻断发布的问题，重要内容不会被大段文字掩盖。

### 11 · Hashline：按内容哈希编辑

更少 Token，获得更可靠的编辑。模型指向锚点，而不是重新输入要修改的行，因此空白差异和“找不到字符串”的重试会大幅减少。编辑过时文件时，锚点会发生偏离；系统会在补丁破坏文件前拒绝它。Grok 4 Fast 在相同任务上的输出 Token 可减少 61%。

### 12 · GitHub 只是另一种文件系统

其他 harness 需要分别学习 gh_issue_view、gh_pr_view、gh_search 等工具，每个工具都有不同的参数。这里直接复用路径接口：read 已经能够处理路径，PR 也可以表示为路径。代理只需学习一种接口，系统也只需维护一个工具面。

### 13 · 由代理整理的记忆

代理可以跨会话记住代码库。运行中使用 retain 写入事实，用 learn 保存可复用经验，用 recall 取回记忆，并将每个会话压缩为下一次会话开始时加载的工作模型。通过 memory.backend 选择 local、Hindsight 或 Mnemopi。默认按项目隔离，因此代理对当前仓库学到的内容会留在当前仓库范围内。

### 14 · ACP：由编辑器驱动的代理

在 Zed 中运行 omp，就能获得与终端相同的代理：读取当前编辑器缓冲区，通过编辑器保存路径写入文件，并在编辑器终端中启动 shell。破坏性工具会暂停并请求权限，你确认一次即可继续。无需桥接、插件或额外的同步层。

### 15 · 继承其他工具已经写下的配置

其他代理往往要求导入并转换配置；omp 可以直接读取磁盘上已有的八种格式，包括 Cursor MDC、Cline .clinerules、Codex AGENTS.md、Copilot applyTo 等。无需迁移脚本、YAML 到 TOML 的转换，也没有“只支持一部分格式”的附注；团队上个季度写下的配置今晚仍然可以使用。

### 16 · omp commit：原子拆分与已验证的提交信息

omp 通过 git_overview、git_file_diff 和 git_hunk 读取工作树，然后按依赖顺序将不相关的改动拆分为原子提交。写入前会拒绝循环依赖。源文件的优先级高于测试、文档和配置，因此最重要的改动会出现在标题提交中；锁文件完全排除在分析之外。

### 17 · 读取 PR、遍历 skill、从子代理结果中提取 JSON

pr://、issue://、agent://、skill://、ssh:// 等十六种内部 scheme，会在代理已经使用的所有文件系统型工具中透明解析。read pr://1428 返回的结构与 read src/foo.ts 相同；grep 可以像遍历目录一样遍历 diff；agent://<id>/findings.0.path 可以按路径从子代理结果中提取字段。

![omp TUI：读取 pr://can1357/oh-my-pi/1063，再读取 /diff/1，显示区块标题和 [MODIFIED] (+12 -0) 摘要。](https://omp.sh/captures/pr.webp)

### 18 · 轻松解决冲突

每个合并冲突都会变成一个 URL。代理向 conflict://N 写入 @theirs、@ours 或 @base，文件就会被干净地解析。批量形式为 conflict://*。

![omp TUI：读取 src/session.ts 后显示一个冲突，随后向 conflict://1 写入 @theirs，最后显示冲突已解决。](https://omp.sh/clips/conflict-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/conflict.mp4)_

### 19 · 先预览，再接受

ast_edit 会返回一个包含替换数量的“拟议修改”卡片，改动会先暂存。代理向 xd://resolve 写入一行理由，TUI 将其转为 Accept 卡片，然后一次性完成磁盘移动：要么全部应用，要么完全不动。

![omp TUI：AST Edit 显示拟议替换，随后 Accept 卡片确认在 src/auth.ts 中应用三处替换。](https://omp.sh/clips/codemod-poster.webp)

_[观看演示 ↗](https://omp.sh/clips/codemod.mp4)_

### 20 · 驱动真正的浏览器，也可以驱动 Slack

Stealth 默认开启，因此网页看到的是普通用户，而不是无头机器人。同一套 API 还可以直接驱动 Electron 应用；指向 Slack 后，代理读取私信的方式与读取网页相同。也可以完全跳过沙盒：browser relay 扩展能接管已经打开的 Chrome 标签页，而且不会抢夺焦点。

![omp TUI 使用 browser 工具访问 DuckDuckGo。](https://omp.sh/captures/browser.webp)

### 21 · 直接操作桌面

computer 会在真实主机上运行持久化 JavaScript：枚举窗口和显示器、截取屏幕、发送原生输入、遍历操作系统辅助功能树、读写剪贴板。它不是浏览器工具，也不依赖 DOM；操作的就是你眼前的真实桌面。

## 任务所需的一切，都已内置

31 个工具与 read、bash 位于同一个命名空间。可以使用 --tools read,edit,bash,… 固定活动工具集；不常用但可发现的工具则放在 xd:// 设备后面。read xd:// 会列出这些工具，启用 tools.xdev 后，使用 write xd://<tool> 即可运行指定工具。

**文件与搜索**

- read：通过同一个路径接口读取文件、目录、压缩包、SQLite、PDF、笔记本、URL、远程 ssh:// 路径和内部 :// scheme；
- write：创建或覆盖文件、压缩包条目或 SQLite 行；
- edit：使用内容哈希锚点和过期锚点恢复机制应用 hashline 补丁；
- ast_edit：通过 ast-grep 预览结构化重写后再应用；
- ast_grep：基于 50 多种 tree-sitter 语法执行结构化代码查询；
- grep：在文件、glob 和内部 URL 上执行正则搜索；
- glob：按 glob 规则查找路径，需要匹配内容时请使用 grep。

**运行时**

- bash：包含 46 个进程内 coreutils、可选 PTY 和后台任务调度的工作区 shell；
- eval：带共享预加载环境和工具重新进入能力的持久化 Python、JavaScript 单元格。

**代码智能**

- lsp：诊断、导航、符号、重命名、代码操作和原始请求；
- debug：驱动 DAP 会话，支持断点、单步、线程、栈和变量；
- security_scan：规划并运行原生安全审查，驱动 Codex Security 云扫描。

**协作**

- task：并行分发子代理，可选择隔离工作区；
- hub：向实时代理发送消息、等待或取消后台任务，并监督长时间运行的进程；
- todo：带阶段追踪的有序会话任务列表变更；
- ask：交互式运行中的结构化追问。

**桌面与 Web**

- browser：通过无头 Chromium、CDP 连接的应用或 relay 操作自己的 Chrome 标签页；
- computer：在主机桌面上运行持久化 JS，支持窗口、截图、原生输入、辅助功能树和剪贴板；
- web_search：跨已配置供应商执行一次查询，并返回答案和引用；
- github：执行 GitHub CLI 操作，包括仓库、PR、Issue、代码搜索和 Actions 运行监控；
- generate_image：通过 Gemini、GPT 或 xAI Grok 图像模型生成或编辑位图；
- inspect_image：使用视觉模型分析本地图片文件；
- tts：使用 xAI Grok Voice 进行文字转语音，支持五种内置音色和 WAV/MP3。

**记忆与技能**

- checkpoint：标记会话状态，供后续压缩和报告；
- rewind：裁剪探索上下文，同时保留精简报告；
- retain：将持久化事实加入当前记忆库队列；
- recall：搜索记忆库中的原始记忆；
- reflect：基于记忆库综合回答；
- memory_edit：按 ID 更新、忘记或使记忆失效；
- learn：记录可复用经验，也可以将其提升为受管理的 skill；
- manage_skill：创建、更新或删除独立的受管理 skill。

以下功能默认关闭，需要通过设置启用：github、security_scan、generate_image、tts、checkpoint、rewind 以及记忆工具（根据 memory.backend 决定是否启用 retain、recall、reflect、memory_edit）。inspect_image 会在当前模型无法直接查看图片时自动启用。

[查看完整工具参考 ↗](https://omp.sh/docs/tools)

### 提示词控制

三个独立的小写单词可以让当前回合进入专用代理行为：

- ultrathink：请求谨慎的多步骤推理，并使用模型支持的最高自动思考力度；
- orchestrate：通过并行子代理执行大量独立工作，并验证每个阶段；
- workflowz：使用当前 task 工具构建确定性的多子代理工作流。

它们只会在普通文本中触发，不会在代码 span、围栏代码块、XML/HTML 片段、标识符或路径中触发。精确匹配规则和配置见 [魔法关键词](docs/magic-keywords.md)。

### 会话控制

斜杠命令会改变整个会话的运行方式：

- /vibe：进入 [Vibe 模式](docs/vibe-mode.md)，像导演一样驱动持久化的 fast/good worker 会话，并只使用 read 工具；
- /fresh：重置供应商流状态（过期提示缓存或卡住的流），不修改本地记录。参见 [会话操作](docs/session-operations-export-share-fork-resume.md#fresh)。

## 六十多个供应商、上千个模型，一个 /model 即可切换

系统按意图将工作分配给十个角色：default 负责普通回合，smol 负责低成本子代理分发，slow 负责深度推理，plan 负责计划模式，commit 负责变更日志，另外还有 vision、designer、task、advisor 和 tiny。启动时可以使用 --smol、--slow 或 --plan 覆盖角色；按 Ctrl+P 在当前角色配置的模型之间切换；在会话中使用 /model 斜杠命令更换当前模型。

下方的认证标签含义：oauth 使用供应商账户登录，plan 通过编程计划订阅路由，local 连接本地服务且密钥可选。

### 前沿 API

直接 API 和网关，可为不同角色混用供应商。

Anthropic oauth · OpenAI · OpenAI Codex oauth · Google Gemini · Google Vertex · Google Antigravity oauth · xAI · SuperGrok oauth · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Baseten · Hugging Face · NVIDIA · Meta · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

### 编程计划

通过订阅路由，使用 /login 绑定会话。

Cursor oauth · GitHub Copilot oauth · GitLab Duo · Devin oauth · Kimi Code plan · Moonshot · MiniMax Coding Plan plan · MiniMax Coding Plan CN plan · Alibaba Coding Plan plan · Qwen Portal oauth · Z.AI / GLM Coding Plan plan · Zhipu Coding Plan plan · Xiaomi MiMo · Qianfan · Umans plan · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

### 自行运行

支持 OpenAI 兼容的 /v1/models。本地实例不需要密钥。

Ollama local · Ollama Cloud · LM Studio local · llama.cpp local · vLLM local · LiteLLM

### 自定义 OpenAI 兼容供应商

在 ~/.omp/agent/models.yml 中定义自定义供应商：

```yaml
providers:
  spark:
    baseUrl: http://192.168.10.223:8000/v1
    api: openai-completions
    apiKey: dummy
    models:
      - id: minimax-m3
        name: MiniMax M3
        contextWindow: 100000
        maxTokens: 32000
```

运行 omp models spark 验证发现结果。然后运行 omp setup，在默认模型步骤中选择该模型；也可以在会话中打开 /model，将它分配给 default 角色。

如果不想使用选择器，可以将模型选择器直接写入 ~/.omp/agent/config.yml：

```yaml
modelRoles:
  default: spark/minimax-m3
```

### 让路由真正发挥作用的四个设置

- **自定义供应商**：在 ~/.omp/agent/models.yml 中声明任何支持 openai-completions、openai-responses、openai-codex-responses、azure-openai-responses、anthropic-messages、bedrock-converse-stream、google-generative-ai、google-gemini-cli 或 google-vertex 的服务。
- **回退链**：在 retry.fallbackChains 下按角色或模型配置回退链。主模型返回 429 或达到配额后，下一个条目会接管剩余回合，并在冷却后恢复。
- **按路径限定模型**：将 enabledModels 和 disabledProviders 条目限制到某个 path: 前缀，为单个仓库指定不同的模型集合，而不影响全局配置。限定条目同时覆盖该路径及其所有子路径。
- **轮换凭据**：为供应商配置多个 API Key，运行时会结合会话粘性和每个凭据的退避机制轮换使用。一个密钥容易耗尽配额时尤其有用。

完整的供应商和路由参考见 [omp.sh/docs/providers](https://omp.sh/docs/providers)。

## 二十三种后端，代理已经会用的一个工具

web_search 是内置工具，而不是外挂功能。auto 会遍历二十三个供应商，也可以在已经购买某项服务时按名称固定。每次命中后，站点感知的提取器会将 GitHub、软件包仓库、arXiv、Stack Overflow 和文档转换为结构化 Markdown，并保留锚点与链接目标。

### 搜索供应商

共有二十三种后端。可以固定一个，也可以让 auto 按顺序遍历。

| 供应商 | 认证方式 |
| --- | --- |
| auto | 链式选择 |
| perplexity | PERPLEXITY_API_KEY（匿名回退） |
| gemini | oauth |
| anthropic | oauth |
| codex | oauth |
| xai | oauth 或 XAI_API_KEY |
| zai | ZAI_API_KEY |
| exa | EXA_API_KEY（或 mcp） |
| tinyfish | TINYFISH_API_KEY |
| jina | JINA_API_KEY |
| kagi | KAGI_API_KEY |
| tavily | TAVILY_API_KEY |
| firecrawl | FIRECRAWL_API_KEY（无密钥回退） |
| brave | BRAVE_API_KEY |
| kimi | /login kimi-code 或搜索密钥 |
| parallel | PARALLEL_API_KEY |
| synthetic | SYNTHETIC_API_KEY |
| searxng | 自托管 |
| duckduckgo | 不需要密钥 |
| startpage | 不需要密钥 |
| google | 不需要密钥（浏览器） |
| ecosia | 不需要密钥（浏览器） |
| mojeek | 不需要密钥（浏览器） |
| public | 不需要密钥（整合上述供应商） |

Exa 也支持通过 /login exa 保存 API Key；明确选择无密钥模式时，会使用公开 MCP 回退。

### 专用处理器

代理获得的是结构化内容，而不是被剥离后的 HTML。

- **代码托管平台**：github、gitlab；
- **软件包仓库**：npm、PyPI、crates.io、Hex、Hackage、NuGet、Maven、RubyGems、Packagist、pub.dev、Go packages；
- **研究来源**：arxiv、semantic scholar；
- **论坛**：Stack Overflow、reddit、Hacker News；
- **文档**：MDN、Read the Docs、docs.rs。

页面会转换为保留链接结构的 Markdown。代理可以引用、跟进和摘录，而不会丢失锚点。

### 安全数据库

漏洞查询直接使用供应商数据，而不是博客摘要。

- **NVD**：国家漏洞数据库；
- **OSV**：开源漏洞数据源；
- **CISA KEV**：已知被利用漏洞目录。

[查看 web_search 参考 ↗](https://omp.sh/docs/tools#web_search)

## 约 8 万行 Rust，负责其他代理需要通过外部进程完成的工作

六个 crate 加一个带平台标签的 N-API 插件。搜索、shell、AST、语法高亮、PTY、桌面控制、图像解码和 BPE 计数都在 libuv 线程池中进程内完成，热点路径不需要 fork/exec。另有约 8 万行 vendored 代码随项目发布，包括 brush bash 分支，以及 58 个命令行工具——coreutils、findutils、sed、jq、基于 ripgrep 的 grep、fd、diff 和 moreutils——已移植到 `pi-builtins` crate 并直接编译进 shell。

- Crate：pi-natives、pi-shell、pi-ast、pi-iso、pi-voice、pi-walker；
- 平台：linux-x64、linux-arm64、darwin-x64、darwin-arm64、win32-x64；x64 提供 AVX2 和基础指令集两套二进制文件。

以下仅统计各 crate 的代码行数：

| Crate | 功能 | 约 LoC |
| --- | --- | ---: |
| pi-shell | 内嵌 bash 引擎、持久化会话、进程内 coreutils 调度和最小化器 | 38,000 |
| pi-natives | N-API 接口，包含下表中的所有模块 | 25,000 |
| pi-walker | 并行且遵循忽略规则的遍历器，以及 grep、glob、workspace、shell 共用的扫描缓存 | 5,200 |
| pi-iso | 工作区隔离，支持 APFS、btrfs、zfs、reflink、overlayfs、projfs、rcopy | 3,300 |
| pi-ast | tree-sitter 和 ast-grep 匹配、区块解析与结构化摘要 | 2,900 |
| pi-voice | 音频采集和播放、Opus、实时 WebRTC | 1,000 |

pi-natives 内部的模块代码行数如下（不含胶水代码和测试）：

| 模块 | 功能 | 依赖 | 约 LoC |
| --- | --- | --- | ---: |
| desktop | 窗口和显示器枚举、截图、原生输入、computer 的辅助功能树 | xcap · enigo · OS AX FFI | 10,600 |
| grep | 正则搜索、并行/串行模式、glob 和类型过滤、模糊查找 | grep-regex · grep-searcher | 3,280 |
| text | 支持 ANSI 的宽度、截断、列切片和保留 SGR 的换行 | unicode-width · segmentation | 2,070 |
| snapcompact | 用于上下文压缩的位图帧栅格化和 PNG 编码 | image · png | 1,760 |
| keys | 带 xterm 回退的 Kitty 键盘协议和 PHF 完美哈希查找 | phf | 1,740 |
| ast | ast-grep 模式匹配和结构化重写 | ast-grep-core | 1,510 |
| diff | 用于工具和预览的结构化文件 diff | 内置实现 | 1,030 |
| pty | 用于 sudo 和 ssh 交互式提示的原生 PTY 分配 | portable-pty | 630 |
| crash_handler | 原生崩溃捕获和报告 | 内置实现 | 610 |
| highlight | 语法高亮，支持 11 个语义类别和 30 多个别名 | syntect | 550 |
| appearance | Mode 2031，以及通过 CoreFoundation FFI 实现的 macOS 原生深浅色模式 | core-foundation | 450 |
| task | 在 libuv 线程池上执行阻塞工作，支持取消、超时和性能分析 | tokio · napi | 440 |
| glob | 支持 glob、类型过滤、mtime 排序和 gitignore 的查找 | ignore · globset | 430 |
| fd | 用于替代 find 工具的文件系统遍历器 | ignore | 385 |
| clipboard | 文本复制和系统剪贴板图片读取，无需 xclip/pbcopy | arboard | 370 |
| workspace | 一次遍历工作区、遵循 gitignore 并发现 AGENTS.md | ignore | 275 |
| power | macOS 电源断言 API，防止系统、显示器或设备进入空闲休眠 | IOKit FFI | 270 |
| prof | 支持折叠栈和 SVG 火焰图输出的环形缓冲区分析器 | inferno | 240 |
| file_lock | 跨进程建议式文件锁 | 内置实现 | 210 |
| ps | 跨平台进程树终止和子进程枚举 | libc · libproc · CreateToolhelp32Snapshot | 195 |
| tokens | O200k / Cl100k BPE Token 计数，内置两张表 | tiktoken-rs | 70 |
| html | HTML 转 Markdown，可选内容清理 | html-to-markdown-rs | 60 |
| sixel | 终端图片渲染、PNG/JPEG/WebP/GIF 解码、缩放和 SIXEL 编码 | icy_sixel · image | 55 |

## 四种入口：交互式、单次执行、RPC 与 ACP

同一套引擎提供四种封装。omp 运行 TUI；omp -p 回答一次提示并退出；Node SDK 可以将会话嵌入进程；omp --mode rpc 和 omp acp 则通过标准输入输出将控制权交给其他程序。

### 交互式：需要确认时，代理会主动询问

TUI 是默认界面。工具调用会显示为卡片，编辑会在落盘前预览，遇到歧义时会通过 ask 工具显示结构化选项供代理在当前回合调用。其余操作由键盘完成。

同样的提示卡片也会通过 ACP 显示，因此编辑器无需自己实现选项选择器。

![omp TUI：ask 工具显示包含三个选项的选择器，第一项带有“推荐”标记，底部显示上下移动、回车选择和 Esc 取消。](https://omp.sh/captures/ask.webp)

### SDK：嵌入 Node

@oh-my-pi/pi-coding-agent

Node 和 TypeScript 宿主可以直接载入引擎。软件包提供 ModelRegistry、SessionManager、createAgentSession 和 discoverAuthStorage；会话会发出可订阅的类型化事件。

```ts
import {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
} from "@oh-my-pi/pi-coding-agent";

const auth = await discoverAuthStorage();
const models = new ModelRegistry(auth);
await models.refresh();

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: auth,
  modelRegistry: models,
});
await session.prompt("列出 .ts 文件");
```

### RPC：通过标准输入输出驱动

omp --mode rpc

适合非 Node 嵌入场景，或需要进程隔离的场景。输入 NDJSON 命令，输出响应和事件帧；omp --mode rpc-ui 会额外加入工具卡片、选择器和对话框，宿主程序必须响应 extension_ui_request 帧。

```text
$ omp --mode rpc --no-session
> {"id":"r1","type":"prompt","message":"列出 .ts 文件"}
< {"id":"r1","type":"response","message":"已列出 .ts 文件"}
> {"id":"r2","type":"set_model","provider":"anthropic","modelId":"sonnet-4.5"}
> {"id":"r3","type":"abort"}
```

### ACP：与编辑器协作

omp acp

[Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) 通过 JSON-RPC 工作。当编辑器声明能力后，工具输入输出会通过编辑器传递，写入操作会经过 session/request_permission 权限确认。

| omp 工具 | ACP 路由 |
| --- | --- |
| bash | terminal/create + terminal/output |
| read | fs/read_text_file |
| write | fs/write_text_file |
| edit, bash | session/request_permission |

完整参考：[omp.sh/docs/sdk](https://omp.sh/docs/sdk)。

## 面向中文用户的可扩展终端工作流

oh-my-pi-cn 延续上游面向终端的工作流设计，并将中文界面、供应商配置和日常操作提示作为本分支的重点。

本项目基于 [Pi](https://github.com/badlogic/pi-mono)（作者
[Mario Zechner](https://github.com/mariozechner)）和
[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)，提供会话、子代理、斜杠命令和扩展能力。
核心代码继续采用 TypeScript，并遵循 MIT 协议；本分支在此基础上维护简体中文体验。

### 基础组件

扩展是一个 TypeScript 模块，使用与内置功能相同的工具 API、斜杠命令注册表、快捷键表和 TUI 原语。没有任何功能被预留为不可扩展区域。

### 自动发现

首次运行时，omp 会直接读取磁盘上已有的规则、技能和 MCP 服务器配置，包括 .claude、.cursor、.windsurf、.gemini、.codex、.cline、.github/copilot 和 .vscode。不需要迁移脚本。

### 可扩展性

让 omp 编写缺少的功能，然后执行 /reload-plugins。可以只在本地使用，也可以放入 marketplace，或发布到 npm。

## 设计理念

omp 是 [Pi](https://github.com/badlogic/pi-mono) 的一个分支，由
[Mario Zechner](https://github.com/mariozechner) 创建，并扩展为功能齐全的 AI 编程工作流。

核心理念：

- 保持面向真实编码工作的交互式终端体验；
- 提供实用的内置能力，包括工具、会话、分支、子代理和扩展；
- 让高级行为可以配置，而不是隐藏在系统内部。

---

## 开发

### 从源码开始

全新克隆的仓库需要安装 workspace 依赖，并构建本地 Rust/N-API 扩展后，源码 CLI 才能启动。

```sh
bun setup
bun dev
```

bun setup 会安装 Bun workspace，并构建 @oh-my-pi/pi-natives。修改 Rust crate 或 packages/natives 后，请重新运行 bun run build:native。

Nix 用户可获得固定版本的 Bun、Rust 工具链和全部原生构建依赖：

```sh
nix develop
bun setup
bun dev
```

使用 `nix build .#omp` 构建并冒烟测试可分发的 Nix 包。Wayland 屏幕录制默认关闭（链接 libpipewire 会增加约 750 MB 运行时闭包）；可通过 `omp.override { withWaylandScreencast = true; }` 启用。`nix/bun.nix` 只在 `bun.lock` 变化时生成，发行流程会自动重新生成。依赖变化后运行：

```sh
bun run gen:nix
```

该命令优先使用 `nix develop` 提供的 `bun2nix`，否则通过 Nix 进入开发环境，最后回退到固定版本的 `bunx bun2nix@2.1.2`。不要手动编辑 `nix/bun.nix`。

执行非交互式冒烟检查：

```sh
bun dev -- --version
```

### 调试命令

/debug 会打开调试、报告和性能分析工具。

架构和贡献指南见 [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md)。

---

## 仓库软件包

| 软件包 | 说明 |
| --- | --- |
| **[@oh-my-pi/collab-web](packages/collab-web)** | 浏览器访客客户端、模拟宿主和协作实时会话的本地 relay |
| **[@oh-my-pi/pi-ai](packages/ai)** | 支持流式传输、多供应商和模型集成的 LLM 客户端 |
| **[@oh-my-pi/pi-catalog](packages/catalog)** | 模型目录，包含内置模型数据库、供应商描述和身份信息 |
| **[@oh-my-pi/pi-agent-core](packages/agent)** | 支持工具调用和状态管理的代理运行时 |
| **[@oh-my-pi/pi-coding-agent](packages/coding-agent)** | 交互式编程代理 CLI 和 SDK |
| **[@oh-my-pi/pi-tui](packages/tui)** | 支持差分渲染的终端 UI 库 |
| **[@oh-my-pi/pi-natives](packages/natives)** | 支持 grep、shell、图像、文本、语法高亮等功能的 N-API 绑定 |
| **[@oh-my-pi/omp-stats](packages/stats)** | 本地 AI 使用量统计和可观测性面板 |
| **[@oh-my-pi/omptype](packages/omptype)** | 支持延迟 JIT 编译的 ArkType 兼容校验库 |
| **[@oh-my-pi/pi-utils](packages/utils)** | 共享日志、流、目录、环境和进程辅助工具 |
| **[@oh-my-pi/pi-wire](packages/wire)** | 协作实时会话协议类型和 relay 常量 |
| **[@oh-my-pi/hashline](packages/hashline)** | edit 工具使用的按行锚定补丁语言和应用器 |
| **[@oh-my-pi/pi-mnemopi](packages/mnemopi)** | 面向代理的本地 SQLite 记忆引擎 |
| **[@oh-my-pi/snapcompact](packages/snapcompact)** | 用于上下文压缩的位图帧压缩软件包和 SQuAD 评估套件 |
| **[@oh-my-pi/browser-relay](packages/browser-relay)** | 让 browser 工具操作现有标签页的 Chrome 扩展 |
| **[@oh-my-pi/pi-metaharness](packages/metaharness)** | 统一的基准运行器、Harbor 运行存储、REST/SSE API 和实时面板 |
| **[@oh-my-pi/typescript-edit-benchmark](packages/typescript-edit-benchmark)** | 基于 TypeScript 源码变异的编辑基准套件 |

### Rust 原生模块

| Crate | 说明 |
| --- | --- |
| **[pi-natives](crates/pi-natives)** | @oh-my-pi/pi-natives 使用的核心 Rust 原生扩展（N-API cdylib），聚合下列 crate |
| **[pi-shell](crates/pi-shell)** | 从 pi-natives 拆出的嵌入式 shell、PTY 和进程管理，封装 brush-* |
| **[pi-ast](crates/pi-ast)** | 基于 tree-sitter 的代码摘要和 AST 工具，包含 50 多种语言语法 |
| **[pi-iso](crates/pi-iso)** | 任务隔离后端解析器，支持 APFS 克隆、btrfs/zfs reflink、overlayfs、projfs 和 rcopy |
| **[pi-voice](crates/pi-voice)** | 音频采集/播放、Opus 编解码和实时 WebRTC 流式能力 |
| **[pi-walker](crates/pi-walker)** | 并行、遵循忽略规则的文件遍历器，与 grep 共用扫描缓存 |
| **[brush-core](crates/vendor/brush-core)** | [brush-shell](https://github.com/reubeno/brush) 的 vendored 分支，用于嵌入式 bash 执行 |
| **[pi-builtins](crates/pi-builtins)** | Bash 内置命令（cd、echo、test、printf、read、export 等），以及 67 个进程内命令行工具 |

## 参与贡献

欢迎参与中文校对、平台安装验证、供应商文档、演示素材和上游新增文本审查。第一次参与不需要理解整个代码库，可以从
[可认领的维护任务](docs/CONTRIBUTOR_TASKS.md) 或带有
[`good first issue`](https://github.com/yequ172672/oh-my-pi-cn/issues?q=is%3Aissue+label%3A%22good+first+issue%22) 标签的任务开始。

- [Issues](https://github.com/yequ172672/oh-my-pi-cn/issues)：可复现问题和范围明确的维护任务；
- [Discussions](https://github.com/yequ172672/oh-my-pi-cn/discussions)：使用问答、开放想法和社区交流；
- [中文贡献指南](CONTRIBUTING.md)：开发环境、本地化边界、验证和 Pull Request 要求；
- [社区行为规范](CODE_OF_CONDUCT.md) 与 [支持入口](SUPPORT.md)。

涉及上游核心能力的改动，请同时关注 can1357/oh-my-pi 的实现和更新；涉及中文界面、提示、供应商向导、文档与安装体验的改动，可直接在本分支提出。

维护、上游同步、冲突处理、本地化适配、npm 发布和 GitHub Release 的操作说明见
**[中文分支维护与发布流程](docs/MAINTENANCE.md)**。

## 分支维护与致谢

- 分支维护者：yequ172672
- B 站 ID：夜曲_flac
- 当前维护分支：main
- 上游项目：[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
- 上游原作者：Mario Zechner、Can Bölük
- 本分支特色：简体中文界面与提示本地化、供应商设置与首次启动向导本地化，以及独立的
  omp-cn 安装和更新路径。

本分支是在上游项目基础上的本地化维护工作；上游作者、版权声明和原有 MIT 开源协议均予以保留。

---

## 许可证

OMP 及本中文分支均遵循 [MIT 许可证](LICENSE)。

第三方及 vendored 代码（包括 `crates/vendor/brush-core`，以及 `crates/pi-builtins/LICENSE` 标明的第三方部分）仍遵循各自的上游许可证。署名和附加条款请参阅 [`THIRD-PARTY-NOTICES.txt`](THIRD-PARTY-NOTICES.txt) 及各组件目录中的声明。

© 2025 Mario Zechner<br>
© 2025-2026 Can Bölük<br>
© 2026 Stencil Labs, Inc.
© 2026 yequ172672

_为始终保持打开的终端而作_

- [上游项目主页](https://omp.sh)
- [GitHub 仓库](https://github.com/yequ172672/oh-my-pi-cn)
- [项目网站](https://yequ172672.github.io/oh-my-pi-cn/)
- [参与维护](https://github.com/yequ172672/oh-my-pi-cn/blob/main/CONTRIBUTING.md)
- [社区讨论](https://github.com/yequ172672/oh-my-pi-cn/discussions)
- [中文分支变更日志](https://github.com/yequ172672/oh-my-pi-cn/blob/main/docs/FORK_CHANGELOG.md)
- [上游包变更日志](https://github.com/yequ172672/oh-my-pi-cn/blob/main/packages/coding-agent/CHANGELOG.md)
- [npm 软件包](https://www.npmjs.com/package/omp-cn)
- [Discord 社区](https://discord.gg/4NMW9cdXZa)
- [MIT 许可证](https://github.com/yequ172672/oh-my-pi-cn/blob/main/LICENSE)
