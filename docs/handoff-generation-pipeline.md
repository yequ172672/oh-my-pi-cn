# `/handoff` generation pipeline

This document describes how the coding-agent implements `/handoff`: trigger path, oneshot generation, session switch, context reinjection, persistence, and UI behavior.

## Scope

Covers:

- Interactive `/handoff` command dispatch
- `AgentSession.handoff()` lifecycle and state transitions
- `generateHandoffFromContext(...)` request shape and compatibility retry
- How old/new sessions persist handoff data differently
- UI behavior for success, cancel, and failure

Does not cover:

- Generic tree navigation/branch internals
- Non-handoff session commands (`/new`, `/fork`, `/resume`)

## Implementation files

- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`src/session/session-handoff.ts`](../packages/coding-agent/src/session/session-handoff.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`packages/agent/src/compaction/compaction.ts`](../packages/agent/src/compaction/compaction.ts)
- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)

## Trigger path

1. `/handoff` is declared in the builtin slash-command registry with optional inline hint `[focus instructions]`.
2. The registry's TUI handler clears the editor and calls `handleHandoffCommand(customInstructions?)`.
3. `CommandController.handleHandoffCommand` refuses while the current response is streaming, then counts `type === "message"` entries.
4. If the count is `< 2`, it warns `Nothing to hand off (no messages yet)` and returns.

The same minimum-content guard exists inside `SessionHandoff.handoff()` and throws if violated. RPC separately refuses a handoff while streaming. Direct SDK callers must avoid invoking the session method during an active response.

## End-to-end lifecycle

### 1) Start handoff generation

`AgentSession.handoff()` delegates to `SessionHandoff.handoff(customInstructions?, options?)`:

- Rejects session transitions while vibe mode is active.
- Reads the current branch and validates at least two message entries.
- Creates `#handoffAbortController` and links any caller-provided abort signal to it.
- Requires a selected model and an API key/resolver for that model.
- Builds the handoff request through the **same side-request pipeline a live turn uses**, shared with ephemeral turns:
  1. Renders the handoff prompt (`renderHandoffPrompt(...)` with optional focus, after secret obfuscation) and appends it as an agent-attributed `user` message to a snapshot of `agent.state.messages`.
  2. Converts the snapshot with `convertMessagesToLlm(...)` (session `transformContext`, LLM conversion, and obfuscation).
  3. Builds provider `Context` with `agent.buildSideRequestContext(llmMessages, baseSystemPrompt)` — normalized tools and provider-context transforms matching the loop. The base system prompt is pinned, so the fresh session does not inherit a per-turn `before_agent_start` override.
  4. Builds simple-stream options with the live provider cache key, a unique side `sessionId` (`<sid>:side:<snowflake>`), service tier/payload hooks, `preferWebsockets: false`, `initiatorOverride: "agent"`, and the abort signal.
- Obfuscates the final provider context and calls `generateHandoffFromContext(...)` through the host side-stream transport.
- Deobfuscates the returned handoff text before persistence or display.

### 2) Generate and capture output

`generateHandoffFromContext(...)` lives in `packages/agent/src/compaction/compaction.ts` next to summarization. It issues an OTEL-instrumented `completeSimple`-equivalent oneshot against the caller-built `Context`, overriding the supplied stream options with clamped compaction reasoning and `toolChoice: "none"`.

If a provider rejects explicit `toolChoice: "none"` because it supports only automatic tool choice, the function retries once with `toolChoice: "auto"`. Tools remain present for cache-prefix compatibility, but returned tool-call blocks are ignored; only text blocks are joined.

```ts
await generateHandoffFromContext(context, model, {
  streamOptions,
  completeImpl,
  telemetry,
  thinkingLevel,
});
```

`generateHandoff(messages, …)` remains exported for downstream callers. It constructs a basic context from `systemPrompt`, `tools`, and `convertToLlm`, then delegates to `generateHandoffFromContext`; coding-agent uses the context-aware function so host transforms, obfuscation, side-stream routing, and cache keys match live turns.

Important generation properties:

