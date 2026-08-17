import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

class TestModalEditor extends CustomEditor {}

class RenderCountingTUI extends TUI {
	renderCount = 0;

	override render(width: number): readonly string[] {
		this.renderCount++;
		return super.render(width);
	}
}

async function expectTwoDirectShimmerFrames(
	tui: RenderCountingTUI,
	terminal: VirtualTerminal,
	writes: readonly string[],
	keyword: string,
): Promise<void> {
	const renderCount = tui.renderCount;
	const viewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	const bufferPosition = terminal.getBufferPosition();
	const scrollback = terminal
		.getScrollBuffer()
		.slice(0, bufferPosition.baseY)
		.map(row => Bun.stripANSI(row).trimEnd());
	const cursor = terminal.getCursor();
	const writesBeforeFirstPhase = writes.length;

	expect(viewport.join("\n")).toContain(keyword);
	expect(bufferPosition.baseY).toBeGreaterThan(0);

	vi.advanceTimersByTime(CustomEditor.SHIMMER_FRAME_MS);
	await terminal.flush();
	const firstPhaseWrites = writes.slice(writesBeforeFirstPhase);
	expect(firstPhaseWrites.length).toBeGreaterThan(0);
	expect(firstPhaseWrites.join("")).toContain("\x1b[38");

	const writesBeforeSecondPhase = writes.length;
	vi.advanceTimersByTime(CustomEditor.SHIMMER_FRAME_MS);
	await terminal.flush();
	const secondPhaseWrites = writes.slice(writesBeforeSecondPhase);
	expect(secondPhaseWrites.length).toBeGreaterThan(0);
	expect(secondPhaseWrites.join("")).toContain("\x1b[38");
	expect(secondPhaseWrites.join("")).not.toBe(firstPhaseWrites.join(""));

	expect(tui.renderCount).toBe(renderCount);
	expect(terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd())).toEqual(viewport);
	expect(terminal.getBufferPosition()).toEqual(bufferPosition);
	expect(
		terminal
			.getScrollBuffer()
			.slice(0, bufferPosition.baseY)
			.map(row => Bun.stripANSI(row).trimEnd()),
	).toEqual(scrollback);
	expect(terminal.getCursor()).toEqual(cursor);
}

describe("InteractiveMode.setEditorComponent", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-editor-component-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("replaces the editor and rebinds interactive handlers", () => {
		mode.editor.setText("draft prompt");
		const previousEditor = mode.editor;
		const refreshSpy = vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();

		mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));

		expect(mode.editor).toBeInstanceOf(TestModalEditor);
		expect(mode.editor).not.toBe(previousEditor);
		expect(mode.editor.getText()).toBe("draft prompt");
		expect(mode.editor.onSubmit).toBeDefined();
		expect(mode.editor.onEscape).toBeDefined();
		expect(refreshSpy).toHaveBeenCalled();
	});

	it("direct-writes focused shimmer frames without disturbing terminal state before or after replacement", async () => {
		const terminal = new VirtualTerminal(80, 8, 1_000);
		terminal.write(Array.from({ length: 12 }, (_unused, index) => `seed-${index}\r\n`).join(""));
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation((data: string) => {
			writes.push(data);
			write(data);
		});
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(terminal, true, { renderScheduler: scheduler });
		const initialEditor = mode.editor;
		let replacementEditor: CustomEditor | undefined;

		vi.spyOn(mode, "refreshSlashCommandState").mockResolvedValue();
		vi.useFakeTimers();
		setSystemTime(0);
		try {
			mode.ui = tui;
			initialEditor.setUseTerminalCursor(true);
			initialEditor.magicKeywordsEnabledOverride = true;
			initialEditor.setText("please orchestrate this draft");
			tui.addChild(mode.editorContainer);
			tui.setFocus(initialEditor);
			tui.start();
			await scheduler.drain(terminal);

			await expectTwoDirectShimmerFrames(tui, terminal, writes, "orchestrate");
			initialEditor.setShimmerRepaintHandler(undefined);

			mode.setEditorComponent((_tui, editorTheme) => new TestModalEditor(editorTheme));
			replacementEditor = mode.editor;
			replacementEditor.magicKeywordsEnabledOverride = true;
			replacementEditor.setText("please workflowz this draft");
			await scheduler.drain(terminal);

			await expectTwoDirectShimmerFrames(tui, terminal, writes, "workflowz");
		} finally {
			initialEditor.setShimmerRepaintHandler(undefined);
			replacementEditor?.setShimmerRepaintHandler(undefined);
			tui.stop();
			await terminal.flush();
			vi.useRealTimers();
			setSystemTime();
		}
	});
});
