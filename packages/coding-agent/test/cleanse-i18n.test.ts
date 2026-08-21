import { afterEach, describe, expect, it } from "bun:test";
import { CleanseBoardModel } from "@oh-my-pi/pi-coding-agent/cleanse/board";
import type { CleanseAssignment, CleanseCheckResult } from "@oh-my-pi/pi-coding-agent/cleanse/types";
import { setLanguage } from "@oh-my-pi/pi-coding-agent/i18n";
import { CleansePanelComponent } from "@oh-my-pi/pi-coding-agent/modes/components/cleanse-panel";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

async function withDarkTheme(run: () => void): Promise<void> {
	const priorTheme = theme;
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Expected dark theme");
	try {
		setThemeInstance(dark);
		run();
	} finally {
		setThemeInstance(priorTheme);
	}
}

afterEach(() => {
	setLanguage("en");
});

const assignment: CleanseAssignment = {
	index: 0,
	weight: 2,
	groups: [
		{ file: "src/a.ts", weight: 1, diagnostics: [] },
		{ file: "src/b.ts", weight: 1, diagnostics: [] },
	],
};

describe("cleanse dynamic localization", () => {
	it("renders Chinese checker, wave, and file counts", async () => {
		await withDarkTheme(() => {
			setLanguage("zh-CN");
			const model = new CleanseBoardModel();
			const check: CleanseCheckResult = {
				id: "typescript",
				label: "TypeScript",
				language: "TypeScript",
				cwd: "/repo",
				command: "tsgo --noEmit",
				exitCode: 1,
				diagnostics: [
					{ checker: "TypeScript", severity: "error", message: "one" },
					{ checker: "TypeScript", severity: "error", message: "two" },
				],
			};

			model.checkerStarted({
				id: "typescript",
				label: "TypeScript",
				language: "TypeScript",
				command: check.command,
			});
			expect(Bun.stripANSI(model.checkerFinished(check, 5))).toContain("2 个问题");

			model.waveStarted(3);
			model.agentStarted("CleanseW1A1", assignment);
			model.agentStarted("CleanseW1A2", { ...assignment, index: 1 });
			const live = Bun.stripANSI(model.renderLive("*").join("\n"));
			expect(live).toContain("正在修复");
			expect(live).toContain("2 个运行中");
			expect(live).toContain("src/a.ts，另有 1 个文件");
		});
	});

	it("renders Chinese success, cancellation, and failure panel outcomes", async () => {
		await withDarkTheme(() => {
			setLanguage("zh-CN");
			const tui = { requestRender() {} } as unknown as TUI;
			const renderOutcome = (outcome: "clean" | "cancelled" | "error"): string => {
				const panel = new CleansePanelComponent({ tui });
				if (outcome === "error") panel.markError("provider timeout");
				else panel.finish(outcome);
				const rendered = Bun.stripANSI(panel.render(100).join("\n"));
				panel.dispose();
				return rendered;
			};

			expect(renderOutcome("clean")).toContain("清理完成 · 按 Esc 关闭");
			expect(renderOutcome("cancelled")).toContain("已取消 · 按 Esc 关闭");
			const failure = renderOutcome("error");
			expect(failure).toContain("出错 · 按 Esc 关闭");
			expect(failure).toContain("provider timeout");
		});
	});
});