- The request shares the live provider cache prefix because the `Context` is built by the identical transform + normalization pipeline the loop uses, and routed with the same `promptCacheKey` the turn used.
- The handoff instruction is a trailing `user` message, not a developer message, so the cached prefix remains aligned with the prior turn (the trailing message is the only divergence point).
- `toolChoice: "none"` prevents intentional tool dispatch on normal providers; the compatibility retry uses `"auto"` only after an explicit-tool-choice rejection.
- Returned assistant content is filtered to text blocks and joined with `\n`; tool-call blocks are ignored.
- `stopReason === "error"` after the compatibility retry throws a generation error.

Capture is direct from the oneshot response; no agent-loop events or latest-assistant-message scan are involved.

### 3) Cancellation checks

An explicit user cancellation throws `Error("Handoff cancelled")`. Harness-initiated aborts preserve a supplied reason, or surface `Handoff aborted by session` when none is supplied. A manual handoff whose generation is empty/whitespace-only throws `Handoff generation produced no content`; auto-handoff returns `undefined` so maintenance can fall back to context-full compaction.

- caller signal aborts `#handoffAbortController` and forwards its reason
- `completeSimple(...)` receives the abort signal
- direct `abortHandoff()` or an unreasoned caller signal is normalized to `Error("Handoff cancelled")`
- harness abort reasons and provider failures (including provider `AbortError`s) surface verbatim

`AgentSession.handoff()` always clears `#handoffAbortController` in `finally`.

### 4) New session creation

If text was generated and not aborted:

1. Emit `session_before_switch` with reason `handoff`; an extension may cancel the switch, in which case no new session is created.
2. Flush pending bash output and the current session writer.
3. Drain/detach advisor recorders while they still point at the old session.
4. Begin a bash session transition and cancel session-owned async jobs.
5. Start a brand-new session with `parentSession` pointing at the previous session file when one exists.
6. Clear advisor cost, session-scoped tool/checkpoint state, and stale provider-session state.
7. Preserve steering and follow-up queues across `agent.reset()` so messages arriving during handoff survive into the new session.
8. Rebind the agent session id, rekey/reset memory tracking, clear queued next-turn context, and reset the todo cycle.

### 5) Handoff-context injection

The generated handoff document is wrapped by coding-agent session glue and appended to the new session as a `custom_message` entry:

```text
<handoff-context>
...handoff text...
</handoff-context>

The above is a handoff document from a previous session. Use this context to continue the work seamlessly.
```

Insertion call:

```ts
this.sessionManager.appendCustomMessageEntry(
  "handoff",
  handoffContent,
  true,
  undefined,
  "agent",
);
```

Semantics:

- `customType`: `"handoff"`
- `display`: `true` (visible in TUI rebuild)
- attribution: `"agent"`
- Entry type: `custom_message` (participates in LLM context)

### 6) Rebuild active agent context

After injection:

1. `buildDisplaySessionContext()` resolves messages for the new leaf.
2. `agent.replaceMessages(sessionContext.messages)` activates the injected handoff context.
3. Advisor runtime state and todo phases reset for the new branch.
4. Emit `session_switch` with reason `handoff` and the previous session file.
5. Return `{ document: handoffText, savedPath? }`.

At this point, the active LLM context in the new session contains the injected handoff message, not the old transcript.

## Persistence model: old session vs new session

### Old session

Handoff generation is a oneshot request, not a visible agent turn. The generated handoff text is not appended to the old session as an assistant message.

Result: the original session keeps its prior transcript unchanged except for data already persisted before handoff began.

### New session

After session reset, handoff is persisted as `custom_message` with `customType: "handoff"`.

`buildSessionContext()` converts this entry into a runtime custom/user-context message via `createCustomMessage(...)`, so it is included in future prompts from the new session.

Auto-triggered handoffs can additionally write a timestamped `handoff-*.md` artifact under the **new** session's artifacts directory when `compaction.handoffSaveToDisk` is enabled. Manual `/handoff` does not write that artifact. The injected custom message is forced on disk before the method returns.

### Automatic handoff

Manual `/handoff` works regardless of the context-maintenance strategy. To use this pipeline for automatic maintenance, set `compaction.strategy: handoff` (the strategy default is `snapcompact`). Normal threshold-triggered handoffs defer to a post-prompt task; an `incomplete` output recovery may hand off inline. Input `overflow` always falls back to in-place context-full maintenance because the handoff request would carry the same oversized input.

If auto generation returns no document, maintenance falls back to context-full compaction. An abort or a `session_before_switch` hook cancellation does not trigger that fallback. `compaction.handoffSaveToDisk` defaults to `false`; when enabled, only auto-triggered handoffs write the extra markdown artifact.

