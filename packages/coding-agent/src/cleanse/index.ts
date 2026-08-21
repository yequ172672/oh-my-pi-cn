import { getProjectDir } from "@oh-my-pi/pi-utils";
import { pickCleanseTarget, promptCleanseRequest } from "../cli/cleanse-picker";
import { t } from "../i18n";
import { shortenPath } from "../tools/render-utils";
import { type CleanseAgentHooks, type CleanseAgentRuntime, createCleanseAgentRuntime } from "./agent";
import { groupDiagnosticsByFile } from "./balance";
import { type CleanseStatusBoard, createCleanseStatusBoard } from "./board";
import {
	buildCustomCleanseSuite,
	type CleanseCheckerDescriptor,
	type CleanseCheckerRunEvents,
	type CleanseDiagnosticSuite,
	discoverCleanseDiagnosticSuite,
} from "./checkers";
import { runCleanseLoop } from "./loop";
import type { CleanseCommandResult, CleanseDiagnosticReport, CleanseLoopResult, CleanseTargetChoice } from "./types";

const DEFAULT_MODEL = "@smol";
const DISPLAY_FILE_LIMIT = 50;

/** User-facing options for `omp cleanse`. */
export interface CleanseCommandOptions {
	maxAgents?: number;
	model?: string;
	includeTests?: boolean;
	/** Free-form description handed to a discovery agent instead of built-in checker discovery. */
	request?: string;
	/** Run every discovered checker without the interactive picker. */
	all?: boolean;
}

/** Rendering and prompting seam for one cleanse run; satisfied by the CLI streams and the TUI overlay. */
export interface CleanseRunUi {
	board: CleanseStatusBoard;
	/** Permanent user-facing summary line. */
	print(text: string): void;
	/** Permanent failure/cancellation line. */
	printError(text: string): void;
	/** Choose between discovered checkers; omit to run every checker without prompting. */
	pickTarget?(checkers: readonly CleanseCheckerDescriptor[]): Promise<CleanseTargetChoice>;
	/** Free-form request prompt when no runnable checker was discovered; `null` cancels. */
	promptRequest?(): Promise<string | null>;
}

/**
 * Detect project diagnostics, dispatch one bounded repair batch, and verify it.
 *
 * Cancellation flows exclusively through `signal`; the caller owns signal
 * sources (SIGINT for the CLI, Esc for the interactive overlay).
 */
