# TUI runtime internals

This document maps the non-theme runtime path from terminal input to rendered output in interactive mode. It focuses on behavior in `packages/tui` and its integration from `packages/coding-agent` controllers.

> **Editing the rendering engine itself?** Read
> [`tui-core-renderer.md`](./tui-core-renderer.md) first — it documents the
> failure modes (yank / corruption / flash / width crashes) and the invariants
> the render planner, native-scrollback bookkeeping, and capability detection
> must not violate.

## Runtime layers and ownership

- **`packages/tui` engine**: terminal lifecycle, stdin normalization, focus routing, render scheduling, differential painting, overlay composition, hardware cursor placement.
- **`packages/coding-agent` interactive mode**: builds component tree, binds editor callbacks and keymaps, reacts to agent/session events, and translates domain state (streaming, tool execution, retries, plan mode) into UI components.

Boundary rule: the TUI engine is message-agnostic. It only knows `Component.render(width)`, `handleInput(data)`, focus, and overlays. Agent semantics stay in interactive controllers.

## Implementation files

- [`packages/coding-agent/src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`packages/coding-agent/src/modes/session-teardown.ts`](../packages/coding-agent/src/modes/session-teardown.ts)
- [`packages/coding-agent/src/modes/controllers/event-controller.ts`](../packages/coding-agent/src/modes/controllers/event-controller.ts)
- [`packages/coding-agent/src/modes/controllers/input-controller.ts`](../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`packages/coding-agent/src/modes/components/custom-editor.ts`](../packages/coding-agent/src/modes/components/custom-editor.ts)
- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts)
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts)
- [`packages/tui/src/editor-component.ts`](../packages/tui/src/editor-component.ts)
- [`packages/tui/src/stdin-buffer.ts`](../packages/tui/src/stdin-buffer.ts)
- [`packages/tui/src/components/loader.ts`](../packages/tui/src/components/loader.ts)

## Boot and component tree assembly

`InteractiveMode` constructs `TUI(new ProcessTerminal(), settings.get("showHardwareCursor"))`, applies `tui.maxInlineImages` and Kitty text-sizing settings, then creates persistent containers:

- `chatContainer`
- `pendingMessagesContainer`
- `statusContainer`
- `todoContainer`
- `subagentContainer`
- `btwContainer`
- `omfgContainer`
- `errorBannerContainer`
- `modelCycleContainer` (ctrl+p model-role cycle chip track)
- `statusLine`
- `hookWidgetContainerAbove`
- `editorContainer` (holds `CustomEditor`)
- `hookWidgetContainerBelow`

`init()` wires the tree in that order after any startup warnings/welcome/changelog, focuses the editor, registers input handlers via `InputController`, starts TUI, pushes terminal title state, updates the editor border, and requests a forced render.
A forced render (`requestRender(true)`) queues a viewport repaint or explicit session replacement; it does **not** throw away previous-line history by default.

## Terminal lifecycle and stdin normalization

`ProcessTerminal.start()`:

1. Enables raw mode and bracketed paste.
2. Attaches resize handler and refreshes dimensions.
3. Enables Windows VT input mode when running on win32.
4. Creates a `StdinBuffer` to split partial escape chunks into complete sequences.
5. Queries Kitty keyboard protocol support (`CSI ? u`), then enables protocol flags if supported; otherwise enables modifyOtherKeys fallback after a short timeout.
6. Queries OSC 11 background color and Mode 2031 appearance notifications for dark/light theme detection.
7. Queries OSC 99 notification capabilities.
8. Starts periodic OSC 11 polling only where safe, then probes DEC private modes 2026/2048/2031 via DECRQM.

`StdinBuffer` behavior:

- Buffers fragmented escape sequences (CSI/OSC/DCS/APC/SS3).
- Emits `data` only when a sequence is complete or timeout-flushed.
- Detects bracketed paste and emits a `paste` event with raw pasted text.

This prevents partial escape chunks from being misinterpreted as normal keypresses.

### Shutdown and terminal handoff

Exit from double `Ctrl+C`, empty-editor `Ctrl+D`, `/exit`, and postmortem signals converges on a promise-memoized session teardown. The first caller wins: it snapshots the editor draft, calls `beginDispose()` synchronously, attempts to save the draft, and then disposes the session. A draft-save failure is logged but does not skip disposal; later keypress or signal callers await the same promise and cannot double-run shutdown.

Interactive shutdown then follows this ownership order:

1. `InteractiveMode` stops live commands and transient controllers, displays the closing status, and awaits session disposal before handing the terminal back.
2. It drains in-flight Kitty input for up to one second so release sequences do not leak into the parent shell.
3. It disposes the run-state title/spinner state and restores the prior terminal title before stopping the UI.
4. `TUI.stop()` leaves resize/fullscreen alternate-screen state, purges image/probe state, stops watchdog and render/resize timers, positions and forcibly restores the cursor, then delegates to `ProcessTerminal.stop()`.
5. `ProcessTerminal.stop()` restores real stderr and terminal modes, disables keyboard/mouse/appearance protocols, clears probes and timers, destroys `StdinBuffer`, removes stdin/stdout listeners, pauses stdin, and restores its previous raw-mode state.

Terminal disconnects mark the terminal dead and stop interactive rendering. Cleanup still removes owned state, but raw-mode restoration errors are suppressed only for that dead-terminal case because there is no live TTY left to restore.

Suspend is distinct from exit: `Ctrl+Z` stops the TUI to release terminal modes, sends `SIGTSTP`, and retains the session. Its one-shot `SIGCONT` handler starts the TUI again and forces a repaint; it does not run session teardown or terminal handoff to a parent shell.

## Input routing and focus model

Input path:

`stdin -> ProcessTerminal -> StdinBuffer -> TUI.#handleInput -> focusedComponent.handleInput`

Routing details:

1. TUI runs registered input listeners first (`addInputListener`), allowing consume/transform behavior.
2. TUI handles global debug shortcut (`shift+ctrl+d`) before component dispatch.
3. If focused component belongs to an overlay that is now hidden/invisible, TUI reassigns focus to next visible overlay or saved pre-overlay focus.
4. Key release events are filtered unless focused component sets `wantsKeyRelease = true`.
5. After dispatch, TUI schedules render.

`setFocus()` also toggles `Focusable.focused`, which controls whether components emit `CURSOR_MARKER` for hardware cursor placement.

## Key handling split: editor vs controller

`CustomEditor` intercepts high-priority combos first (escape, ctrl-c/d/z, ctrl-v, ctrl-p variants, ctrl-t, alt-up, extension custom keys) and delegates the rest to base `Editor` behavior (text editing, history, autocomplete, cursor movement).

`InputController.setupKeyHandlers()` then binds editor callbacks to mode actions:

- cancellation / mode exits on `Escape`
- shutdown on double `Ctrl+C` or empty-editor `Ctrl+D`
- suspend/resume on `Ctrl+Z`
- slash-command and selector hotkeys
- follow-up/dequeue toggles and expansion toggles

This keeps key parsing/editor mechanics in `packages/tui` and mode semantics in coding-agent controllers.

## Render loop and the default append-only contract

`TUI.requestRender()` coalesces render requests and rate-limits ordinary frames:

- forced renders (`requestRender(true, ...)`) schedule an immediate full-window rewrite; `clearScrollback` requests the destructive replay path
- ordinary renders use a 30fps base cadence plus adaptive backpressure derived from the previous frame's cost
- repeated requests while a render is pending collapse into the same scheduled frame
- `requestComponentRender(component)` scopes composition to affected root subtrees when geometry and renderer state are safe; otherwise it downgrades to a full compose
- `requestDirectWrite(component)` can rewrite one quiet, visible, fixed-height component segment immediately (used by loader-style animation); overlays, images, cursor markers, geometry changes, committed segments, or other unsafe state fall back to `requestComponentRender`

`#doRender()` pipeline:

1. Render the root component tree, collecting the first `NativeScrollbackLiveRegion` boundary and its optional pinned policy.
2. Audit the already committed raw prefix for structural shifts; an insertion/deletion re-anchors commits at the first changed row so stale history may duplicate but new content is not lost.
3. Advance the append-only ledger. Rows before the live boundary are exact/final; mutable rows that scroll above the window normally commit as frozen snapshots, while a pinned live region stays viewport-local.
4. Extract and strip `CURSOR_MARKER`, normalize lines, slice the visible window, and composite overlays into that screen-coordinate window slice (overlays freeze commits).
5. Emit one of: gesture-driven or divergence-rebuild full paint, scroll-append, in-window row diff, or seam rewrite.

By default, native scrollback is append-only: committed frame rows are never rewritten. Exact rows enter history after the component seam declares them final; an unpinned mutable row that scrolls off is recorded as the snapshot that was visible at commit time. There are no viewport-position probes or deferred reconciliation; see [`tui-core-renderer.md`](./tui-core-renderer.md).

The opt-in `tui.scrollbackRebuild` setting (default `false`) changes how a committed-prefix divergence is repaired. When finalized content replaces a scrolled-off preview, or a frame collapses into already committed rows, a direct terminal session clears native scrollback with ED3 and replays the current frame so the stale and final forms do not both remain. Multiplexer sessions never take this destructive path and retain the append/repair-below fallback. `PI_TUI_SCROLLBACK_REBUILD=1` initializes the low-level `TUI` flag, but `InteractiveMode` then applies the configured `tui.scrollbackRebuild` value; the setting is therefore the effective control in coding-agent.

Render writes use synchronized output mode (`CSI ? 2026 h/l`) when enabled; capability detection, DECRQM, or `PI_NO_SYNC_OUTPUT` can disable the wrappers while leaving autowrap discipline on.

## Render safety constraints

Critical safety checks in `TUI`:

- Non-image rendered lines are expected to fit terminal width; the differential path truncates overwide lines as a last-resort guard and can write debug diagnostics when redraw debugging is enabled.
- Overlay compositing includes defensive truncation and post-composite width guarding.
- Width changes force repaint/rebuild planning because wrapping semantics change.
- Cursor position is clamped before movement.

These constraints are runtime guards plus component conventions; renderers should still return width-safe lines rather than rely on truncation.

The deeper reasons these guards exist — why the renderer cannot observe scroll
position, why ED3 (`CSI 3 J`) is confined to one path, and why the hot path
clamps instead of throwing — are documented in
[`tui-core-renderer.md`](./tui-core-renderer.md).

## Resize handling

Resize events are event-driven from `ProcessTerminal` to `TUI.requestRender()`.

Effects:

- Direct HerdR panes follow the in-place multiplexer path: their host owns the
  pane, and destructive `ED3` transcript replay produces visible flashes.
- Inside terminal multiplexers, height-only resize retains the append ledger and repaints the visible window in place after the settle debounce (issue #2088). A width change instead terminates the physical-row epoch: old committed coordinates become opaque, pane history remains immutable at its authored wrap, and the settled render establishes a complete-frame baseline. Subsequent growth writes only current-width rows newly crossing the scrollback seam before repainting the bounded viewport.
- Nested tmux, screen, Zellij, or cmux sessions inside HerdR use the same path.
- Terminals that re-report their size when the alternate screen buffer is toggled (Warp reports a height one row different for the alt buffer) take the in-place path too. The non-multiplexer fast path borrows the alternate screen for drag frames, so on these terminals each alt enter/leave emits a fresh resize event, which re-enters the fast path — a self-sustaining loop that floods ED3 full repaints with stable geometry. `resizeRepaintsInPlace()` (covering ED3-unsafe multiplexers and these terminals; overridable via `PI_TUI_RESIZE_IN_PLACE`) routes them through the in-place repaint, which never touches the alt buffer.
- Overlay visibility can depend on terminal dimensions (`OverlayOptions.visible`); focus is corrected when overlays become non-visible after resize.

## Streaming and incremental UI updates

`EventController` subscribes to `AgentSessionEvent` and updates UI incrementally:

- `agent_start`: starts loader in `statusContainer`.
- `message_start` assistant: creates `streamingComponent` and mounts it.
- `message_update`: updates streaming assistant content; creates/updates tool execution components as tool calls appear.
- `tool_execution_update/end`: updates tool result components and completion state.
- `message_end`: finalizes assistant stream, handles aborted/error annotations, marks pending tool args complete on normal stop.
- `agent_end`: stops loaders, clears transient stream state, flushes deferred model switch, issues completion notification if backgrounded.

Read-tool grouping is intentionally stateful (`#lastReadGroup`) to coalesce consecutive read tool calls into one visual block until a non-read break occurs.

## Status and loader orchestration

Status lane ownership:

- `statusContainer` holds transient loaders (`loadingAnimation`, `autoCompactionLoader`, `retryLoader`).
- `statusLine` renders persistent status/hooks/plan indicators and drives editor top border updates.

Loader behavior:

- `Loader` advances its spinner every 80ms (animated message colorizers redraw at ~30fps) and uses the direct-write path for quiet fixed-height frames, with automatic fallback to a component-scoped render when direct rewriting is unsafe.
- Escape cancels an in-progress auto-compaction, handoff generation, or auto-retry: the editor's single `onEscape` handler dispatches on live session state (`isCompacting`/`isGeneratingHandoff`/`isRetrying`) and calls the matching abort method, rather than swapping the handler.
- On end/cancel paths, controllers stop/clear the loader components.

## Mode transitions and backgrounding

### Bash/Python input modes

Input text prefixes toggle editor border mode flags:

- `!` -> bash mode
- `$` (non-template literal prefix) -> python mode

Escape exits inactive mode by clearing editor text and restoring border color; when execution is active, escape aborts the running task instead.

### Plan mode

`InteractiveMode` tracks plan mode flags, status-line state, active tools, and model switching. Enter/exit updates session mode entries and status/UI state, including deferred model switch if streaming is active.

### Suspend/resume (`Ctrl+Z`)

`InputController.handleCtrlZ()`:

1. Registers one-shot `SIGCONT` handler to restart TUI and force render.
2. Stops TUI before suspend.
3. Sends `SIGTSTP` to process group.

## Cancellation paths

Primary cancellation inputs:

- `Escape` during active stream loader: restores queued messages to editor and aborts agent.
- `Escape` during bash/python execution: aborts running command.
- `Escape` during auto-compaction, handoff generation, or auto-retry: the editor's `onEscape` dispatches on live session state (`isCompacting`/`isGeneratingHandoff`/`isRetrying`) and calls the matching abort method (`abortCompaction`/`abortHandoff`/`abortRetry`).
- `Ctrl+C` single press: clear editor; double press within 500ms: shutdown.

Cancellation is state-conditional; same key can mean abort, mode-exit, selector trigger, or no-op depending on runtime state.

## Event-driven vs throttled behavior

Event-driven updates:

- Agent session events (`EventController`)
- Key input callbacks (`InputController`)
- terminal resize callback
- terminal appearance callbacks, SIGWINCH theme reevaluation, and git branch watchers in `InteractiveMode`

Throttled/debounced paths:

- TUI rendering uses a 30fps base cadence, coalescing, and adaptive backpressure from render cost.
- Loader animation is interval-driven (80ms spinner advance; ~30fps when the message colorizer is animated), using direct writes when safe and component-scoped renders otherwise.
- Editor autocomplete updates (inside `Editor`) use debounce timers, reducing recompute churn during typing.

The runtime therefore mixes event-driven state transitions with bounded render cadence to keep interactivity responsive without repaint storms.