## Controller/UI behavior

`CommandController.handleHandoffCommand` behavior:

- Refuses with a warning when `session.isStreaming` (matches `/fork` and `/move`) — the user must finish or abort the response before handing off.
- Shows a status loader: `Generating handoff… (esc to cancel)`.
- Calls `await session.handoff(customInstructions)`.
- If result is `undefined`: `showError("Handoff cancelled")`.
- On success:
  - clears transient session UI and renders the new session messages, including the injected handoff
  - invalidates status line and editor border
  - reloads todos
  - appends `New session started with handoff context`
  - shows `savedPath` when the result includes one (manual `/handoff` normally has none)
- On exception:
  - if message is `"Handoff cancelled"`: `showError("Handoff cancelled")`
  - otherwise: logs the error and calls `showError("Handoff failed: <message>")`
- Stops the loader, clears the status container, and requests render at end.

Manual `/handoff` no longer streams the generated document into chat. A cancellable loader remains visible while the oneshot request runs, and the chat is rebuilt after generation completes.

## Cancellation semantics

### Session-level cancellation primitive

`AgentSession` exposes:

- `abortHandoff()` → aborts `#handoffAbortController`
- `isGeneratingHandoff` → true while controller exists

Direct `abortHandoff()` passes an unreasoned abort signal to `completeSimple(...)`; `handoff()` normalizes it to `Error("Handoff cancelled")`, and command controller maps it to cancellation UI. `AgentSession.abort(...)` instead aborts the handoff first with its harness reason (or `Handoff aborted by session`), so subsequent compaction cancellation cannot mask that failure as a user cancellation.

### Interactive `/handoff` path

`InputController`'s global `editor.onEscape` handler dispatches on live session state instead of swapping handlers: while `isGeneratingHandoff` is true, pressing Escape calls `session.abortHandoff()`, which aborts the `completeSimple(...)` request through `#handoffAbortController`.

## Aborted vs failed handoff

Current UI classification:

- **Aborted/cancelled**
  - direct `abortHandoff()` (interactive Esc) triggers `"Handoff cancelled"`
  - an unreasoned caller signal also triggers `"Handoff cancelled"`
  - UI shows `Handoff cancelled`
- **Failed**
  - a harness abort reason, an empty manual generation, or any thrown provider/session-transition error
  - UI logs the error and shows `Handoff failed: ...`

An extension-cancelled `session_before_switch` returns `undefined`, which the interactive controller reports as **cancelled**. Empty generation is not an extension cancellation: manual handoff throws; auto-handoff returns `undefined` only for its context-full fallback.

## Short-session and minimum-content guardrails

Two guards prevent low-signal handoffs:

- UI layer (`handleHandoffCommand`): warns and returns early for `< 2` message entries
- Session layer (`handoff()`): throws the same condition as an error

This avoids creating a new session with empty/near-empty handoff context.

## State transition summary

High-level state flow:

1. Interactive slash command dispatched by the builtin registry.
2. Streaming and message-count preflight guards.
3. `#handoffAbortController` created (`isGeneratingHandoff = true`).
4. `generateHandoffFromContext(...)` sends one cache-aligned side request, with a one-time `"auto"` tool-choice compatibility retry when required.
5. Assistant text blocks are joined; tool-call blocks are discarded; secret placeholders are restored locally.
6. If missing text or an extension cancels the switch → return `undefined`; if aborted → cancellation error.
7. If present:
   - flush bash/session persistence and detach advisor recorders
   - cancel async jobs and create a new child session
   - reset runtime/tool/checkpoint/memory state while preserving steering/follow-up queues
   - append and persist `custom_message(handoff)`
   - optionally save an auto-triggered handoff artifact
   - rebuild agent context, advisors, and todos, then emit `session_switch`
8. Controller rebuilds chat UI and announces success.
9. `#handoffAbortController` clears in `finally`; failed pre-commit transitions reattach advisor recorder feeds.

## Known assumptions and limitations

- No structural validation checks that generated markdown follows the requested section format.
- Missing text and extension-cancelled switches are reported as cancellation in the interactive controller.
- Manual handoff has no streaming visibility; a cancellable loader is shown until the UI updates.
- Auto-triggered artifact write failure is logged and does not fail the already-created handoff session.
