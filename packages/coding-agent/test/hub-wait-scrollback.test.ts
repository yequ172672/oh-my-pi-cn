import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

/**
 * Hub wait is a self-replacing dashboard: running-job rows rewrite in place
 * (duration + shimmer) while the poll is live. Those rows must not be frozen
 * into native scrollback each tick — that is the stacked "waiting on N jobs"
 * smear (same 3–6 task names repeating with incrementing `6m29s` / `6m30s`).
 */

type DrainableScheduler = {
	now(): number;
	scheduleImmediate(cb: () => void): void;
	scheduleRender(cb: () => void, delayMs: number): { cancel(): void };
	flush(): void;
};

function makeDrainableScheduler(): DrainableScheduler {
	let clock = 0;
	const queue: Array<{ run: () => void; cancelled: boolean }> = [];
	const enqueue = (cb: () => void) => {
		const item = { run: cb, cancelled: false };
		queue.push(item);
		return item;
	};
	return {
		now: () => clock,
		scheduleImmediate(cb) {
			enqueue(cb);
		},
		scheduleRender(cb) {
			const item = enqueue(cb);
			return {
				cancel() {
					item.cancelled = true;
				},
			};
		},
		flush() {
			let guard = 0;
			while (queue.length > 0) {
				if (++guard > 100_000) throw new Error("scheduler did not settle");
				const item = queue.shift()!;
				clock += 1;
				if (!item.cancelled) item.run();
			}
		},
	};
}

class Footer implements Component {
	#rows: number;
	constructor(rows: number) {
		this.#rows = rows;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.#rows }, (_, i) => `editor-${i}`);
	}
}

/** Finalized history above the wait poll. */
class StaticBlock implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.#lines;
	}
}

/**
 * Still-live predecessor that does not pin (a parallel bash/eval, or a
 * streaming assistant turn). TranscriptContainer currently copies pin
 * policy from this first live block, which can hide a hub wait's pin.
 */
class LiveBarrier implements Component {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.lines;
	}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
}

class AnchoredHud implements Component {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return 0;
	}
	isNativeScrollbackLiveRegionPinned(): boolean {
		return true;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return ["working…"];
	}
}

const ORIGINAL_ROWS = Object.getOwnPropertyDescriptor(process.stdout, "rows");
function stubStdoutRows(rows: number): void {
	Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
}

function plainScrollBuffer(term: VirtualTerminal): string[] {
	return term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}

function runningJobs(tick: number) {
	const labels = [
		"ApprovalTests",
		"ConfigNotify",
		"FeishuAdapter",
		"AuthSession",
		"ControlRoomAPI",
		"Frontend",
	] as const;
	return labels.map((label, index) => ({
		id: label,
		type: "task" as const,
		status: "running" as const,
		label,
		durationMs: (index === 0 ? 389_000 : 277_000) + tick * 1_000,
	}));
}

function waitPartial(tick: number) {
	return {
		content: [{ type: "text" as const, text: "" }],
		details: { op: "wait" as const, jobs: runningJobs(tick) },
	};
}

function settledWait(tick: number) {
	return {
		content: [{ type: "text" as const, text: "" }],
		details: {
			op: "wait" as const,
			jobs: runningJobs(tick).map(job => ({ ...job, status: "completed" as const })),
		},
	};
}

const VISIBLE_JOBS = ["ApprovalTests", "ConfigNotify", "FeishuAdapter"] as const;

function expectEachJobOnce(buffer: string[]): void {
	for (const label of VISIBLE_JOBS) {
		expect(buffer.filter(line => line.includes(label)).length).toBe(1);
	}
}

