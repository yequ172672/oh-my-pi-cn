import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// Loss oracle over the transcript live-region seam: random sequences of
// realistic transcript ops (finalized appends, streaming blocks with settled
// prefixes, pinned dashboards, displaceable cards, resizes) must never lose a
// finalized row — after the run settles, every finalized row must be on the
// tape (scrollback + viewport) at least once. Duplication is the accepted
// mux tradeoff; loss is a bug.

class HistoryBlock implements Component {
	#lines: readonly string[];
	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}
	render(width: number): readonly string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}

/** Streaming block: grows a row per tick, settled prefix trails by one. */
class StreamingBlock implements Component {
	lines: string[];
	finalized = false;
	constructor(private tag: string) {
		this.lines = [`${tag}-000`];
	}
	grow(): void {
		this.lines.push(`${this.tag}-${String(this.lines.length).padStart(3, "0")}`);
	}
	render(width: number): readonly string[] {
		return this.lines.map(line => line.slice(0, width));
	}
	isTranscriptBlockFinalized(): boolean {
		return this.finalized;
	}
	getTranscriptBlockSettledRows(): number {
		return this.finalized ? this.lines.length : Math.max(0, this.lines.length - 1);
	}
}

/** Pinned dashboard (running task / hub poll): frames replace each other. */
class PinnedBlock implements Component {
	lines: string[];
	finalized = false;
	sealed = false;
	displaceable: boolean;
	constructor(
		private tag: string,
		displaceable: boolean,
	) {
		this.displaceable = displaceable;
		this.lines = [`${tag}-frame-0`, `${tag}-frame-0b`];
	}
	tick(n: number): void {
		if (this.sealed || this.finalized) return;
		this.lines = [`${this.tag}-frame-${n}`, `${this.tag}-frame-${n}b`];
	}
	render(width: number): readonly string[] {
		return this.lines.map(line => line.slice(0, width));
	}
	isTranscriptBlockFinalized(): boolean {
		return this.finalized || this.sealed;
	}
	isNativeScrollbackLiveRegionPinned(): boolean {
		return !this.isTranscriptBlockFinalized();
	}
	isDisplaceableBlock(): boolean {
		return this.displaceable && !this.sealed;
	}
	seal(): void {
		this.sealed = true;
	}
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const ENV_KEYS = ["TMUX", "STY", "ZELLIJ", "HERDR_ENV", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "TERM"];

async function fuzz(seed: number, mux: boolean): Promise<string[]> {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) {
		saved[key] = Bun.env[key];
		delete Bun.env[key];
	}
	Bun.env.TERM = "xterm-256color";
	if (mux) Bun.env.TMUX = "1";
	const rand = mulberry32(seed);
	const term = new VirtualTerminal(40, 8, 100_000);
	Object.defineProperty(term, "isNativeViewportAtBottom", { configurable: true, value: () => undefined });
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const chat = new TranscriptContainer();
	tui.addChild(chat);

	const finalRows: string[] = [];
	const streams: StreamingBlock[] = [];
	const pins: PinnedBlock[] = [];
	let blockId = 0;
	let tick = 0;

	try {
		tui.start();
		await scheduler.drain(term);
		for (let step = 0; step < 120; step++) {
			const op = rand();
			tick++;
			if (op < 0.35) {
				const rows = [`h${String(blockId).padStart(3, "0")}-a`, `h${String(blockId).padStart(3, "0")}-b`];
				blockId++;
				finalRows.push(...rows);
				chat.addChild(new HistoryBlock(rows));
			} else if (op < 0.5) {
				const s = new StreamingBlock(`s${String(blockId++).padStart(3, "0")}`);
				streams.push(s);
				chat.addChild(s);
			} else if (op < 0.7) {
				for (const s of streams) if (!s.finalized && rand() < 0.7) s.grow();
			} else if (op < 0.78) {
				const live = streams.filter(s => !s.finalized);
				if (live.length > 0) live[Math.floor(rand() * live.length)]!.finalized = true;
			} else if (op < 0.88) {
				const p = new PinnedBlock(`p${String(blockId++).padStart(3, "0")}`, rand() < 0.5);
				pins.push(p);
				chat.addChild(p);
			} else if (op < 0.9) {
				for (const p of pins) p.tick(tick);
			} else if (op < 0.93) {
				const live = pins.filter(p => !p.isTranscriptBlockFinalized());
				if (live.length > 0) live[Math.floor(rand() * live.length)]!.finalized = true;
			} else if (op < 0.96) {
				// Height-only resize (width fixed so the text oracle survives
				// rewrap); sometimes net-unchanged, which is still a geometry frame.
				const heights = [6, 8, 10];
				term.resize(40, heights[Math.floor(rand() * heights.length)]!);
			} else {
				tui.requestRender(true);
			}
			tui.requestRender();
			await scheduler.drain(term);
		}
		// Settle: finalize everything, then a few frames so backfill lands.
		for (const s of streams) s.finalized = true;
		for (const p of pins) p.finalized = true;
		for (let i = 0; i < 4; i++) {
			tui.requestRender();
			await scheduler.drain(term);
		}
		// Streaming/pinned final rows are part of the record once finalized.
		for (const s of streams) finalRows.push(...s.lines);
		for (const p of pins) finalRows.push(...p.lines);
	} finally {
		tui.stop();
		await term.flush();
		for (const key of ENV_KEYS) {
			const value = saved[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}

	const seen = new Set<string>();
	for (const row of [...term.getScrollBuffer(), ...term.getViewport()]) {
		seen.add(Bun.stripANSI(row).trimEnd());
	}
	return finalRows.filter(row => !seen.has(row));
}

describe("transcript live-region fuzz: finalized rows never vanish", () => {
	for (const mux of [false, true]) {
		it(`mux=${mux}`, async () => {
			for (let seed = 1; seed <= 40; seed++) {
				const missing = await fuzz(seed, mux);
				if (missing.length > 0) {
					throw new Error(
						`seed=${seed} mux=${mux} lost ${missing.length} rows: ${missing.slice(0, 8).join(", ")}`,
					);
				}
			}
			expect(true).toBe(true);
		});
	}
});
