import { describe, expect, it } from "bun:test";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	Editor,
	type Focusable,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackLiveRegion,
	type NativeScrollbackReplay,
	TUI,
} from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { defaultEditorTheme } from "./test-themes";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

// Behavioral tests for TUI.requestComponentRender: a component whose own
// content changed (spinner frame, blink) asks for a component-scoped frame.
// When every request since the last frame is component-scoped and the frame is
// otherwise quiet, the compose re-renders only the root subtrees containing
// the requesting components and reuses the previous segment — rows and seam
// report — of every other root child. Any concurrent full request or unsafe
// condition must downgrade to a normal full compose.

/** Ref-stable leaf: fresh array per change, counts render() calls. */
class CountingLines implements Component {
	renders = 0;
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	set(lines: string[]): void {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.renders++;
		return this.#lines;
	}
}

/** Transcript-shaped head: final rows committed, the last row stays live. */
class LiveHead extends CountingLines implements NativeScrollbackLiveRegion {
	#seam = 0;

	setSeam(seam: number): void {
		this.#seam = seam;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#seam;
	}
}

class AnchoredStatusContainer extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		const hasAnchoredRows = this.children.length > 0;
		return hasAnchoredRows ? 0 : undefined;
	}

	isNativeScrollbackLiveRegionPinned(): boolean {
		return true;
	}
}