export async function runCleanse(
	options: CleanseCommandOptions,
	ui: CleanseRunUi,
	signal: AbortSignal,
): Promise<CleanseCommandResult> {
	const maxAgents = options.maxAgents ?? 32;
	if (!Number.isInteger(maxAgents) || maxAgents <= 0) throw new Error(t("cleanse.agentsPositive"));
	const model = options.model?.trim() || DEFAULT_MODEL;
	const cwd = getProjectDir();
	let runtime: CleanseAgentRuntime | undefined;
	let loopResult: CleanseLoopResult | undefined;
	const board = ui.board;
	const hooks: CleanseAgentHooks = {
		onStart: (name, assignment) => board.agentStarted(name, assignment),
		onProgress: (name, _assignment, progress) => board.agentProgress(name, progress),
		onFinish: (outcome, assignment) => board.agentFinished(outcome, assignment),
	};
	const checkerEvents: CleanseCheckerRunEvents = {
		onCheckerStart: checker => board.checkerStarted(checker),
		onCheckerEnd: (check, durationMs) => board.checkerFinished(check, durationMs),
	};
	const ensureRuntime = async (): Promise<CleanseAgentRuntime> => {
		if (runtime) return runtime;
		board.phase(t("cleanse.resolvingModel", { model }));
		try {
			runtime = await createCleanseAgentRuntime({ cwd, model, hooks });
		} finally {
			board.phase(undefined);
		}
		board.log(t("cleanse.model", { model: runtime.model }));
		board.log(t("cleanse.session", { session: shortenPath(runtime.sessionFile) }));
		return runtime;
	};

	try {
		let request = options.request?.trim() || undefined;
		let suite: CleanseDiagnosticSuite | undefined;
		if (!request) {
			board.phase(t("cleanse.detectingCheckers"));
			suite = await discoverCleanseDiagnosticSuite(cwd, { includeTests: options.includeTests });
			board.phase(undefined);
			const pickTarget = options.all === true ? undefined : ui.pickTarget;
			if (pickTarget) {
				if (suite.checkers.length > 0) {
					const choice = await pickTarget(suite.checkers);
					if (choice.kind === "cancel") {
						ui.printError(t("cleanse.cancelled"));
						return {
							exitCode: 130,
							status: "cancelled",
							report: { checks: [], diagnostics: [], skipped: [...suite.skipped] },
						};
					}
					if (choice.kind === "checker") suite.select([choice.id]);
					if (choice.kind === "request") {
						request = choice.request;
						suite = undefined;
					}
				} else {
					printSkippedChecks(ui, { checks: [], diagnostics: [], skipped: [...suite.skipped] });
					ui.print(t("cleanse.noSupportedChecker"));
					const answer = (await ui.promptRequest?.()) ?? null;
					if (answer === null) {
						return {
							exitCode: 1,
							status: "unsupported",
							report: { checks: [], diagnostics: [], skipped: [...suite.skipped] },
						};
					}
					request = answer;
					suite = undefined;
				}
			}
		}
		if (request) {
			const activeRuntime = await ensureRuntime();
			board.phase(t("cleanse.discoveringCheckers", { request }));
			try {
				const specs = await activeRuntime.discoverCheckers(request, signal);
				suite = await buildCustomCleanseSuite(cwd, specs);
			} finally {
				board.phase(undefined);
			}
			for (const checker of suite.checkers) {
				board.log(`[checker] ${checker.label}: ${checker.command}`);
			}
		}
		if (!suite || suite.checkers.length === 0) {
			const report: CleanseDiagnosticReport = { checks: [], diagnostics: [], skipped: [...(suite?.skipped ?? [])] };
			printSkippedChecks(ui, report);
			ui.printError(request ? t("cleanse.noDiscoveredCommand") : t("cleanse.noSupportedChecker"));
			return { exitCode: 1, status: "unsupported", report, sessionFile: runtime?.sessionFile };
		}
		const initialReport = await suite.run(signal, checkerEvents);
		if (board.interactive) printSkippedChecks(ui, initialReport);
		else printCheckReport(ui, initialReport);
		if (initialReport.diagnostics.length === 0) {
			ui.print(
				t(initialReport.checks.length === 1 ? "cleanse.checkersPassedOne" : "cleanse.checkersPassedMany", {
					count: initialReport.checks.length,
				}),
			);
			return { exitCode: 0, status: "clean", report: initialReport, sessionFile: runtime?.sessionFile };
		}

		const assignments = groupDiagnosticsByFile(initialReport.diagnostics);
		const agentCount = Math.min(maxAgents, assignments.length);
		const fileCount = assignments.filter(group => group.file !== undefined).length;
		board.log(
			t("cleanse.foundDiagnostics", {
				diagnostics: initialReport.diagnostics.length,
				files: fileCount,
				agents: agentCount,
			}),
		);
		const activeRuntime = await ensureRuntime();
		const activeSuite = suite;
		loopResult = await runCleanseLoop(
			{ maxAgents, initialReport, signal },
			{
				collect: loopSignal => activeSuite.run(loopSignal, checkerEvents),
				dispatch: (batch, wave, report, loopSignal) => activeRuntime.dispatch(batch, wave, report, loopSignal),
				onWave(_wave, batch) {
					board.log(
						t(batch.length === 1 ? "cleanse.dispatchingOne" : "cleanse.dispatchingMany", {
							count: batch.length,
						}),
					);
					board.waveStarted(batch.length);
				},
				onReport(_wave, report) {
					board.waveFinished();
					board.log(t("cleanse.verification", { count: report.diagnostics.length }));
				},
			},
		);
		board.close();
		await activeRuntime.close(loopResult);
		if (loopResult.status === "cancelled") {
			ui.printError(t("cleanse.cancelled"));
			return {
				exitCode: 130,
				status: "cancelled",
				report: loopResult.report,
				sessionFile: activeRuntime.sessionFile,
			};
		}
		if (loopResult.status === "clean") {
			ui.print(t("cleanse.allResolved"));
			return { exitCode: 0, status: "clean", report: loopResult.report, sessionFile: activeRuntime.sessionFile };
		}
		printRemaining(ui, loopResult.report);
		return { exitCode: 1, status: "unresolved", report: loopResult.report, sessionFile: activeRuntime.sessionFile };
	} catch (error) {
		if (!signal.aborted) throw error;
		const report: CleanseDiagnosticReport = loopResult?.report ?? { checks: [], diagnostics: [], skipped: [] };
		board.close();
		ui.printError(t("cleanse.cancelled"));
		return { exitCode: 130, status: "cancelled", report, sessionFile: runtime?.sessionFile };
	} finally {
		board.close();
		await runtime?.close(loopResult);
	}
}

/** CLI adapter for {@link runCleanse}: stdout board, one-shot pickers, SIGINT/SIGTERM cancellation. */
export async function runCleanseCommand(options: CleanseCommandOptions = {}): Promise<CleanseCommandResult> {
	const abortController = new AbortController();
	const abort = (): void => abortController.abort(new Error(t("cleanse.interrupted")));
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
	const ui: CleanseRunUi = {
		board: createCleanseStatusBoard(),
		print: text => process.stdout.write(`${text}\n`),
		printError: text => process.stderr.write(`${text}\n`),
		pickTarget: interactive ? pickCleanseTarget : undefined,
		promptRequest: interactive ? promptCleanseRequest : undefined,
	};
	try {
		return await runCleanse(options, ui, abortController.signal);
	} finally {
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
	}
}

function printCheckReport(ui: CleanseRunUi, report: CleanseDiagnosticReport): void {
	for (const check of report.checks) {
		const count = check.diagnostics.length;
		ui.print(
			`- ${check.label}: ${count === 0 ? t("cleanse.board.clean") : t(count === 1 ? "cleanse.board.issueOne" : "cleanse.board.issueMany", { count })}`,
		);
	}
	printSkippedChecks(ui, report);
}

function printSkippedChecks(ui: CleanseRunUi, report: CleanseDiagnosticReport): void {
	for (const skipped of report.skipped) {
		ui.print(t("cleanse.skipped", { label: skipped.label, reason: skipped.reason }));
	}
}

function printRemaining(ui: CleanseRunUi, report: CleanseDiagnosticReport): void {
	const groups = groupDiagnosticsByFile(report.diagnostics);
	ui.printError(t("cleanse.unresolved", { count: report.diagnostics.length }));
	for (const group of groups.slice(0, DISPLAY_FILE_LIMIT)) {
		ui.printError(`- ${group.file ?? t("cleanse.project")}: ${group.diagnostics.length}`);
	}
	if (groups.length > DISPLAY_FILE_LIMIT) {
		ui.printError(t("cleanse.moreFiles", { count: groups.length - DISPLAY_FILE_LIMIT }));
	}
}