describe("hub wait poll never sprays duplicate job rows into scrollback", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		await initTheme();
	});
	afterAll(() => {
		resetSettingsForTest();
	});
	afterEach(() => {
		if (ORIGINAL_ROWS) Object.defineProperty(process.stdout, "rows", ORIGINAL_ROWS);
		else Reflect.deleteProperty(process.stdout, "rows");
	});

	test("running-job rows rewrite in place while the wait is live", async () => {
		const rows = 12;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(80, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.setScrollbackRebuild(false);
		const transcript = new TranscriptContainer();
		const hub = new ToolExecutionComponent(
			"hub",
			{ op: "wait", timeoutMs: 600_000 },
			{ liveRegion: transcript },
			undefined,
			tui,
			process.cwd(),
		);
		transcript.addChild(hub);
		tui.addChild(transcript);
		tui.addChild(new Footer(4));

		try {
			tui.start();
			scheduler.flush();
			await term.flush();
			for (let tick = 1; tick <= 12; tick++) {
				hub.updateResult(waitPartial(tick), true);
				term.scrollLines(1000);
				tui.requestRender();
				scheduler.flush();
				await term.flush();
			}

			expect(hub.isDisplaceableBlock()).toBe(true);
			expect(transcript.isNativeScrollbackLiveRegionPinned()).toBe(true);

			const buffer = plainScrollBuffer(term);
			expect(buffer.join("\n")).toContain("waiting on 6 jobs");
			expectEachJobOnce(buffer);
		} finally {
			hub.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("does not smear when an unpinned live predecessor sits above the wait", async () => {
		const rows = 12;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(80, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.setScrollbackRebuild(false);
		const transcript = new TranscriptContainer();
		transcript.addChild(
			new StaticBlock(Array.from({ length: 20 }, (_, i) => `history-line-${String(i).padStart(2, "0")}`)),
		);
		const hub = new ToolExecutionComponent(
			"hub",
			{ op: "wait", timeoutMs: 600_000 },
			{ liveRegion: transcript },
			undefined,
			tui,
			process.cwd(),
		);
		transcript.addChild(new LiveBarrier(["assistant: still thinking…"]));
		transcript.addChild(hub);
		tui.addChild(transcript);
		tui.addChild(new AnchoredHud());
		tui.addChild(new Footer(5));

		try {
			hub.updateResult(waitPartial(0), true);
			tui.start();
			scheduler.flush();
			await term.flush();
			for (let tick = 1; tick <= 12; tick++) {
				hub.updateResult(waitPartial(tick), true);
				term.scrollLines(1000);
				tui.requestRender();
				scheduler.flush();
				await term.flush();
			}

			expect(transcript.isNativeScrollbackLiveRegionPinned()).toBe(true);
			expect(transcript.getNativeScrollbackLiveRegionPinnedStart()).toBeGreaterThan(
				transcript.getNativeScrollbackLiveRegionStart() ?? 0,
			);
			const buffer = plainScrollBuffer(term);
			expectEachJobOnce(buffer);
		} finally {
			hub.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("does not smear when history has already filled the viewport", async () => {
		const rows = 12;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(80, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.setScrollbackRebuild(false);
		const transcript = new TranscriptContainer();
		transcript.addChild(
			new StaticBlock(Array.from({ length: 40 }, (_, i) => `history-line-${String(i).padStart(2, "0")}`)),
		);
		const hub = new ToolExecutionComponent(
			"hub",
			{ op: "wait", timeoutMs: 600_000 },
			{ liveRegion: transcript },
			undefined,
			tui,
			process.cwd(),
		);
		transcript.addChild(hub);
		tui.addChild(transcript);
		tui.addChild(new Footer(4));

		try {
			tui.start();
			scheduler.flush();
			await term.flush();
			for (let tick = 1; tick <= 12; tick++) {
				hub.updateResult(waitPartial(tick), true);
				term.scrollLines(1000);
				tui.requestRender();
				scheduler.flush();
				await term.flush();
			}

			const buffer = plainScrollBuffer(term);
			expectEachJobOnce(buffer);
		} finally {
			hub.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("a poll taller than the remaining viewport still records each job once", async () => {
		const rows = 8;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(80, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.setScrollbackRebuild(false);
		const transcript = new TranscriptContainer();
		transcript.addChild(
			new StaticBlock(Array.from({ length: 20 }, (_, i) => `history-line-${String(i).padStart(2, "0")}`)),
		);
		const hub = new ToolExecutionComponent(
			"hub",
			{ op: "wait", timeoutMs: 600_000 },
			{ liveRegion: transcript },
			undefined,
			tui,
			process.cwd(),
		);
		transcript.addChild(hub);
		tui.addChild(transcript);
		tui.addChild(new Footer(4));

		try {
			hub.updateResult(waitPartial(0), true);
			tui.start();
			scheduler.flush();
			await term.flush();
			for (let tick = 1; tick <= 12; tick++) {
				hub.updateResult(waitPartial(tick), true);
				term.scrollLines(1000);
				tui.requestRender();
				scheduler.flush();
				await term.flush();
			}

			expect(hub.isDisplaceableBlock()).toBe(true);
			expect(transcript.isNativeScrollbackLiveRegionPinned()).toBe(true);

			hub.updateResult(settledWait(13), false);
			term.scrollLines(1000);
			tui.requestRender();
			scheduler.flush();
			await term.flush();

			const buffer = plainScrollBuffer(term);
			expectEachJobOnce(buffer);
		} finally {
			hub.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);

	test("spinner ticks do not stack job rows", async () => {
		const rows = 12;
		stubStdoutRows(rows);
		const term = new VirtualTerminal(80, rows);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.setScrollbackRebuild(false);
		const transcript = new TranscriptContainer();
		const hub = new ToolExecutionComponent(
			"hub",
			{ op: "wait", timeoutMs: 600_000 },
			{ liveRegion: transcript },
			undefined,
			tui,
			process.cwd(),
		);
		transcript.addChild(hub);
		tui.addChild(transcript);
		tui.addChild(new Footer(4));

		try {
			tui.start();
			hub.updateResult(waitPartial(0), true);
			scheduler.flush();
			await term.flush();
			for (let tick = 0; tick < 20; tick++) {
				hub.tickSpinner(tick);
				term.scrollLines(1000);
				scheduler.flush();
				await term.flush();
			}

			const buffer = plainScrollBuffer(term);
			expectEachJobOnce(buffer);
		} finally {
			hub.stopAnimation();
			tui.stop();
			await term.flush();
		}
	}, 30_000);
});
