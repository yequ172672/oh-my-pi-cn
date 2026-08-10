# 复用本机 Codex 订阅登录的实现调研

> 调研日期：2026-08-10。本文只记录公开源码与官方文档，不包含、复制或打印任何本机凭据。

## 结论

OMP 可以增加一个“使用现有 Codex 登录”的可选 provider，但正确目标不是把 `auth.json` 复制进 OMP，也不是在 OMP 内再实现一套 OAuth。真正需要复用的是**同一个登录权威与刷新生命周期**。

本次实现采用以下边界：

1. **MVP 主路径：App Server 兼容认证 RPC + OMP 现有 Responses transport。** OMP 启动本机 `codex app-server`，调用 `getAuthStatus { includeToken: true, refreshToken: false | true }` 取得当前短期 access token；Codex 继续独占 OAuth、真实 refresh token、file/keyring 差异与刷新持久化。OMP 不读取 `auth.json`，也不获得或保存真实 refresh token。
2. **严格限定 ChatGPT 登录。** RPC 结果必须满足 `authMethod === "chatgpt"`，同时带可用、可解析到期时间和 ChatGPT account id 的 `authToken`；API key、其他 auth mode 或缺少 token 均 fail closed，不能静默改用按量计费 API。
3. **不建议：复制 `auth.json` 或 refresh token。** ChatGPT OAuth refresh token 实际具有 single-use 轮换语义。官方主线虽已增加“刷新前重读共享 storage”的保护，但独立副本仍会漂移；file backend 当前也没有跨进程锁和原子替换。
4. **更大替代方案：完整 App Server turn/thread transport。** 直接映射 `model/list`、`thread/start`、`turn/start` 与事件流，可以进一步避免 OMP 持有短期 bearer，但会改变现有 agent/tool/stream 边界，不属于本次 MVP。

因此，本目标已经验证可行：OMP 只临时持有 App Server 返回的短期 access token，长期登录权威仍是官方 Codex。其代价是 `getAuthStatus` 属于兼容/旧版 RPC，未来 Codex 版本可能移除或改变它，必须保留明确的版本不兼容错误与回归验证。

## 项目识别与快照

调研仓库均克隆到本地 `参考项目/`，该目录已加入根 `.gitignore`。固定快照如下：