function strip(rows: string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

function visible(term: VirtualTerminal): string[] {
	return strip(term.getViewport()).filter(row => row.length > 0);
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const write = term.write.bind(term);
	term.write = (data: string): void => {
		writes.push(data);
		write(data);
	};
	return writes;
}

class RenderCountingTUI extends TUI {
	renders = 0;

	override render(width: number): readonly string[] {
		this.renders++;
		return super.render(width);
	}
}

class ReplayVirtualizedLines implements Component, NativeScrollbackCommittedRows, NativeScrollbackReplay {
	readonly lines: readonly string[];
	replayPreparations = 0;
	#compacted = false;
	#replayPending = false;

	constructor(lines: readonly string[]) {
		this.lines = lines;
	}

	invalidate(): void {}

	setNativeScrollbackCommittedRows(rows: number): void {
		if (rows >= 4) this.#compacted = true;
	}

	prepareNativeScrollbackReplay(): void {
		this.replayPreparations++;
		this.#replayPending = true;
	}

	render(_width: number): readonly string[] {
		if (this.#replayPending) {
			this.#replayPending = false;
			return this.lines;
		}
		return this.#compacted ? this.lines.slice(4) : this.lines;
	}
}

describe("TUI native scrollback replay", () => {
	it("rehydrates virtualized roots before a destructive full paint", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new ReplayVirtualizedLines([
			"history-0",
			"history-1",
			"history-2",
			"history-3",
			"tail-0",
			"tail-1",
			"tail-2",
			"tail-3",
		]);
		tui.addChild(transcript);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.requestRender();
			await scheduler.drain(term);

			tui.requestRender(true, { clearScrollback: true });
			await scheduler.drain(term);

			expect(transcript.replayPreparations).toBe(1);
			const buffer = strip(term.getScrollBuffer());
			expect(buffer).toContain("history-0");
			expect(buffer).toContain("tail-3");
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

describe("TUI.requestComponentRender", () => {
	it("re-renders only the requesting subtree on a quiet frame", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1", "msg-2"]);
		const status = new Container();
		const spinner = new CountingLines(["spin-0"]);
		status.addChild(spinner);
		tui.addChild(transcript);
		tui.addChild(status);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "msg-1", "msg-2", "spin-0"]);
			const transcriptRenders = transcript.renders;

			// Spinner tick: component-scoped request, nested one level deep.
			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-1", "msg-2", "spin-1"]);
			// The transcript subtree was reused, not re-rendered.
			expect(transcript.renders).toBe(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("downgrades to a full compose when a full request shares the frame", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			// Both a component-scoped and a full request coalesce into one
			// frame; the full request wins regardless of arrival order.
			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			transcript.set(["msg-0", "msg-edited"]);
			tui.requestRender();
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-edited", "spin-1"]);
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose while an overlay is up", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.showOverlay(new CountingLines(["modal"]), { width: 10 });
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			// Unsafe condition: the frame rendered fully (and correctly).
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose when the root child list changed", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);

			// Structural change with only a component-scoped request pending:
			// the segment ledger no longer matches the root list, so the frame
			// must compose fully and paint the new child.
			tui.addChild(new CountingLines(["banner"]));
			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "spin-1", "banner"]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose when the component is not in the tree", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const status = new Container();
		const spinner = new CountingLines(["spin-0"]);
		status.addChild(spinner);
		tui.addChild(transcript);
		tui.addChild(status);

		try {
			tui.start();
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			// A detached component (cleared status container) can still fire a
			// trailing tick; the frame must not skip anything based on it.
			status.removeChild(spinner);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0"]);
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("replays the seam report of a skipped root child across partial frames", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const markers = Array.from({ length: 8 }, (_unused, i) => `ROW-${String(i).padStart(3, "0")}`);
		// All but the last head row are final; the tail row stays live.
		const head = new LiveHead([...markers, "streaming"]);
		head.setSeam(markers.length);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(head);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			const headRenders = head.renders;

			// Several spinner-only frames while the head (and its commit seam)
			// ride the reused segment.
			for (let tick = 1; tick <= 3; tick++) {
				spinner.set([`spin-${tick}`]);
				tui.requestComponentRender(spinner);
				await scheduler.drain(term);
			}
			expect(head.renders).toBe(headRenders);
			expect(visible(term).at(-1)).toBe("spin-3");

			// A later full frame must still commit exactly once: every final
			// row appears exactly once across history + grid, in order.
			head.set([...markers, "streamed-final", "tail"]);
			head.setSeam(markers.length + 2);
			tui.requestRender();
			await scheduler.drain(term);

			const buffer = strip(term.getScrollBuffer()).join("\n");
			const missing = markers.filter(mark => buffer.split(mark).length - 1 === 0);
			const duplicated = markers.filter(mark => buffer.split(mark).length - 1 > 1);
			expect(missing).toEqual([]);
			expect(duplicated).toEqual([]);
			const observed = Array.from(buffer.matchAll(/ROW-\d{3}/g), match => match[0]);
			expect(observed).toEqual(markers);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
	it("keeps removed pinned panels and repeated transcript copies out of scrollback", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const markers = Array.from({ length: 5 }, (_unused, index) => `HIST-${index}`);
		const transcript = new CountingLines(markers);
		const status = new AnchoredStatusContainer();
		const editor = new CountingLines([`editor${CURSOR_MARKER}`]);
		tui.addChild(transcript);
		tui.addChild(status);
		tui.addChild(editor);

		try {
			tui.start();
			await scheduler.drain(term);
			for (let cycle = 1; cycle <= 3; cycle++) {
				const panel = new CountingLines([`panel-${cycle}-0`]);
				status.addChild(panel);
				tui.requestRender();
				await scheduler.drain(term);
				for (let tick = 1; tick <= 8; tick++) {
					panel.set(Array.from({ length: tick + 1 }, (_row, index) => `panel-${cycle}-${tick}-${index}`));
					tui.requestComponentRender(panel);
					await scheduler.drain(term);
				}
				status.clear();
				tui.requestRender();
				await scheduler.drain(term);
			}

			const buffer = strip(term.getScrollBuffer()).join("\n");
			for (const marker of markers) {
				expect(buffer.split(marker)).toHaveLength(2);
			}
			expect(buffer).not.toContain("panel-");
		} finally {
			tui.stop();
			await term.flush();
		}
	});
	it("keeps a pinned panel out of scrollback under an unpinned streaming transcript seam", async () => {
		// Regression for the /btw panel re-committing its frame while the primary
		// turn streams (#8793): the transcript reports the topmost, UNPINNED seam,
		// so the frame-wide pin policy is false, yet an anchored pinned panel below
		// it must still never commit its scrolled-off rows to native scrollback.
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const markers = Array.from({ length: 5 }, (_unused, index) => `HIST-${index}`);
		const transcript = new LiveHead([...markers, "streaming-tail"]);
		transcript.setSeam(markers.length); // committed prefix + one live (streaming) tail row
		const status = new AnchoredStatusContainer();
		const editor = new CountingLines([`editor${CURSOR_MARKER}`]);
		tui.addChild(transcript);
		tui.addChild(status);
		tui.addChild(editor);

		try {
			tui.start();
			await scheduler.drain(term);
			const panel = new CountingLines(["btw-0"]);
			status.addChild(panel);
			tui.requestRender();
			await scheduler.drain(term);
			for (let tick = 1; tick <= 12; tick++) {
				panel.set(Array.from({ length: tick + 1 }, (_row, index) => `BTWROW-${tick}-${index}`));
				tui.requestComponentRender(panel);
				await scheduler.drain(term);
			}

			// Native scrollback is everything above the visible viewport; mid-stream
			// it must hold zero rows of the growing pinned panel.
			const history = strip(term.getScrollBuffer()).slice(0, -term.rows);
			expect(history.filter(row => row.startsWith("BTWROW-"))).toEqual([]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

describe("TUI keystroke-scoped render", () => {
	it("fully composes callback-driven sibling updates without explicit scoped opt-in", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const status = new CountingLines(["status-idle"]);
		const input: Component & Focusable = {
			focused: false,
			invalidate() {},
			render() {
				const state = this.focused ? "focused" : "idle";
				return [`input-${state}`];
			},
			handleInput() {
				status.set(["status-submitted"]);
			},
		};
		tui.addChild(status);
		tui.addChild(input);
		tui.setFocus(input);

		try {
			tui.start();
			await scheduler.drain(term);
			const statusRenders = status.renders;

			term.sendInput("x");
			await scheduler.drain(term);

			expect(status.renders).toBeGreaterThan(statusRenders);
			expect(visible(term)).toEqual(["status-submitted", "input-focused"]);
			expect(tui.getFocused()).toBe(input);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("does not re-render a quiet sibling transcript while typing in the focused editor", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1", "msg-2"]);
		const editor = new Editor(defaultEditorTheme);
		tui.enableScopedInputRender(editor);
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			term.sendInput("x");
			await scheduler.drain(term);

			expect(editor.getText()).toBe("x");
			expect(transcript.renders).toBe(transcriptRenders);
			expect(visible(term).some(row => row.includes("msg-0"))).toBe(true);
			expect(visible(term).some(row => row.includes("x"))).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps a correct viewport when a keystroke grows the editor by one wrapped row", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1"]);
		const editor = new Editor(defaultEditorTheme);
		tui.enableScopedInputRender(editor);
		// 34 chars fills the first content row at width 40; the next char wraps.
		editor.setText("x".repeat(34));
		tui.addChild(transcript);
		tui.addChild(editor);
		tui.setFocus(editor);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual([
				"msg-0",
				"msg-1",
				"+--------------------------------------+",
				"+- xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx|-+",
			]);
			const transcriptRenders = transcript.renders;

			term.sendInput("y");
			await scheduler.drain(term);

			expect(editor.getText()).toBe(`${"x".repeat(34)}y`);
			expect(transcript.renders).toBe(transcriptRenders);
			expect(visible(term)).toEqual([
				"msg-0",
				"msg-1",
				"+--------------------------------------+",
				"|  xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  |",
				"+- y|                                 -+",
			]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose when handleInput moves focus", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const nextFocus = new CountingLines(["selector"]);
		const focusMover: Component & Focusable = {
			focused: false,
			invalidate() {},
			render() {
				return this.focused ? ["editor-focused"] : ["editor-idle"];
			},
			handleInput() {
				tui.setFocus(nextFocus);
			},
		};
		tui.enableScopedInputRender(focusMover);

		tui.addChild(transcript);
		tui.addChild(focusMover);
		tui.addChild(nextFocus);
		tui.setFocus(focusMover);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "editor-focused", "selector"]);
			const transcriptRenders = transcript.renders;

			term.sendInput("x");
			await scheduler.drain(term);

			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
			expect(visible(term)).toEqual(["msg-0", "editor-idle", "selector"]);
			expect(tui.getFocused()).toBe(nextFocus);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

describe("TUI.requestDirectWrite", () => {
	it("directly rewrites a visible unchanged-size root segment without a full render", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1"]);
		const spinner = new CountingLines(["spin-0"]);
		const footer = new CountingLines(["footer"]);
		tui.addChild(transcript);
		tui.addChild(spinner);
		tui.addChild(footer);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-0", "footer"]);
			const tuiRenders = tui.renders;
			const transcriptRenders = transcript.renders;
			const footerRenders = footer.renders;

			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-1", "footer"]);
			expect(tui.renders).toBe(tuiRenders);
			expect(transcript.renders).toBe(transcriptRenders);
			expect(footer.renders).toBe(footerRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("directly strips markers while updating ANSI and wide-grapheme cursor geometry", async () => {
		const term = new VirtualTerminal(40, 5, 1_000);
		const writes = captureWrites(term);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, true, { renderScheduler: scheduler });
		const head = new CountingLines(["head"]);
		const editor = new CountingLines(["plain"]);
		const footer = new CountingLines(["footer"]);
		tui.addChild(head);
		tui.addChild(editor);
		tui.addChild(footer);

		try {
			tui.start();
			await scheduler.drain(term);
			const tuiRenders = tui.renders;
			writes.length = 0;

			editor.set([`\x1b[31m好a${CURSOR_MARKER}b${CURSOR_MARKER}\x1b[0m`]);
			tui.requestDirectWrite(editor);
			await scheduler.drain(term);

			expect(strip(term.getViewport())).toEqual(["head", "好ab", "footer", "", ""]);
			expect(term.getCursor()).toEqual({ row: 1, col: 3 });
			expect(tui.renders).toBe(tuiRenders);
			expect(writes.join("")).not.toContain(CURSOR_MARKER);

			writes.length = 0;
			editor.set(["done"]);
			tui.requestDirectWrite(editor);
			await scheduler.drain(term);

			expect(strip(term.getViewport())).toEqual(["head", "done", "footer", "", ""]);
			expect(tui.renders).toBe(tuiRenders);
			expect(writes.join("")).toContain("\x1b[?25l");
			expect(writes.join("")).not.toContain(CURSOR_MARKER);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("moves a marker without repainting unchanged row bytes", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const writes = captureWrites(term);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, true, { renderScheduler: scheduler });
		const editor = new CountingLines([`ab${CURSOR_MARKER}cd`, "efgh"]);
		tui.addChild(editor);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(strip(term.getViewport())).toEqual(["abcd", "efgh", "", ""]);
			expect(term.getCursor()).toEqual({ row: 0, col: 2 });
			const tuiRenders = tui.renders;
			writes.length = 0;

			editor.set(["abcd", `e${CURSOR_MARKER}fgh`]);
			tui.requestDirectWrite(editor);
			await scheduler.drain(term);

			expect(strip(term.getViewport())).toEqual(["abcd", "efgh", "", ""]);
			expect(term.getCursor()).toEqual({ row: 1, col: 1 });
			expect(tui.renders).toBe(tuiRenders);
			expect(writes.join("")).not.toContain("abcd");
			expect(writes.join("")).not.toContain(CURSOR_MARKER);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("preserves later sibling precedence across marker interval growth, shrink, and recompose", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const writes = captureWrites(term);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, true, { renderScheduler: scheduler });
		const earlier = new CountingLines(["early"]);
		const target = new CountingLines(["t0", "t1", "t2"]);
		const later = new CountingLines([`later${CURSOR_MARKER}`]);
		tui.addChild(earlier);
		tui.addChild(target);
		tui.addChild(later);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(term.getCursor()).toEqual({ row: 4, col: 5 });
			const tuiRenders = tui.renders;
			writes.length = 0;

			target.set([`${CURSOR_MARKER}t0`, `t${CURSOR_MARKER}1`, `t2${CURSOR_MARKER}`]);
			tui.requestDirectWrite(target);
			await scheduler.drain(term);
			expect(term.getCursor()).toEqual({ row: 4, col: 5 });
			expect(tui.renders).toBe(tuiRenders);

			target.set(["t0", `t${CURSOR_MARKER}1`, "t2"]);
			tui.requestDirectWrite(target);
			await scheduler.drain(term);
			expect(term.getCursor()).toEqual({ row: 4, col: 5 });
			expect(tui.renders).toBe(tuiRenders);

			later.set(["later"]);
			tui.requestDirectWrite(later);
			await scheduler.drain(term);
			expect(term.getCursor()).toEqual({ row: 2, col: 1 });
			expect(tui.renders).toBe(tuiRenders);
			expect(writes.join("")).not.toContain(CURSOR_MARKER);

			const targetRenders = target.renders;
			writes.length = 0;
			earlier.set(["early-new"]);
			tui.requestComponentRender(earlier);
			await scheduler.drain(term);

			expect(strip(term.getViewport())).toEqual(["early-new", "t0", "t1", "t2", "later", "", "", ""]);
			expect(term.getCursor()).toEqual({ row: 2, col: 1 });
			expect(tui.renders).toBeGreaterThan(tuiRenders);
			expect(target.renders).toBe(targetRenders);
			expect(writes.join("")).toContain("\x1b[?25h");
			expect(writes.join("")).not.toContain(CURSOR_MARKER);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps non-empty native scrollback byte-for-byte stable during marker direct writes", async () => {
		const term = new VirtualTerminal(30, 4, 1_000);
		const writes = captureWrites(term);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, true, { renderScheduler: scheduler });
		const transcript = new CountingLines(Array.from({ length: 8 }, (_unused, row) => `history-${row}`));
		const editor = new CountingLines(["anim-0"]);
		tui.addChild(transcript);
		tui.addChild(editor);

		try {
			tui.start();
			await scheduler.drain(term);
			const beforeBuffer = term.getScrollBuffer();
			const beforeHistory = beforeBuffer.slice(0, Math.max(0, beforeBuffer.length - term.rows));
			expect(beforeHistory.length).toBeGreaterThan(0);
			expect(beforeHistory.some(row => row.trimEnd().length > 0)).toBe(true);
			const tuiRenders = tui.renders;
			writes.length = 0;

			editor.set([`anim-1${CURSOR_MARKER}`]);
			tui.requestDirectWrite(editor);
			await scheduler.drain(term);

			const afterBuffer = term.getScrollBuffer();
			const afterHistory = afterBuffer.slice(0, Math.max(0, afterBuffer.length - term.rows));
			expect(afterHistory).toEqual(beforeHistory);
			expect(strip(term.getViewport())).toEqual(["history-5", "history-6", "history-7", "anim-1"]);
			expect(term.getCursor()).toEqual({ row: 3, col: 6 });
			expect(tui.renders).toBe(tuiRenders);
			expect(writes.join("")).not.toContain(CURSOR_MARKER);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back safely when marker-bearing output changes row count", async () => {
		const term = new VirtualTerminal(40, 5, 1_000);
		const writes = captureWrites(term);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, true, { renderScheduler: scheduler });
		const head = new CountingLines(["head"]);
		const editor = new CountingLines([`one${CURSOR_MARKER}`]);
		tui.addChild(head);
		tui.addChild(editor);

		try {
			tui.start();
			await scheduler.drain(term);
			const tuiRenders = tui.renders;
			writes.length = 0;

			editor.set([`one${CURSOR_MARKER}`, `two${CURSOR_MARKER}`]);
			tui.requestDirectWrite(editor);
			await scheduler.drain(term);

			expect(strip(term.getViewport())).toEqual(["head", "one", "two", "", ""]);
			expect(term.getCursor()).toEqual({ row: 2, col: 3 });
			expect(tui.renders).toBeGreaterThan(tuiRenders);
			expect(writes.join("")).not.toContain(CURSOR_MARKER);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("directly rewrites fully live anchored status segments", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1"]);
		const status = new AnchoredStatusContainer();
		const spinner = new CountingLines(["spin-0"]);
		status.addChild(spinner);
		tui.addChild(transcript);
		tui.addChild(status);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-0"]);
			const tuiRenders = tui.renders;
			const transcriptRenders = transcript.renders;

			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-1"]);
			expect(tui.renders).toBe(tuiRenders);
			expect(transcript.renders).toBe(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full render while a visible overlay is up", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		const footer = new CountingLines(["footer"]);
		tui.addChild(transcript);
		tui.addChild(spinner);
		tui.addChild(footer);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.showOverlay(new CountingLines(["modal"]), { width: 5, anchor: "top-left" });
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["modal", "spin-0", "footer"]);
			const tuiRenders = tui.renders;
			const transcriptRenders = transcript.renders;

			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["modal", "spin-1", "footer"]);
			expect(tui.renders).toBeGreaterThan(tuiRenders);
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});