| 用户称呼 | 识别结果 | 仓库与固定提交 | 识别依据 |
| --- | --- | --- | --- |
| CC-Switch / ccswitch | `farion1231/cc-switch` | [仓库](https://github.com/farion1231/cc-switch) · [`413c09e0790c304506888ae24b9be72820aca126`](https://github.com/farion1231/cc-switch/tree/413c09e0790c304506888ae24b9be72820aca126) | 仓库自身声明唯一官网为 `ccswitch.io`，且源码包含 Codex provider、配置切换与 OAuth 代理实现。 |
| CPA | 高概率指 CLIProxyAPI | [仓库](https://github.com/router-for-me/CLIProxyAPI) · [`2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e`](https://github.com/router-for-me/CLIProxyAPI/tree/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e) | `CPA` 是语境推断；该项目把 ChatGPT Codex OAuth 包装成兼容 API，并包含 GPT-5.6 Codex 模型。 |
| OpenCodex | `lidge-jun/opencodex` | [仓库](https://github.com/lidge-jun/opencodex) · [`121f1ad929dc6da3356c06f5192f2f97f7a5dde5`](https://github.com/lidge-jun/opencodex/tree/121f1ad929dc6da3356c06f5192f2f97f7a5dde5) | 项目文档明确区分 Direct、Pool 与 Codex 主账号复用，并实现 `~/.codex/auth.json` 只读路径。 |
| 旧名 OpenCodex 的歧义项 | `AITabby/codexsplit` | [仓库](https://github.com/AITabby/codexsplit) · [`c258bae2978cccdfdb5b60170362d845b28c5dc1`](https://github.com/AITabby/codexsplit/tree/c258bae2978cccdfdb5b60170362d845b28c5dc1) | 旧地址 `AITabby/opencodex` 现跳转到 CodexSplit；它也有局部读取官方 `auth.json` 的代码，但账号池仍调用 `codex login`。 |
| 官方基线 | `openai/codex` | [仓库](https://github.com/openai/codex) · [`a16863f8704831d13e041ed7dba2c4a57a2a940b`](https://github.com/openai/codex/tree/a16863f8704831d13e041ed7dba2c4a57a2a940b) | 用于核验真实认证存储、刷新竞争、App Server API 与官方支持边界。 |

“CPA 指 CLIProxyAPI”不是名称上的确定事实。若用户实际指另一个 CPA 项目，应补充仓库 URL 后再做一次身份核验；本文所有 CPA 结论仅对应上表提交。

## 官方认证基线

OpenAI 官方认证文档区分两种计费与授权来源：使用 ChatGPT 登录获得订阅访问，使用 API key 则按 OpenAI Platform API 计费；两者不是可互换的 credential。文档同时说明 CLI 与 IDE extension 共享缓存，活动会话会自动刷新；凭据可能在 `CODEX_HOME/auth.json`，也可能由 OS credential store 保存，具体由 `cli_auth_credentials_store = file | keyring | auto` 决定。file 模式的 `auth.json` 必须按密码处理。[官方 Authentication 文档](https://learn.chatgpt.com/docs/auth#login-caching)

这带来三个实现约束：

- 不能假定每台机器都有可读的 `~/.codex/auth.json`；`keyring` 或 `auto` 可能只在系统凭据库中有值。
- ChatGPT 订阅 OAuth 不是 `OPENAI_API_KEY`，不能把 token 填入现有 `api.openai.com/v1` provider 就声称完成。
- 官方文档允许把 auth cache 复制到受信任的无头机器作为 fallback，但也要求将其视为密码；与此同时，当前公开 issue 已显示复制后的 refresh 生命周期并不可靠。文档允许一次传输，不等于两个长期并行副本可以安全刷新。[官方 headless fallback](https://learn.chatgpt.com/docs/auth#fallback-authenticate-locally-and-copy-your-auth-cache)

官方还支持在 Codex 的自定义 provider 中配置 `requires_openai_auth = true`，由 Codex 把自己的 OpenAI 登录用于代理。这证明“认证与路由解耦”是官方 Codex 支持的配置能力，但它授权的是 **Codex 客户端自身**使用其登录，不是任意第三方程序抽取 token 后调用私有后端。[官方 Alternative model providers](https://learn.chatgpt.com/docs/auth#alternative-model-providers)

## 各参考项目的真实机制

### CC-Switch：保留登录与重新 OAuth 是两条不同路径

CC-Switch 有一条适合借鉴的“配置切换但保留官方登录”路径：

- [`get_codex_auth_path`](https://github.com/farion1231/cc-switch/blob/413c09e0790c304506888ae24b9be72820aca126/src-tauri/src/codex_config.rs#L178-L180) 定位 `~/.codex/auth.json`。
- live 配置写入只处理 `config.toml`，代码注释明确让登录态留在 `auth.json`；见 [`codex_config.rs`](https://github.com/farion1231/cc-switch/blob/413c09e0790c304506888ae24b9be72820aca126/src-tauri/src/codex_config.rs#L315-L320)。
- 配置检测能识别 `tokens.id_token`、`access_token` 和 `refresh_token`；见 [`detect_codex_auth`](https://github.com/farion1231/cc-switch/blob/413c09e0790c304506888ae24b9be72820aca126/src-tauri/src/codex_config.rs#L400-L450)。
- 使用 `requires_openai_auth = true` 时，仍由 Codex 使用现有 ChatGPT 登录；见 [provider 配置生成](https://github.com/farion1231/cc-switch/blob/413c09e0790c304506888ae24b9be72820aca126/src-tauri/src/codex_config.rs#L1773-L1779)。
- 代理路由指向本地 `/responses`，且不需要把假 API key 写进 `auth.json`；见 [本地代理配置](https://github.com/farion1231/cc-switch/blob/413c09e0790c304506888ae24b9be72820aca126/src-tauri/src/codex_config.rs#L1823-L1827)。

项目指南也明确要求先由 Codex 完成官方登录、第三方 provider 只改配置，并警告不要分享 auth 文件。[官方登录保留指南](https://github.com/farion1231/cc-switch/blob/413c09e0790c304506888ae24b9be72820aca126/docs/guides/codex-official-auth-preservation-guide-en.md#L12-L16)

但 CC-Switch 的“OAuth 认证中心”是另一套机制，并不导入现有 Codex 登录：

- [`codex_oauth_auth.rs`](https://github.com/farion1231/cc-switch/blob/413c09e0790c304506888ae24b9be72820aca126/src-tauri/src/proxy/providers/codex_oauth_auth.rs#L1-L46) 内置 OAuth 端点和 client id。
- [`start_device_flow`](https://github.com/farion1231/cc-switch/blob/413c09e0790c304506888ae24b9be72820aca126/src-tauri/src/proxy/providers/codex_oauth_auth.rs#L222-L318) 重新发起 device OAuth，并使用独立的 `codex_oauth_auth.json`。
- token exchange 会保存自己的 refresh token，随后自动刷新自己的账号；见 [交换与保存](https://github.com/farion1231/cc-switch/blob/413c09e0790c304506888ae24b9be72820aca126/src-tauri/src/proxy/providers/codex_oauth_auth.rs#L360-L472) 和 [刷新](https://github.com/farion1231/cc-switch/blob/413c09e0790c304506888ae24b9be72820aca126/src-tauri/src/proxy/providers/codex_oauth_auth.rs#L496-L562)。

所以 CC-Switch 的可复用思想是“auth/config 分离”和“让官方客户端保持认证所有权”，不是它的独立 OAuth 账号中心。

### CLIProxyAPI：优秀的协议代理参考，但默认仍需再登录

CLIProxyAPI 确实支持 ChatGPT Codex OAuth 和兼容 API；其 README 直接列出 Codex GPT OAuth。[README](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/README.md#L115-L121)

源码显示它走自己的认证生命周期：

- [`Login`](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/sdk/auth/codex.go#L38-L53) 选择 browser 或 device flow；browser flow 自建 `localhost:1455` 回调与 OAuth URL。[browser flow](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/sdk/auth/codex.go#L68-L113)
- device flow 请求 device code、打开浏览器并轮询 token；见 [`codex_device.go`](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/sdk/auth/codex_device.go#L64-L125)。
- CLI 登录完成后写入自己的 auth directory；见 [`DoCodexLogin`](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/internal/cmd/openai_login.go#L29-L71)。默认目录是 `~/.cli-proxy-api`。[示例配置](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/config.example.yaml#L36)
- 它使用自己的扁平 token 文件结构，而官方 Codex 当前是嵌套的 `tokens.*`；见 [`CodexTokenStorage`](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/internal/auth/codex/token.go#L15-L80)。

对该固定提交全树搜索，没有发现读取 `.codex/auth.json` 或 `CODEX_HOME` 并导入官方 Codex schema 的原生实现。因此它不满足“不再登录一次”。管理 API 即使允许上传 JSON，也不能视为安全、兼容的官方登录导入器。

CLIProxyAPI 仍是很有价值的协议参考：

- Codex executor 把请求发往 Codex Responses 后端，并构造所需 header；见 [`codex_executor_execute.go`](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/internal/runtime/executor/codex_executor_execute.go#L21-L33) 与 [请求组装](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/internal/runtime/executor/codex_executor_execute.go#L76-L83)。
- 它对自己的 refresh 做并发合并，并识别 token-reused 失败；见 [refresh client](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/internal/auth/codex/openai_auth.go#L187-L223) 和 [singleflight/错误分类](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/internal/auth/codex/openai_auth.go#L299-L336)。
- 模型发现会带 bearer 与 account header 请求 Codex model endpoint；见 [`fetch_codex_models`](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/cmd/fetch_codex_models/main.go#L231-L248)。

### lidge-jun/OpenCodex：现有登录复用最直接，但自己不刷新主账号

OpenCodex 的“main account”路径直接满足无重登的短期目标：

- [`readCodexAuthJson`](https://github.com/lidge-jun/opencodex/blob/121f1ad929dc6da3356c06f5192f2f97f7a5dde5/src/codex/auth-collision.ts#L30-L68) 解析 `resolveCodexHomeDir()/auth.json` 的 `tokens.access_token`、`account_id` 和 `id_token`，错误分类不回显 token。
- [`readMainCodexAuth`](https://github.com/lidge-jun/opencodex/blob/121f1ad929dc6da3356c06f5192f2f97f7a5dde5/src/codex/main-account.ts#L22-L40) 明确标注“Read-only main account token”，并检查 JWT 过期。
- Direct 模式从入站 `Authorization` 取得已有 bearer；见 [`resolveIncomingCodexBearer`](https://github.com/lidge-jun/opencodex/blob/121f1ad929dc6da3356c06f5192f2f97f7a5dde5/src/codex/auth-context.ts#L248-L264)。
- Pool 的主账号分支重读现有 auth 文件，缺失或过期则 fail closed；见 [`auth-context.ts`](https://github.com/lidge-jun/opencodex/blob/121f1ad929dc6da3356c06f5192f2f97f7a5dde5/src/codex/auth-context.ts#L380-L401)。
- 上游请求注入 `Authorization` 和 `chatgpt-account-id`；见 [header 注入](https://github.com/lidge-jun/opencodex/blob/121f1ad929dc6da3356c06f5192f2f97f7a5dde5/src/codex/auth-context.ts#L438-L465)。
- loopback 集成保留 Codex 内建 `openai` provider，只将 `openai_base_url` 指向本地代理；见 [`inject.ts`](https://github.com/lidge-jun/opencodex/blob/121f1ad929dc6da3356c06f5192f2f97f7a5dde5/src/codex/inject.ts#L746-L769)。

项目文档明确区分 Direct 与 Pool：Direct 复用入站 Codex auth，Pool 的 main account 读取官方 Codex 登录；添加额外 ChatGPT 账号则仍需独立 OAuth，并保存到 `~/.opencodex/auth.json`。[provider 指南](https://github.com/lidge-jun/opencodex/blob/121f1ad929dc6da3356c06f5192f2f97f7a5dde5/docs-site/src/content/docs/guides/providers.md#L68-L95)

重要限制：OpenCodex 的 main-account helper 只读取并检查 access token，没有使用官方 refresh token 自行续期。因此它的长期稳定性依赖另一个官方 Codex 进程持续刷新 `auth.json`；在 keyring-only 模式下也可能没有文件可读。它证明了只读桥接可行，但没有完整解决认证生命周期。

### AITabby/CodexSplit：旧名歧义，不应作为主要 OpenCodex 依据

CodexSplit 的 realtime proxy 也会读取 `~/.codex/auth.json`，提取 access token，替换本地 placeholder bearer 后转发到 ChatGPT 后端；见 [`webrtc_proxy.ts`](https://github.com/AITabby/codexsplit/blob/c258bae2978cccdfdb5b60170362d845b28c5dc1/src_v2/server/webrtc_proxy.ts#L14-L83)。但其账号池会为隔离的 `CODEX_HOME` 启动原生 `codex login`；见 [`chatgpt_account_auth.ts`](https://github.com/AITabby/codexsplit/blob/c258bae2978cccdfdb5b60170362d845b28c5dc1/src_v2/services/chatgpt_account_auth.ts#L61-L130)。它是“部分复用、池账号重登”，不是比 lidge-jun/OpenCodex 更完整的答案。

## 官方 Codex refresh token 漂移审计

这一部分决定 OMP 是否能安全地“复制现有登录”。结论是不能。

### 当前 main 已有的保护

在固定提交 `a16863f...` 中：

- [`AuthManager::refresh_token`](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/login/src/auth/manager.rs#L2619-L2656) 先取得进程内 `Semaphore`，再从 active auth source 重读。如果 storage 中 token 已被其他使用者更新，它会跳过重复刷新。
- [`persist_tokens`](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/login/src/auth/manager.rs#L1478-L1501) 在写入 refresh response 前再次 `storage.load()`，避免基于过旧的整份结构覆盖其他字段。
- [`classify_refresh_token_failure`](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/login/src/auth/manager.rs#L1548-L1556) 已把 `refresh_token_reused` 映射为 `Exhausted`。
- [`refresh_and_persist_chatgpt_token`](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/login/src/auth/manager.rs#L2846-L2864) 请求刷新、持久化响应并重载内存 cache。

这些保护解决的是**同一个 active storage 被共同观察时**的部分竞争，不会让两个复制出来的 refresh token 自动同步。

### 当前 main 仍没有的保护

[`FileAuthStorage::save`](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/login/src/auth/storage.rs#L202-L218) 当前直接以 `truncate(true)` 打开 `auth.json`，随后 write + flush。该实现没有临时文件 + rename 原子替换，也没有跨进程文件锁。`AuthManager` 的 semaphore 只协调同一进程内实例，无法锁住另一个 Codex/OMP 进程。

因此即使 OMP 与官方 Codex 指向同一文件，也应让官方 Codex 成为唯一 refresh writer。本次实现不再让 OMP 读取该文件：file/keyring 的解析、轮换和持久化都留在 App Server 内，OMP 只消费 RPC 返回的短期 access token。若 OMP 复制出自己的凭据文件，则官方重读逻辑完全看不到另一份，漂移问题必然保留。

### issue #15502 与 #15410 的状态

- [#15502](https://github.com/openai/codex/issues/15502) 截至调研日仍是 **Open**。报告称复制 `auth.json` 后即使执行刷新，session 仍可能无法使用。
- [#15410](https://github.com/openai/codex/issues/15410) 是 **Closed as not planned**。问题陈述直接指出 refresh token 为 single-use，两个副本中一方刷新会使另一方失效。

当前 main 的 guarded reload 可缓解“共用同一 source 的重复刷新”，但没有修复“两个独立副本同步”，也没有补齐 file backend 的跨进程原子性。因此不能把这两个 issue 视为已经完整修复。

## 本次 MVP：App Server 兼容认证 RPC

官方 App Server 文档明确说 ChatGPT managed 模式由 Codex 拥有 OAuth flow 与 refresh token，负责落盘和自动刷新。[认证模式](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/app-server/README.md#L2190-L2207) 这使 App Server 成为比直接解析 `auth.json` 更稳健的凭据边界：它天然服从用户选择的 file、keyring 或 auto 存储。

### 为什么不是 `account/read`

`account/read { refreshToken: true }` 的确会调用官方 `AuthManager::refresh_token()`；见 [`refresh_token_if_requested`](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/app-server/src/request_processors/account_processor.rs#L940-L952)。但返回的 [`GetAccountResponse`](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/app-server/src/request_processors/account_processor.rs#L1028-L1048) 只有 account 与 `requires_openai_auth`，不暴露 token。因此它适合无 token 的账号状态读取，不是本次 Responses transport 获取 bearer 的路径。

### `getAuthStatus` 的实际语义

兼容 RPC 的 v1 schema 包含 `includeToken`、`refreshToken` 两个参数，以及 `authMethod`、`authToken`、`requiresOpenaiAuth` 响应字段。[`GetAuthStatusParams` / `GetAuthStatusResponse`](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/app-server-protocol/src/protocol/v1.rs#L182-L206)

当前服务端实现会先按 `refreshToken` 决定是否调用官方刷新器；只有 `includeToken: true` 且认证可复用时才在 `authToken` 中返回当前短期 token。永久刷新失败、缺少认证或不适合该旧响应结构的认证模式不会返回 token。[`get_auth_status_response`](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/app-server/src/request_processors/account_processor.rs#L955-L1025)

本次 OMP 流程是：

1. 启动 `codex app-server --listen stdio://`，完成 `initialize` / `initialized`。
2. 首次绑定和正常重读调用 `getAuthStatus { includeToken: true, refreshToken: false }`。
3. 严格验证 `authMethod === "chatgpt"`、非空 `authToken`、JWT `exp` 与 `chatgpt_account_id`；不接受 API key 登录冒充订阅登录。
4. OMP 保存短期 access token 与“由 Codex CLI 管理”的 sentinel，不保存真实 refresh token。账号 id 同时用于阻止 Codex 已切换账号后静默改变 OMP 绑定。
5. refresh 时先以 `refreshToken: false` 采用 Codex 已持有的新 access token；只有 token 已过期或距过期不足五分钟，才调用 `refreshToken: true` 让官方 Codex 轮换并持久化，然后采用新 access token。
6. 模型发现和生成继续走 OMP 已有 Codex Responses transport，而不是重新实现 OAuth 或 App Server turn/thread agent。

这条边界使 OMP 不需要知道官方凭据来自 `auth.json` 还是 OS keyring，也不会与 Codex 竞争 single-use refresh token。

### 兼容性风险与更大替代方案

`getAuthStatus` 在官方协议枚举中已经位于 “DEPRECATED APIs” 区域，并标注由 `GetAccount` 取代。[协议声明](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/app-server-protocol/src/protocol/common.rs#L1225-L1241) 但新的 `account/read` 又刻意不暴露 token，所以当前没有等价的现代 bearer RPC。MVP 必须把“安装的 Codex 不支持共享当前 ChatGPT access token”作为明确兼容错误，不能回退到读取 `auth.json` 或重新 OAuth。

如果未来兼容 RPC 被移除，较大的替代方案是把 App Server 本身作为完整模型后端：使用 `model/list`、`thread/start`、`turn/start`，消费 `item/*`、delta 与 `turn/completed`，再映射到 OMP 的 message、reasoning、tool call、usage 和错误契约。[App Server 工作流](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/app-server/README.md#L73-L83) 该方案可让 OMP 连短期 bearer 都不持有，但改造和语义对齐范围明显更大；集成方还应遵循 App Server 的 `clientInfo` 约束。[clientInfo 约束](https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/app-server/README.md#L119-L135)

### 本机实测

在本机已登录的 Codex CLI `0.147.0` 上，本轮验收已完成：

- `getAuthStatus { includeToken: true, refreshToken: false }` 能返回 `authMethod: "chatgpt"` 与短期 access token；验证过程中未展示或写入 token 明文。
- 使用该短期 access token 实际调用账号范围的 Codex models endpoint，发现 `gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`。
- 使用 `gpt-5.6-sol` 完成了一次最小 Responses 请求并收到有效模型响应。

这证明当前机器和当前 Codex 版本上的端到端路径已经打通，但不消除兼容 RPC 随后续 Codex 版本漂移的风险。

## GPT-5.6 与协议要求

CLIProxyAPI 的固定模型表提供了当前 GPT-5.6 Codex slug 的源码证据：

- [`gpt-5.6-sol`](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/internal/registry/models/codex_client_models.json#L1-L5)
- [`gpt-5.6-terra`](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/internal/registry/models/codex_client_models.json#L112-L118)
- [`gpt-5.6-luna`](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/internal/registry/models/codex_client_models.json#L223-L229)

实现不应只硬编码这三项。账号、workspace、rollout 与服务端策略可能使可用模型不同：本次 MVP 使用兼容 RPC 返回的短期 bearer/account id 查询 Codex model endpoint，并对结果做账号隔离的短时缓存；本机实测也确认当前账号实际返回三者。CLIProxyAPI 的模型抓取实现展示了相同授权 header。[模型发现请求](https://github.com/router-for-me/CLIProxyAPI/blob/2e6b1d83f6c304a102aa33c1faf0a4f94d0d331e/cmd/fetch_codex_models/main.go#L231-L248)

HTTP bridge 也不能只做“base URL + token”替换，至少需要处理：

- Codex Responses 请求/响应与 SSE 增量；
- `Authorization: Bearer ...` 与 ChatGPT account header；
- tool calls、reasoning、usage、错误码和限流映射；
- 401 后刷新协调与单次安全重试；
- 模型身份、thinking effort 与服务端实际能力。

## 对比

| 方案/项目 | 复用现有登录 | 自己持有 refresh token | keyring 支持 | 无重登 | 适合 OMP 借鉴 |
| --- | --- | --- | --- | --- | --- |
| CC-Switch 配置保留 | 是，由官方 Codex 使用 | 否 | 由 Codex 处理 | 是，但使用者仍是 Codex | auth/config 分离、`requires_openai_auth` |
| CC-Switch OAuth 中心 | 否 | 是 | 独立存储 | 否 | 不建议复制 |
| CLIProxyAPI | 当前没有原生导入 | 是 | 不适用 | 否 | Responses 代理、模型发现、错误映射 |
| OpenCodex main/Direct | 是，读取或转发短期 bearer | main 不刷新 | main 文件路径不支持 | 是 | 只读桥接、fail closed、header 边界 |
| CodexSplit realtime | 局部是 | 账号池另管 | 文件路径为主 | 仅局部 | 次要交叉验证 |
| App Server `getAuthStatus` MVP | 是，RPC 返回短期 bearer | 由 Codex 持有 | 是 | 是 | 本次采用；复用现有 Responses transport |
| 完整 App Server turn/thread | 是，OMP 不接触 bearer | 由 Codex 持有 | 是 | 是 | 更大、更稳的替代方案 |

## OMP 已采用的接口边界

### 认证读取与刷新

provider 不直接解析磁盘格式，而是将 App Server 作为 credential owner：

```ts
interface CodexSubscriptionCredentialSource {
	readManagedCredentials(refreshToken: boolean, signal?: AbortSignal): Promise<OAuthCredentials>;
}
```

实现入口位于 `packages/ai/src/registry/oauth/openai-codex.ts` 的 `readOpenAICodexCliCredentials`、`parseOpenAICodexCliAuthStatus` 与 `refreshOpenAICodexCliToken`。它们只接受 ChatGPT auth，解析短期 access token 的到期时间和账号声明，并用 sentinel 表示 refresh 权威仍在 Codex CLI。

access token 仍属于 secret，只能进入已有 credential/transport 路径，不得出现在进程参数、环境输出、日志、TUI、session 导出或 telemetry。配置和持久化层不得出现真实 Codex refresh token。

### Responses transport

认证层取得短期 credential 后，继续复用现有 transport：

```ts
interface CodexSubscriptionTransport {
	listModels(): Promise<readonly CodexSubscriptionModel[]>;
	streamResponses(request: CodexResponsesRequest): AsyncIterable<CodexResponsesEvent>;
}
```

正常刷新先通过 `getAuthStatus(... refreshToken: false)` 重读官方 owner 的 access token；接近过期时再以 `refreshToken: true` 请求官方 owner 刷新。严禁复制 refresh token。账号切换必须中止并要求用户重新确认绑定；401 重试必须有界，避免刷新风暴。

### 验收条件

- 本机 Codex 已登录时，启用 provider 不打开浏览器、不要求第二次 OAuth。
- file 与 keyring/auto 均通过 App Server 使用；OMP 不直接探测或读取其底层存储。
- Codex 与 OMP 并发运行、access token 过期、官方进程刷新后，OMP 不产生 `refresh_token_reused`，也不覆盖 `auth.json`。
- OMP 进程参数、环境打印、日志、TUI、错误、session 导出和 telemetry 均无 token/account id 明文。
- 兼容 RPC 必须严格要求 `authMethod === "chatgpt"`；API key、缺少 token、缺少 account id、Codex 进程退出或 RPC 不支持均 fail closed。
- models endpoint 返回的 GPT-5.6 模型可选择，stream、reasoning、tool call、usage 和取消均按 OMP contract 工作。
- 401/403、workspace 切换、logout 和 Codex 版本移除兼容 RPC 都能给出明确错误；没有无限重试或静默切到计费 API key。

## 安全、授权与服务条款边界

- 官方明确说 `auth.json` 应按密码处理，不得提交、贴到工单或聊天；OMP 也不应将其复制到自己的配置、secret store 或诊断包。[官方 credential storage](https://learn.chatgpt.com/docs/auth#credential-storage)
- 本地同一用户使用自己的账号，不等同于把账号共享给他人；但账号池、多人共享、转售、规避限流或公开暴露代理是完全不同的风险面，不应纳入第一版。
- `chatgpt.com/backend-api/codex` 是参考项目使用的私有 Codex 后端。公开官方文档没有承诺任意第三方 client 可以直接抽取 ChatGPT OAuth token 调用它；技术可行不能表述为 OpenAI 已批准或长期兼容。
- OpenCodex 明确声明项目未获供应商背书，并提醒某些供应商会限制经第三方代理的账号，应逐一核对条款。[OpenCodex disclaimer](https://github.com/lidge-jun/opencodex/blob/121f1ad929dc6da3356c06f5192f2f97f7a5dde5/README.md#L232-L236) CC-Switch 文档则把其 Codex OAuth 描述为 reverse-engineered，并提示 ToS/账号限制风险；这是项目自己的风险声明，不代表本文替 OpenAI 作出法律定性。[CC-Switch 风险说明](https://github.com/farion1231/cc-switch/blob/413c09e0790c304506888ae24b9be72820aca126/docs/user-manual/en/2-providers/2.1-add.md#L491-L499)
- 所以面向用户应准确说明这是“通过本机 Codex App Server 兼容认证 RPC 复用短期 access token”的订阅适配器，并提示兼容 RPC 与私有 Codex Responses 后端的版本风险；不做远程监听、账号池、负载均衡或额度规避。

## 最终选择

本次已经选择 **App Server 兼容认证 RPC + 现有 Codex Responses transport**。它在较小改造范围内实现了不重登、file/keyring 兼容和单一 refresh owner，也已由 Codex CLI 0.147.0 的实际模型发现与最小生成验证。

最容易失败的假设仍是“只要当前 access token 能请求 GPT-5.6，就等于完整复用了订阅”。本实现之所以成立，是因为 token 不是孤立复制：刷新权威、真实 refresh token 和底层存储始终留在官方 Codex，OMP 每次通过 App Server 重新取得短期状态，并校验账号绑定。直接复制 `auth.json` 会破坏这一边界，因此仍不应作为 fallback。若兼容 RPC 消失，应评估完整 App Server turn/thread transport，而不是退回文件解析。
