import * as nodePath from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../lsp";
import type { ToolSession } from "../tools";
import { routeWriteThroughBridge } from "../tools/acp-bridge";
import { invalidateFsScanAfterWrite } from "../tools/fs-cache-invalidation";
import { outputMeta } from "../tools/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../tools/plan-mode-guard";
import { type DiffError, type DiffResult, generateDiffString } from "./diff";
import { levenshteinDistance } from "./modes/replace";
import {
	detectIndentChar,
	detectLineEnding,
	normalizeToLF,
	normalizeUnicode,
	restoreLineEndings,
	stripBom,
} from "./normalize";
import { readEditFileText, serializeEditFileText } from "./read-file";
import type { EditToolDetails, EditToolPerFileResult, LspBatchRequest } from "./renderer";
import sloppyGrammarSource from "./sloppy.lark" with { type: "text" };
import description from "./sloppy.md" with { type: "text" };
import { pruneOversizedEditSnapshots } from "./snapshot-details";

/** Context handed to a {@link SloppyVariant} apply call. */
export interface SloppyApplyContext {
	/** Workspace-relative display path of the file being edited — for error messages. */
	readonly path: string;
	/** Sink for post-apply advisories (e.g. deletion callouts) shown with the success text. */
	readonly notes?: string[];
}

/**
 * The sloppy-format implementation contract: a pure text transformer — no
 * file I/O, no tool state.
 */
export interface SloppyVariant {
	/** Stable format identifier. */
	readonly id: string;
	/** Tool-description markdown teaching the model the payload grammar. */
	readonly description: string;
	/** Apply the payload to full file content and return the new full content. */
	apply(content: string, input: string, context: SloppyApplyContext): string;
}

export const sloppyEditSchema = type({
	input: "string",
});

export type SloppyParams = typeof sloppyEditSchema.infer;

const PATH_HEADER_RE = /^\[([^\]\n]+)\]$/;

/** One `[path]` section of a sloppy payload: a file plus its operations. */
export interface SloppySection {
	path: string;
	body: string;
}

/**
 * Split a sloppy payload into `[path]` sections, hashline-style. The first
 * line MUST be a header; a later whole-line `[path]` opens a new section only
 * when the next non-blank line starts an operation («), so content lines
 * that merely look like headers stay in their operation. Same-path sections
 * merge in order. Returns an empty list when the payload has no leading header.
 */
export function splitSloppySections(input: string): SloppySection[] {
	const lines = input.split("\n");
	if (lines.length === 0 || !PATH_HEADER_RE.test(lines[0])) return [];
	const sections: SloppySection[] = [];
	const bodiesByPath = new Map<string, string[]>();
	let currentPath = "";
	let currentBody: string[] = [];
	const flush = () => {
		if (!currentPath) return;
		let body = bodiesByPath.get(currentPath);
		if (!body) {
			body = [];
			bodiesByPath.set(currentPath, body);
			sections.push({ path: currentPath, body: "" });
		}
		body.push(...currentBody);
		currentBody = [];
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const header = PATH_HEADER_RE.exec(line);
		if (header && (index === 0 || startsOperation(lines, index + 1))) {
			flush();
			currentPath = header[1];
			continue;
		}
		currentBody.push(line);
	}
	flush();
	for (const section of sections) {
		section.body = (bodiesByPath.get(section.path) ?? []).join("\n");
	}
	return sections;
}

/** True when the next non-blank line opens a sloppy operation. */
function startsOperation(lines: string[], from: number): boolean {
	for (let index = from; index < lines.length; index++) {
		const trimmed = lines[index].trim();
		if (trimmed === "") continue;
		return trimmed.startsWith(OPENER);
	}
	return false;
}

/**
 * Preview one payload section against the file on disk: apply in memory and
 * diff. Used by the streaming edit preview; never writes.
 */
export async function computeSloppySectionDiff(section: SloppySection, cwd: string): Promise<DiffResult | DiffError> {
	try {
		const absolutePath = nodePath.isAbsolute(section.path) ? section.path : nodePath.resolve(cwd, section.path);
		const rawContent = await readEditFileText(absolutePath, section.path);
		const normalizedContent = normalizeToLF(stripBom(rawContent).text);
		const newContent = sloppyVariant.apply(normalizedContent, normalizeToLF(section.body), { path: section.path });
		return generateDiffString(normalizedContent, newContent, undefined, { path: section.path });
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export const SLOPPY_MARKERS = {
	open: "«",
	put: "»",
	selectOpen: "⟪",
	selectClose: "⟫",
	gap: "…",
	selectDivider: "│",
} as const;

const OPENER = SLOPPY_MARKERS.open;
const REWRITE_HEADER = SLOPPY_MARKERS.put;
const SELECT_OPEN = SLOPPY_MARKERS.selectOpen;
const SELECT_CLOSE = SLOPPY_MARKERS.selectClose;
const SELECT_DIVIDER = SLOPPY_MARKERS.selectDivider;
const GAP = SLOPPY_MARKERS.gap;
const MAX_CANDIDATES = 200;
const MAX_COMBINATIONS = 20_000;
const noOpByPath = new Map<string, { hash: string; count: number }>();
const ATOMICITY_NOTICE = "No operations were applied — ops apply atomically; re-send the full corrected payload.";

interface ExplicitRewrite {
	kind: "explicit";
	text: string;
}

interface InlineRewrite {
	kind: "inline";
	replacements: string[];
}

type OperationRewrite = ExplicitRewrite | InlineRewrite;

interface Operation {
	patternText: string;
	sourcePatternText: string;
	rewrite: OperationRewrite;
	all: boolean;
	/** Pattern-only op applied as a deletion; justified only when another op re-emits the block. */
	assumedDeletion?: boolean;
	/** Post-apply advisory for a formally invalid payload recovered at parse time. */
	recoveryNote?: string;
}

interface LiteralToken {
	kind: "literal";
	text: string;
	normalized: string;
}

interface GapToken {
	kind: "gap";
	captureIndex: number;
	lineBounded: boolean;
}

type PatternToken = LiteralToken | GapToken;

interface LiteralFallback {
	normalized: string;
	selectionStart: number;
	selectionEnd: number;
	insertion: boolean;
}

interface SelectionPair {
	start: number;
	end: number;
	captureIndices: number[];
	lineInsertion: boolean;
}

interface ParsedPattern {
	tokens: PatternToken[];
	selectionStart: number;
	selectionEnd: number;
	insertion: boolean;
	lineInsertion: boolean;
	selectedCaptureIndices: number[];
	selectionRanges: Array<{ start: number; end: number }>;
	selectionPairs: SelectionPair[];
	literalFallback: LiteralFallback | undefined;
}

interface NormalizedText {
	text: string;
	starts: number[];
	ends: number[];
}

interface Occurrence {
	start: number;
	end: number;
	distance: number;
	punctuationEdits: number;
}

interface Candidate {
	start: number;
	end: number;
	matchStart: number;
	matchEnd: number;
	captures: string[];
	selectionSpans: Array<{ start: number; end: number }>;
	tuple: number[];
}

interface CandidateResult {
	candidates: Candidate[];
	overflow: boolean;
}

interface PlannedEdit {
	start: number;
	end: number;
	replacement: string;
	operationNumber: number;
}

function parseOpener(line: string): number | undefined | false {
	const match = line.trim().match(/^«(\*?)$/u);
	if (!match) return false;
	return match[1] ? 0 : undefined;
}

/** A numbered opener: the author meant either a unique match or every match. */
function isOrdinalOpener(line: string): boolean {
	return /^«[1-9]\d*$/u.test(line.trim());
}

function normalizeInput(input: string): string {
	const lines = input
		.split("\n")
		.filter(line => {
			const trimmed = line.trim();
			return !/^\*{3}\s*(?:Begin Patch|End Patch|Abort|Update File:|Add File:|Delete File:)/iu.test(trimmed);
		})
		.flatMap(line => {
			const glued = line.match(/^(«\*?|»)([ \t]+\S.*)$/u);
			return glued ? [glued[1], glued[2]] : [line];
		});
	while (lines[0]?.trim() === "") lines.shift();
	if (/^```(?:text|typescript|ts|tsx|javascript|js)?\s*$/iu.test(lines[0]?.trim() ?? "")) {
		lines.shift();
		while (lines.at(-1)?.trim() === "") lines.pop();
		if (lines.at(-1)?.trim() === "```") lines.pop();
	}
	while (lines[0]?.trim() === "") lines.shift();
	while (lines.at(-1)?.trim() === "") lines.pop();
	return lines.join("\n");
}

function normalizeBlock(lines: string[], rewrite: boolean): string {
	const cleaned = lines.filter(line => {
		const trimmed = line.trim();
		return !(
			/^\[(?:Showing lines\b|(?:…|\.\.\.)\d+ln elided\b).*\]$/iu.test(trimmed) ||
			/^\d+(?:-\d+)?:\s*(?:…|\.\.\.)\s*$/u.test(trimmed)
		);
	});
	while (cleaned.at(-1)?.trim() === "") cleaned.pop();
	const nonBlank = cleaned.filter(line => line.trim() !== "");
	if (
		nonBlank.length > 0 &&
		nonBlank.every(line => /^\s*\d+\s*[:|]/u.test(line)) &&
		!nonBlank.every(line => /^\s*\d+\s*[:|]\s*(?:\d|["'`])/u.test(line))
	) {
		for (let index = 0; index < cleaned.length; index++) {
			cleaned[index] = cleaned[index].replace(/^\s*\d+\s*[:|]/u, "");
		}
	}
	if (rewrite) {
		// Models sometimes annotate the rewrite with a bare `//` header line;
		// written verbatim it corrupts the file. Worded comments stay.
		if (cleaned[0]?.trim() === "//") cleaned.shift();
		const hasOld = cleaned.some(line => /^-(?!---)/u.test(line));
		const hasNew = cleaned.some(line => /^\+(?!\+\+)/u.test(line));
		if (hasOld && hasNew) {
			return cleaned
				.filter(line => !/^-(?!---)/u.test(line) && !/^(?:---|\+\+\+)(?:\s|$)/u.test(line))
				.map(line => (line.startsWith("+") ? line.slice(1) : line))
				.join("\n");
		}
		if (nonBlank.length > 0 && nonBlank.every(line => line.startsWith("+"))) {
			return cleaned.map(line => (line.startsWith("+") ? line.slice(1) : line)).join("\n");
		}
	}
	return cleaned.join("\n");
}

function recoverMissingSeparator(
	lines: string[],
	content: string,
): { patternText: string; rewrite: string } | undefined {
	const candidates: Array<{ patternText: string; rewrite: string }> = [];
	for (let split = 1; split < lines.length; split++) {
		let remainderStart = split;
		while (lines[remainderStart]?.trim() === "") remainderStart++;
		if (remainderStart >= lines.length) continue;
		const patternText = normalizeBlock(lines.slice(0, split), false);
		const rewrite = normalizeBlock(lines.slice(remainderStart), true);
		// A gap-only remainder is context elision, never final text; adopting it
		// as the rewrite would write literal `…` into the file.
		if (patternText.length < 4 || rewrite.replaceAll(GAP, "").trim() === "") continue;
		const matches = exactOccurrences(content, patternText);
		if (matches.length !== 1) continue;
		const throughFirstRewriteLine = normalizeBlock(lines.slice(0, remainderStart + 1), false);
		if (content.startsWith(throughFirstRewriteLine, matches[0].start)) continue;
		if (!candidates.some(candidate => candidate.patternText === patternText && candidate.rewrite === rewrite)) {
			candidates.push({ patternText, rewrite });
		}
	}
	return candidates.length === 1 ? candidates[0] : undefined;
}

function recoverAlternatingSeparators(lines: string[], content: string): string[] | undefined {
	if (lines.some(line => line.trim() === REWRITE_HEADER)) return undefined;
	const headers = lines.flatMap((line, index) => (parseOpener(line) === false ? [] : [index]));
	if (headers.length < 2 || headers.length % 2 !== 0 || headers[0] !== 0) return undefined;
	const normalizedContent = normalizeText(content).text;
	const recovered: string[] = [];
	for (let pair = 0; pair < headers.length; pair += 2) {
		const matchStart = headers[pair];
		const rewriteStart = headers[pair + 1];
		const next = headers[pair + 2] ?? lines.length;
		const matchLines = lines.slice(matchStart + 1, rewriteStart);
		const rewriteLines = lines.slice(rewriteStart + 1, next);
		const normalizedMatch = normalizeText(normalizeBlock(matchLines, false)).text;
		const normalizedRewrite = normalizeText(normalizeBlock(rewriteLines, true)).text;
		if (
			normalizedMatch === "" ||
			normalizedRewrite === "" ||
			!normalizedContent.includes(normalizedMatch) ||
			normalizedContent.includes(normalizedRewrite)
		) {
			return undefined;
		}
		recovered.push(lines[matchStart], ...matchLines, REWRITE_HEADER, ...rewriteLines);
	}
	return recovered;
}

function hasInlineSelection(pattern: string): boolean {
	let selected = false;
	for (let index = 0; index < pattern.length; ) {
		const codePoint = pattern.codePointAt(index);
		if (codePoint === undefined) break;
		const character = String.fromCodePoint(codePoint);
		if (character === SELECT_OPEN) selected = true;
		else if (character === SELECT_CLOSE) selected = false;
		else if (character === SELECT_DIVIDER && selected) return true;
		index += character.length;
	}
	return false;
}

function validateSelectionMarkers(pattern: string, operationNumber: number): void {
	const openCount = (pattern.match(/⟪/gu) || []).length;
	const closeCount = (pattern.match(/⟫/gu) || []).length;
	if (openCount === closeCount) return;
	throw new Error(
		openCount > closeCount
			? `Operation ${operationNumber} has an unclosed selection marker ⟪; add closing ⟫.`
			: `Operation ${operationNumber} has an unmatched closing selection marker ⟫; add opening ⟪.`,
	);
}

function parseInlinePattern(pattern: string, operationNumber: number): { patternText: string; replacements: string[] } {
	validateSelectionMarkers(pattern, operationNumber);
	let patternText = "";
	const replacements: string[] = [];
	let sawBare = false;
	let sawInline = false;

	for (let index = 0; index < pattern.length; ) {
		const codePoint = pattern.codePointAt(index);
		if (codePoint === undefined) break;
		const character = String.fromCodePoint(codePoint);
		if (character === SELECT_CLOSE) {
			throw new Error(`Operation ${operationNumber} has an unmatched closing selection marker ⟫; add opening ⟪.`);
		}
		if (character !== SELECT_OPEN) {
			patternText += character;
			index += character.length;
			continue;
		}

		const close = pattern.indexOf(SELECT_CLOSE, index + character.length);
		const selected = pattern.slice(index + character.length, close);
		if (selected.includes(SELECT_OPEN)) {
			throw new Error(
				`Operation ${operationNumber} has nested selection markers; use one selection per replacement.`,
			);
		}
		const divider = selected.indexOf(SELECT_DIVIDER);
		if (divider === -1) {
			sawBare = true;
			patternText += pattern.slice(index, close + SELECT_CLOSE.length);
		} else {
			if (selected.indexOf(SELECT_DIVIDER, divider + SELECT_DIVIDER.length) !== -1) {
				throw new Error(`Operation ${operationNumber} selection has multiple ${SELECT_DIVIDER} delimiters.`);
			}
			sawInline = true;
			patternText += `${SELECT_OPEN}${selected.slice(0, divider)}${SELECT_CLOSE}`;
			replacements.push(selected.slice(divider + SELECT_DIVIDER.length));
		}
		index = close + SELECT_CLOSE.length;
	}

	if (sawBare && sawInline) {
		throw new Error(
			`Operation ${operationNumber} mixes inline and bare selections. Use ${SELECT_OPEN}old${SELECT_DIVIDER}new${SELECT_CLOSE} for every selection, or use a ${REWRITE_HEADER} rewrite for all bare selections.`,
		);
	}
	if (!sawInline) throw new Error(`Operation ${operationNumber} needs an inline selection.`);
	return { patternText, replacements };
}

/**
 * Embed selection-only lines into the anchor line above them. Models write
 * `anchorLine` then `⟪old│new⟫` on the next line to mean "change old inside
 * that anchor"; literally the selection would match the next occurrence
 * below instead. Relocates only when old occurs exactly once in the anchor.
 */
function relocateSelectionLines(patternText: string): string {
	const lines = patternText.split("\n");
	for (let index = 1; index < lines.length; index++) {
		const previous = lines[index - 1];
		const only = lines[index].trim().match(/^⟪([^⟪⟫]*)⟫$/u);
		if (!only || previous.includes(SELECT_OPEN) || previous.includes(GAP) || previous.trim() === "") continue;
		const oldNormalized = normalizeText(only[1]).text;
		if (oldNormalized === "") continue;
		const previousNormalized = normalizeText(previous);
		const first = previousNormalized.text.indexOf(oldNormalized);
		if (first === -1 || previousNormalized.text.indexOf(oldNormalized, first + 1) !== -1) continue;
		if (previousNormalized.text === oldNormalized) continue;
		const rawStart = previousNormalized.starts[first] ?? 0;
		const rawEnd = previousNormalized.ends[first + oldNormalized.length - 1] ?? previous.length;
		lines[index - 1] = previous.slice(0, rawStart) + lines[index].trim() + previous.slice(rawEnd);
		lines.splice(index, 1);
		index--;
	}
	return lines.join("\n");
}

/**
 * Reconcile an operation that pairs inline current/desired replacements with
 * an explicit REWRITE — formally one form too many, but usually redundant
 * rather than contradictory. When the REWRITE is empty or merely restates the
 * inline result, the current text, or the desired sides, the inline
 * replacements win and the REWRITE is dropped; otherwise the REWRITE states
 * the final text and the current sides become a plain MATCH.
 */
function recoverMixedRewriteForms(
	sourcePatternText: string,
	rewriteText: string,
	all: boolean,
	operationNumber: number,
): Operation {
	const inline = parseInlinePattern(sourcePatternText, operationNumber);
	let currentText = "";
	let desiredText = "";
	let replacementIndex = 0;
	for (let index = 0; index < inline.patternText.length; ) {
		const open = inline.patternText.indexOf(SELECT_OPEN, index);
		if (open === -1) {
			const tail = inline.patternText.slice(index);
			currentText += tail;
			desiredText += tail;
			break;
		}
		const close = inline.patternText.indexOf(SELECT_CLOSE, open + SELECT_OPEN.length);
		const between = inline.patternText.slice(index, open);
		const selected = inline.patternText.slice(open + SELECT_OPEN.length, close);
		currentText += between + selected;
		desiredText += between + (inline.replacements[replacementIndex++] ?? selected);
		index = close + SELECT_CLOSE.length;
	}
	const normalizedRewrite = normalizeText(rewriteText).text;
	const normalizedDesired = normalizeText(desiredText).text;
	const rewriteLines = rewriteText
		.split("\n")
		.map(line => normalizeText(line).text)
		.filter(line => line !== "");
	const echoesDesiredSides =
		rewriteLines.length > 0 &&
		rewriteLines.length === inline.replacements.length &&
		rewriteLines.every((line, lineIndex) => line === normalizeText(inline.replacements[lineIndex]).text);
	const rewriteIsRedundant =
		normalizedRewrite === "" ||
		normalizedRewrite === normalizedDesired ||
		normalizedRewrite === normalizeText(currentText).text ||
		normalizedDesired.includes(normalizedRewrite) ||
		echoesDesiredSides;
	const mixedForms = `Note: operation ${operationNumber} combined ${SELECT_OPEN}current${SELECT_DIVIDER}desired${SELECT_CLOSE} replacements with a ${REWRITE_HEADER} REWRITE`;
	if (rewriteIsRedundant) {
		const operation = createOperation(sourcePatternText, "", all, operationNumber, false);
		operation.recoveryNote = `${mixedForms}; the REWRITE only restated the inline result and was ignored. Use one form per operation.`;
		return operation;
	}
	const operation = createOperation(currentText, rewriteText, all, operationNumber, true);
	operation.recoveryNote = `${mixedForms}; the ${REWRITE_HEADER} REWRITE was applied as the final text for the match. Use one form per operation.`;
	return operation;
}

function patternReference(pattern: string): RegExpMatchArray | undefined {
	for (const line of pattern.split("\n")) {
		const reference = line.trim().match(/^»([1-9]\d*)$/u);
		if (reference) return reference;
	}
	return undefined;
}

function createOperation(
	sourcePatternText: string,
	rewriteText: string,
	all: boolean,
	operationNumber: number,
	hasExplicitRewrite: boolean,
): Operation {
	if (hasInlineSelection(sourcePatternText)) {
		if (hasExplicitRewrite) {
			return recoverMixedRewriteForms(sourcePatternText, rewriteText, all, operationNumber);
		}
		const inline = parseInlinePattern(sourcePatternText, operationNumber);
		// A sole `⟪│⟫` on its own line at the end of MATCH states "match becomes
		// nothing": inserting nothing is definitionally a no-op, so the only
		// consistent reading is a whole-match deletion (MATCH + empty REWRITE).
		if (inline.replacements.length === 1 && inline.replacements[0] === "") {
			const tail = inline.patternText.match(/(?:^|\n)[ \t]*⟪⟫[ \t]*$/u);
			if (tail?.index !== undefined) {
				const remainder = inline.patternText.slice(0, tail.index);
				if (normalizeText(remainder).text !== "") {
					return {
						patternText: remainder,
						sourcePatternText,
						rewrite: { kind: "explicit", text: "" },
						all,
					};
				}
			}
		}
		const reference = patternReference(inline.patternText);
		if (reference) {
			throw new Error(
				`${REWRITE_HEADER}${reference[1]} is valid only inside an inline replacement or REWRITE, never MATCH.`,
			);
		}
		return {
			patternText: relocateSelectionLines(inline.patternText),
			sourcePatternText,
			rewrite: { kind: "inline", replacements: inline.replacements },
			all,
		};
	}

	const reference = patternReference(sourcePatternText);
	if (reference) {
		throw new Error(`${REWRITE_HEADER}${reference[1]} is valid only in REWRITE, never MATCH.`);
	}
	return {
		patternText: sourcePatternText,
		sourcePatternText,
		rewrite: { kind: "explicit", text: rewriteText },
		all,
	};
}

function parseOperations(input: string, content: string): Operation[] {
	const payload = normalizeInput(input);
	let lines = payload.split("\n");
	if (
		parseOpener(lines[0] ?? "") === false &&
		(lines.some(line => line.trim() === REWRITE_HEADER) ||
			payload.includes(SELECT_OPEN) ||
			payload.includes(SELECT_CLOSE))
	) {
		lines.unshift(OPENER);
	}
	lines = recoverAlternatingSeparators(lines, content) ?? lines;
	const operations: Operation[] = [];
	let state: "outside" | "pattern" | "rewrite" = "outside";
	let allMatches = false;
	let patternLines: string[] = [];
	let rewriteLines: string[] = [];
	let referenceSeparator: string | undefined;

	const finish = () => {
		const sourcePatternText = normalizeBlock(patternLines, false);
		const rewriteText = normalizeBlock(rewriteLines, true);
		if (referenceSeparator !== undefined && rewriteText.trim() === "") {
			// A trailing »N produced no rewrite: noise after an inline operation;
			// after a legacy MATCH the final text is missing — hand back a
			// fill-in skeleton instead of echoing the broken payload.
			if (!hasInlineSelection(sourcePatternText)) {
				throw new Error(
					`${referenceSeparator} after MATCH reads as the ${REWRITE_HEADER} separator, leaving REWRITE empty.\nCopy-ready corrected payload (fill in the final text):\n${OPENER}${allMatches ? "*" : ""}\n${sourcePatternText}\n${REWRITE_HEADER}\n<final text>`,
				);
			}
			operations.push(createOperation(sourcePatternText, "", allMatches, operations.length + 1, false));
			return;
		}
		operations.push(createOperation(sourcePatternText, rewriteText, allMatches, operations.length + 1, true));
	};
	const pendingSeparatorErrors = new Map<number, string>();
	const finishPattern = () => {
		const sourcePatternText = normalizeBlock(patternLines, false);
		if (hasInlineSelection(sourcePatternText)) {
			operations.push(createOperation(sourcePatternText, "", allMatches, operations.length + 1, false));
			return;
		}
		const recovered = recoverMissingSeparator(patternLines, content);
		if (recovered) {
			operations.push(
				createOperation(recovered.patternText, recovered.rewrite, allMatches, operations.length + 1, true),
			);
			return;
		}
		const needsSeparator = `Operation ${operations.length + 1} needs ${REWRITE_HEADER}. Retry:\n${OPENER}\n${patternLines.join("\n")}\n${REWRITE_HEADER}\n<new text>`;
		// A multiline pattern-only block may be the delete half of a move; assume
		// deletion now, justified post-parse only when another op re-emits it.
		const normalizedPattern = normalizeText(sourcePatternText).text;
		if (!sourcePatternText.includes("\n") || normalizedPattern.length < 24) {
			throw new Error(needsSeparator);
		}
		const operation = createOperation(sourcePatternText, "", allMatches, operations.length + 1, true);
		operation.assumedDeletion = true;
		pendingSeparatorErrors.set(operations.length, needsSeparator);
		operations.push(operation);
	};

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const parsedOpener = parseOpener(line);
		const trimmed = line.trim();
		const registerReference = trimmed.match(/^»([1-9]\d*)$/u);
		if (isOrdinalOpener(line)) {
			throw new Error(
				`${trimmed} is not a valid opener. Use ${OPENER} with a pattern that matches once — add context only the intended match has — or ${OPENER}* to change every match.`,
			);
		}
		if (
			parsedOpener === false &&
			(trimmed.startsWith(OPENER) ||
				(trimmed.startsWith(REWRITE_HEADER) && trimmed !== REWRITE_HEADER && !registerReference))
		) {
			throw new Error(
				`Invalid control line ${JSON.stringify(trimmed)}; use only ${OPENER}, ${OPENER}*, ${REWRITE_HEADER}, or ${REWRITE_HEADER}N in REWRITE.`,
			);
		}
		if (state === "outside") {
			if (parsedOpener !== false) {
				allMatches = parsedOpener === 0;
				patternLines = [];
				rewriteLines = [];
				referenceSeparator = undefined;
				state = "pattern";
			} else if (trimmed !== "") {
				throw new Error(`Expected ${OPENER} on input line ${index + 1}.`);
			}
			continue;
		}

		if (state === "pattern") {
			const accumulated = patternLines.join("\n");
			const markersBalanced = (accumulated.match(/⟪/gu) || []).length === (accumulated.match(/⟫/gu) || []).length;
			if (trimmed === REWRITE_HEADER) {
				state = "rewrite";
			} else if (trimmed === SELECT_CLOSE && markersBalanced && patternLines.some(entry => entry.trim() !== "")) {
				// A lone ⟫ after balanced selections is a mistyped » separator.
				state = "rewrite";
			} else if (registerReference && markersBalanced) {
				if (!patternLines.some(entry => entry.trim() !== "")) {
					throw new Error(`${trimmed} is valid only in REWRITE, never MATCH.`);
				}
				// A lone »N after MATCH is always a mistyped » separator (observed
				// model idiolect); a genuine re-emit is authored as » then »N.
				state = "rewrite";
				referenceSeparator = trimmed;
			} else if (parsedOpener !== false) {
				finishPattern();
				allMatches = parsedOpener === 0;
				patternLines = [];
				rewriteLines = [];
				referenceSeparator = undefined;
			} else {
				patternLines.push(line);
			}
			continue;
		}

		if (parsedOpener !== false) {
			finish();
			allMatches = parsedOpener === 0;
			patternLines = [];
			rewriteLines = [];
			referenceSeparator = undefined;
			state = "pattern";
		} else if (trimmed === REWRITE_HEADER) {
			throw new Error(`Operation ${operations.length + 1} has a second ${REWRITE_HEADER} line.`);
		} else if (
			trimmed === SELECT_CLOSE &&
			(rewriteLines.join("\n").match(/⟪/gu) || []).length === (rewriteLines.join("\n").match(/⟫/gu) || []).length
		) {
			// A lone ⟫ with no open selection is a stray block terminator; REWRITE
			// is final text and never carries selection markers.
		} else {
			rewriteLines.push(line);
		}
	}

	if (state === "rewrite") finish();
	else if (state === "pattern") finishPattern();
	if (operations.length === 0) throw new Error(`Empty patch. Start with ${OPENER}.`);
	for (let index = 0; index < operations.length; index++) {
		const operationRewrite = operations[index].rewrite;
		const rewrites = operationRewrite.kind === "explicit" ? [operationRewrite.text] : operationRewrite.replacements;
		for (const rewrite of rewrites) {
			for (const line of rewrite.split("\n")) {
				const reference = line.trim().match(/^»([1-9]\d*)$/u);
				if (reference && Number(reference[1]) >= index + 1) {
					throw new Error(
						`${REWRITE_HEADER}${reference[1]} must reference an earlier operation, not self/forward.`,
					);
				}
			}
		}
	}
	for (const [index, message] of pendingSeparatorErrors) {
		const patternNormalized = normalizeText(operations[index].patternText).text;
		const justified = operations.some((other, otherIndex) => {
			if (otherIndex === index) return false;
			const rewrites = other.rewrite.kind === "explicit" ? [other.rewrite.text] : other.rewrite.replacements;
			return rewrites.some(
				rewrite =>
					normalizeText(rewrite).text.includes(patternNormalized) ||
					rewrite.split("\n").some(line => line.trim() === `${REWRITE_HEADER}${index + 1}`),
			);
		});
		if (!justified) throw new Error(message);
	}
	return operations;
}

function normalizeText(source: string): NormalizedText {
	let text = "";
	const starts: number[] = [];
	const ends: number[] = [];
	for (let index = 0; index < source.length; ) {
		const codePoint = source.codePointAt(index);
		if (codePoint === undefined) break;
		const raw = String.fromCodePoint(codePoint);
		const next = index + raw.length;
		for (const character of normalizeUnicode(raw)) {
			if (/\s/u.test(character)) continue;
			text += character;
			// One entry per UTF-16 code unit: occurrence offsets index `text` by
			// code unit, so astral characters must occupy two mapping slots.
			for (let unit = 0; unit < character.length; unit++) {
				starts.push(index);
				ends.push(next);
			}
		}
		index = next;
	}
	return { text, starts, ends };
}

function patternGapAt(source: string, offset: number): string | undefined {
	return source.startsWith(GAP, offset) ? GAP : undefined;
}

function patternContainsGap(source: string): boolean {
	for (let index = 0; index < source.length; ) {
		const marker = patternGapAt(source, index);
		if (marker) return true;
		const codePoint = source.codePointAt(index);
		if (codePoint === undefined) break;
		index += String.fromCodePoint(codePoint).length;
	}
	return false;
}

function parsePattern(pattern: string, operationNumber: number): ParsedPattern {
	if (pattern.trim() === "") throw new Error(`Operation ${operationNumber} has an empty pattern.`);
	validateSelectionMarkers(pattern, operationNumber);
	const hasGap = patternContainsGap(pattern);
	const hasSelection = pattern.includes(SELECT_OPEN);
	if (!hasGap && !hasSelection) {
		const normalized = normalizeText(pattern).text;
		if (normalized === "") throw new Error(`Operation ${operationNumber} has no visible current text.`);
		return {
			tokens: [{ kind: "literal", text: pattern, normalized }],
			selectionStart: 0,
			selectionEnd: 1,
			insertion: false,
			lineInsertion: false,
			selectedCaptureIndices: [],
			selectionRanges: [],
			selectionPairs: [],
			literalFallback: undefined,
		};
	}

	const tokens: PatternToken[] = [];
	let literal = "";
	let captureCount = 0;
	const selectionBoundaries: number[] = [];
	const selectionAtLineStart: boolean[] = [];
	const selectionRawOffsets: number[] = [];
	const flushLiteral = () => {
		if (literal === "") return;
		const normalized = normalizeText(literal).text;
		if (normalized !== "") tokens.push({ kind: "literal", text: literal, normalized });
		literal = "";
	};

	for (let index = 0; index < pattern.length; ) {
		const gapMarker = patternGapAt(pattern, index);
		if (gapMarker) {
			flushLiteral();
			if (tokens.at(-1)?.kind === "gap") {
				throw new Error(`Operation ${operationNumber} has adjacent ${GAP}; use one ellipsis.`);
			}
			const lineStart = pattern.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
			const nextNewline = pattern.indexOf("\n", index + gapMarker.length);
			const lineEnd = nextNewline === -1 ? pattern.length : nextNewline;
			const before = pattern.slice(lineStart, index).replaceAll(SELECT_OPEN, "").replaceAll(SELECT_CLOSE, "").trim();
			const after = pattern
				.slice(index + gapMarker.length, lineEnd)
				.replaceAll(SELECT_OPEN, "")
				.replaceAll(SELECT_CLOSE, "")
				.trim();
			tokens.push({
				kind: "gap",
				captureIndex: captureCount++,
				lineBounded: before !== "" && after !== "",
			});
			index += gapMarker.length;
			continue;
		}
		const codePoint = pattern.codePointAt(index);
		if (codePoint === undefined) break;
		const character = String.fromCodePoint(codePoint);
		if (character === SELECT_OPEN) {
			flushLiteral();
			selectionBoundaries.push(tokens.length);
			selectionRawOffsets.push(index);
			const lineStart = pattern.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
			selectionAtLineStart.push(pattern.slice(lineStart, index).trim() === "");
		} else if (character === SELECT_CLOSE) {
			flushLiteral();
			selectionBoundaries.push(tokens.length);
			selectionRawOffsets.push(index);
		} else {
			literal += character;
		}
		index += character.length;
	}
	flushLiteral();

	let strippedLeading = 0;
	while (tokens[0]?.kind === "gap") {
		tokens.shift();
		strippedLeading++;
	}
	while (tokens.at(-1)?.kind === "gap") tokens.pop();
	for (let index = 0; index < selectionBoundaries.length; index++) {
		selectionBoundaries[index] = Math.max(0, Math.min(tokens.length, selectionBoundaries[index] - strippedLeading));
	}
	const literals = tokens.filter((token): token is LiteralToken => token.kind === "literal");
	if (literals.length === 0) throw new Error(`Operation ${operationNumber} needs visible current text.`);
	// Only punctuation-only anchors (`}`, `};`, `);`) are genuinely too generic:
	// they match everywhere and their candidate lists are noise. Any identifier
	// text — however short (`id`, `avlue`) — is a legitimate anchor; uniqueness
	// (or an explicit `«*`) decides whether it applies, not its length.
	const hasIdentifierText = literals.some(token => /[\p{L}\p{N}_$]/u.test(token.normalized));
	if (!hasIdentifierText) {
		throw new Error(`Operation ${operationNumber} pattern is too generic; include a distinctive name or statement.`);
	}

	const emptyDoubleSelection = selectionBoundaries.length === 2 && selectionBoundaries[0] === selectionBoundaries[1];
	const insertion = selectionBoundaries.length === 1 || emptyDoubleSelection;
	const explicitSingleSelection = selectionBoundaries.length === 2 && !emptyDoubleSelection;
	const selectionStart = insertion || explicitSingleSelection ? selectionBoundaries[0] : 0;
	const selectionEnd = insertion ? selectionStart : explicitSingleSelection ? selectionBoundaries[1] : tokens.length;
	const selectionPairs =
		selectionBoundaries.length > 0 && selectionBoundaries.length % 2 === 0
			? Array.from({ length: selectionBoundaries.length / 2 }, (_, index) => {
					const start = selectionBoundaries[index * 2];
					const end = selectionBoundaries[index * 2 + 1];
					return {
						start,
						end,
						captureIndices: tokens
							.slice(start, end)
							.filter((token): token is GapToken => token.kind === "gap")
							.map(token => token.captureIndex),
						lineInsertion: start === end && (selectionAtLineStart[index] ?? false),
					};
				})
			: [];
	const selectionRanges = selectionPairs.length > 1 ? selectionPairs.map(({ start, end }) => ({ start, end })) : [];
	const selectedCaptureIndices = tokens
		.slice(selectionStart, selectionEnd)
		.filter((token): token is GapToken => token.kind === "gap")
		.map(token => token.captureIndex);
	const literalFallbackText =
		selectionRanges.length === 0 && pattern.includes(GAP)
			? pattern.replaceAll(SELECT_OPEN, "").replaceAll(SELECT_CLOSE, "")
			: undefined;
	let literalFallback: LiteralFallback | undefined;
	if (literalFallbackText !== undefined) {
		const normalized = normalizeText(literalFallbackText).text;
		const normalizedOffset = (rawOffset: number) =>
			normalizeText(pattern.slice(0, rawOffset).replaceAll(SELECT_OPEN, "").replaceAll(SELECT_CLOSE, "")).text
				.length;
		literalFallback = {
			normalized,
			selectionStart: insertion || explicitSingleSelection ? normalizedOffset(selectionRawOffsets[0]) : 0,
			selectionEnd: insertion
				? normalizedOffset(selectionRawOffsets[0])
				: explicitSingleSelection
					? normalizedOffset(selectionRawOffsets[1])
					: normalized.length,
			insertion,
		};
	}
	return {
		tokens,
		selectionStart,
		selectionEnd,
		insertion,
		lineInsertion: insertion && selectionAtLineStart[0],
		selectedCaptureIndices,
		selectionRanges,
		selectionPairs,
		literalFallback,
	};
}

function exactOccurrences(content: string, pattern: string): Occurrence[] {
	const occurrences: Occurrence[] = [];
	let from = 0;
	while (from <= content.length - pattern.length) {
		const start = content.indexOf(pattern, from);
		if (start === -1) break;
		occurrences.push({ start, end: start + pattern.length, distance: 0, punctuationEdits: 0 });
		from = start + 1;
	}
	return occurrences;
}

function operatorSignature(text: string): string {
	return [...text].filter(character => !/[\p{L}\p{N}_$]/u.test(character)).join("");
}

function differsByOnePunctuationInsertion(left: string, right: string): boolean {
	const leftCharacters = [...left];
	const rightCharacters = [...right];
	if (Math.abs(leftCharacters.length - rightCharacters.length) !== 1) return false;
	const shorter = leftCharacters.length < rightCharacters.length ? leftCharacters : rightCharacters;
	const longer = leftCharacters.length < rightCharacters.length ? rightCharacters : leftCharacters;
	let shortIndex = 0;
	let inserted: string | undefined;
	for (let longIndex = 0; longIndex < longer.length; longIndex++) {
		if (shorter[shortIndex] === longer[longIndex]) {
			shortIndex++;
			continue;
		}
		if (inserted !== undefined) return false;
		inserted = longer[longIndex];
	}
	inserted ??= longer.at(-1);
	return inserted !== undefined && !/[{}()[\]]/u.test(inserted);
}

function punctuationCompatible(pattern: string, candidate: string, allowSingleInsertion: boolean): boolean {
	const expected = operatorSignature(pattern);
	const actual = operatorSignature(candidate);
	return expected === actual || (allowSingleInsertion && differsByOnePunctuationInsertion(expected, actual));
}

function fuzzyOccurrences(content: string, pattern: string, allowSinglePunctuationInsertion = false): Occurrence[] {
	if (content.length === 0 || content.length > 50_000) return [];
	if (pattern.length < 6) return exactOccurrences(content, pattern);
	const limit = Math.min(3, Math.max(1, Math.floor(pattern.length * 0.12)));
	const seedLength = Math.min(5, Math.max(3, pattern.length - limit));
	const offsets = [0, Math.floor((pattern.length - seedLength) / 2), pattern.length - seedLength];
	const structural = operatorSignature(pattern);
	const candidateStarts = new Set<number>();
	for (const offset of offsets) {
		const seed = pattern.slice(offset, offset + seedLength);
		let from = 0;
		while (from <= content.length - seed.length) {
			const found = content.indexOf(seed, from);
			if (found === -1) break;
			for (let delta = -limit; delta <= limit; delta++) {
				const start = found - offset + delta;
				if (start >= 0 && start < content.length) candidateStarts.add(start);
			}
			from = found + 1;
		}
	}
	if (candidateStarts.size === 0 && content.length <= 10_000) {
		for (let start = 0; start < content.length; start++) candidateStarts.add(start);
	}

	const raw: Occurrence[] = [];
	for (const start of candidateStarts) {
		let best: Occurrence | undefined;
		for (let length = Math.max(1, pattern.length - limit); length <= pattern.length + limit; length++) {
			if (start + length > content.length) continue;
			const candidateText = content.slice(start, start + length);
			if (
				operatorSignature(candidateText) !== structural &&
				(!allowSinglePunctuationInsertion || !punctuationCompatible(pattern, candidateText, true))
			) {
				continue;
			}
			const distance = levenshteinDistance(pattern, candidateText);
			if (distance > limit || (best && distance >= best.distance)) continue;
			best = {
				start,
				end: start + length,
				distance,
				punctuationEdits: operatorSignature(candidateText) === structural ? 0 : 1,
			};
		}
		if (best) raw.push(best);
	}
	raw.sort((left, right) => left.distance - right.distance || left.start - right.start);
	const distinct: Occurrence[] = [];
	for (const candidate of raw) {
		if (distinct.some(kept => candidate.start < kept.end && candidate.end > kept.start)) continue;
		distinct.push(candidate);
	}
	return distinct.sort((left, right) => left.start - right.start);
}

function sourceStart(normalized: NormalizedText, offset: number, fallback: number): number {
	return normalized.starts[offset] ?? fallback;
}

function sourceEnd(normalized: NormalizedText, offset: number, fallback: number): number {
	if (offset <= 0) return 0;
	return normalized.ends[offset - 1] ?? fallback;
}

function precedingLiteral(tokens: PatternToken[], boundary: number): number | undefined {
	for (let index = boundary - 1; index >= 0; index--) if (tokens[index].kind === "literal") return index;
	return undefined;
}

function followingLiteral(tokens: PatternToken[], boundary: number): number | undefined {
	for (let index = boundary; index < tokens.length; index++) if (tokens[index].kind === "literal") return index;
	return undefined;
}

function resolveBoundary(
	boundary: number,
	kind: "start" | "end" | "empty",
	tokens: PatternToken[],
	matches: ReadonlyMap<number, Occurrence>,
	normalized: NormalizedText,
): number {
	const previousIndex = precedingLiteral(tokens, boundary);
	const nextIndex = followingLiteral(tokens, boundary);
	const previous = previousIndex === undefined ? undefined : matches.get(previousIndex);
	const next = nextIndex === undefined ? undefined : matches.get(nextIndex);
	const immediatePrevious = boundary > 0 && tokens[boundary - 1]?.kind === "literal";
	const immediateNext = boundary < tokens.length && tokens[boundary]?.kind === "literal";
	if (kind === "empty") {
		if (next) return sourceStart(normalized, next.start, normalized.text.length);
		if (previous) return sourceEnd(normalized, previous.end, normalized.text.length);
	}
	if (kind === "start") {
		if (immediateNext && next) return sourceStart(normalized, next.start, normalized.text.length);
		if (previous) return sourceEnd(normalized, previous.end, normalized.text.length);
		if (next) return sourceStart(normalized, next.start, normalized.text.length);
	}
	if (immediatePrevious && previous) return sourceEnd(normalized, previous.end, normalized.text.length);
	if (next) return sourceStart(normalized, next.start, normalized.text.length);
	if (previous) return sourceEnd(normalized, previous.end, normalized.text.length);
	return 0;
}

function collectCandidates(
	content: string,
	normalized: NormalizedText,
	pattern: ParsedPattern,
	fuzzy: boolean,
	allowSinglePunctuationInsertion = false,
): CandidateResult {
	const literalIndices = pattern.tokens.flatMap((token, index) => (token.kind === "literal" ? [index] : []));
	const occurrences = new Map<number, Occurrence[]>();
	for (const index of literalIndices) {
		const token = pattern.tokens[index] as LiteralToken;
		occurrences.set(
			index,
			fuzzy
				? fuzzyOccurrences(normalized.text, token.normalized, allowSinglePunctuationInsertion)
				: exactOccurrences(normalized.text, token.normalized),
		);
	}
	if (literalIndices.some(index => occurrences.get(index)?.length === 0)) return { candidates: [], overflow: false };

	const candidates: Candidate[] = [];
	const chosen = new Map<number, Occurrence>();
	let combinations = 0;
	let overflow = false;
	const visit = (position: number) => {
		if (overflow) return;
		if (candidates.length >= MAX_CANDIDATES || combinations >= MAX_COMBINATIONS) {
			overflow = true;
			return;
		}
		if (position === literalIndices.length) {
			if (
				allowSinglePunctuationInsertion &&
				literalIndices.reduce((total, index) => total + (chosen.get(index)?.punctuationEdits ?? 0), 0) > 1
			) {
				return;
			}
			combinations++;
			const start = resolveBoundary(
				pattern.selectionStart,
				pattern.insertion ? "empty" : "start",
				pattern.tokens,
				chosen,
				normalized,
			);
			const end = resolveBoundary(
				pattern.selectionEnd,
				pattern.insertion ? "empty" : "end",
				pattern.tokens,
				chosen,
				normalized,
			);
			const first = chosen.get(literalIndices[0]);
			const last = chosen.get(literalIndices.at(-1) ?? -1);
			if (start > end || !first || !last) return;
			const captures = new Array<string>(pattern.tokens.filter(token => token.kind === "gap").length).fill("");
			for (let tokenIndex = 0; tokenIndex < pattern.tokens.length; tokenIndex++) {
				const token = pattern.tokens[tokenIndex];
				if (token.kind !== "gap") continue;
				const beforeIndex = precedingLiteral(pattern.tokens, tokenIndex);
				const afterIndex = followingLiteral(pattern.tokens, tokenIndex + 1);
				const before = beforeIndex === undefined ? undefined : chosen.get(beforeIndex);
				const after = afterIndex === undefined ? undefined : chosen.get(afterIndex);
				if (!before || !after) return;
				const captureStart = sourceEnd(normalized, before.end, content.length);
				const captureEnd = sourceStart(normalized, after.start, content.length);
				captures[token.captureIndex] = content.slice(captureStart, captureEnd);
			}
			const selectionSpans = pattern.selectionPairs.map(range => {
				const empty = range.start === range.end;
				return {
					start: resolveBoundary(range.start, empty ? "empty" : "start", pattern.tokens, chosen, normalized),
					end: resolveBoundary(range.end, empty ? "empty" : "end", pattern.tokens, chosen, normalized),
				};
			});
			if (selectionSpans.some(span => span.start > span.end)) return;
			const candidate: Candidate = {
				start,
				end,
				matchStart: sourceStart(normalized, first.start, 0),
				matchEnd: sourceEnd(normalized, last.end, content.length),
				captures,
				tuple: literalIndices.map(index => chosen.get(index)?.start ?? -1),
				selectionSpans,
			};
			const duplicateIndex = candidates.findIndex(
				existing =>
					existing.start === start &&
					existing.end === end &&
					pattern.selectedCaptureIndices.every(
						captureIndex => existing.captures[captureIndex] === captures[captureIndex],
					),
			);
			if (duplicateIndex === -1) {
				candidates.push(candidate);
			} else {
				const existing = candidates[duplicateIndex];
				if (candidate.matchEnd - candidate.matchStart < existing.matchEnd - existing.matchStart) {
					candidates[duplicateIndex] = candidate;
				}
			}
			return;
		}

		const tokenIndex = literalIndices[position];
		const previousIndex = position === 0 ? undefined : literalIndices[position - 1];
		const previous = previousIndex === undefined ? undefined : chosen.get(previousIndex);
		const gapTokens =
			previousIndex === undefined
				? []
				: pattern.tokens
						.slice(previousIndex + 1, tokenIndex)
						.filter((token): token is GapToken => token.kind === "gap");
		const hasGap = gapTokens.length > 0;
		for (const occurrence of occurrences.get(tokenIndex) ?? []) {
			if (previous && (hasGap ? occurrence.start < previous.end : occurrence.start !== previous.end)) continue;
			if (previous && gapTokens.some(token => token.lineBounded)) {
				const gapStart = sourceEnd(normalized, previous.end, content.length);
				const gapEnd = sourceStart(normalized, occurrence.start, content.length);
				if (content.slice(gapStart, gapEnd).includes("\n")) continue;
			}
			chosen.set(tokenIndex, occurrence);
			visit(position + 1);
			chosen.delete(tokenIndex);
		}
	};
	visit(0);
	const minimalCandidates = candidates.filter(
		candidate =>
			!candidates.some(other => other.matchStart === candidate.matchStart && other.matchEnd < candidate.matchEnd),
	);
	minimalCandidates.sort(
		(left, right) =>
			left.start - right.start ||
			left.matchStart - right.matchStart ||
			left.matchEnd - right.matchEnd ||
			left.tuple.join(",").localeCompare(right.tuple.join(",")),
	);
	return { candidates: minimalCandidates, overflow };
}

function lineNumberAt(content: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset; index++) if (content[index] === "\n") line++;
	return line;
}

function renderInlinePattern(patternText: string, replacements: string[]): string {
	let rendered = "";
	let replacementIndex = 0;
	for (let index = 0; index < patternText.length; ) {
		const codePoint = patternText.codePointAt(index);
		if (codePoint === undefined) break;
		const character = String.fromCodePoint(codePoint);
		if (character !== SELECT_OPEN) {
			rendered += character;
			index += character.length;
			continue;
		}
		const close = patternText.indexOf(SELECT_CLOSE, index + character.length);
		rendered += `${patternText.slice(index, close)}${SELECT_DIVIDER}${replacements[replacementIndex] ?? ""}${SELECT_CLOSE}`;
		replacementIndex++;
		index = close + SELECT_CLOSE.length;
	}
	return rendered;
}

function operationPattern(operation: Operation, patternText = operation.patternText): string {
	if (operation.rewrite.kind !== "inline") return patternText;
	return patternText === operation.patternText
		? operation.sourcePatternText
		: renderInlinePattern(patternText, operation.rewrite.replacements);
}

function operationPayload(operation: Operation, target: "*" | "" = "", patternText?: string): string {
	const header = `${OPENER}${target}`;
	const pattern = operationPattern(operation, patternText);
	return operation.rewrite.kind === "inline"
		? `${header}\n${pattern}`
		: `${header}\n${pattern}\n${REWRITE_HEADER}\n${operation.rewrite.text}`;
}

function exactAndFuzzyCandidates(content: string, pattern: ParsedPattern): CandidateResult {
	const normalized = normalizeText(content);
	const exact = collectCandidates(content, normalized, pattern, false);
	const fuzzy = collectCandidates(content, normalized, pattern, true);
	const candidates = [...exact.candidates];
	for (const candidate of fuzzy.candidates) {
		if (
			candidates.some(
				existing =>
					existing.start === candidate.start &&
					existing.end === candidate.end &&
					existing.matchStart === candidate.matchStart &&
					existing.matchEnd === candidate.matchEnd,
			)
		) {
			continue;
		}
		candidates.push(candidate);
	}
	candidates.sort(
		(left, right) =>
			left.start - right.start ||
			left.end - right.end ||
			left.matchStart - right.matchStart ||
			left.matchEnd - right.matchEnd,
	);
	return { candidates, overflow: exact.overflow || fuzzy.overflow };
}

function displayFragment(text: string): string {
	if (text.includes("\n") && text.split("\n").length <= 8) return `\n${text}`;
	const compact = text.trim().replace(/\s+/gu, " ");
	return JSON.stringify(compact.length > 80 ? `${compact.slice(0, 77)}…` : compact);
}

function occurrencesForLiteral(normalized: NormalizedText, token: LiteralToken): Occurrence[] {
	const exact = exactOccurrences(normalized.text, token.normalized);
	return exact.length > 0 ? exact : fuzzyOccurrences(normalized.text, token.normalized);
}

function pairCanAlign(
	content: string,
	normalized: NormalizedText,
	pattern: ParsedPattern,
	leftIndex: number,
	rightIndex: number,
	leftOccurrences: Occurrence[],
	rightOccurrences: Occurrence[],
): boolean {
	const gaps = pattern.tokens
		.slice(leftIndex + 1, rightIndex)
		.filter((token): token is GapToken => token.kind === "gap");
	return leftOccurrences.some(left =>
		rightOccurrences.some(right => {
			if (gaps.length === 0 && right.start !== left.end) return false;
			if (gaps.length > 0 && right.start < left.end) return false;
			if (gaps.some(gap => gap.lineBounded)) {
				const gapStart = sourceEnd(normalized, left.end, content.length);
				const gapEnd = sourceStart(normalized, right.start, content.length);
				if (content.slice(gapStart, gapEnd).includes("\n")) return false;
			}
			return true;
		}),
	);
}
function closestFragment(
	content: string,
	token: LiteralToken,
	centerOffset?: number,
): { text: string; offset: number } {
	const ranked: Array<{ line: string; offset: number; normalized: NormalizedText; score: number }> = [];
	const centerLine = centerOffset === undefined ? undefined : lineNumberAt(content, centerOffset) - 1;
	let offset = 0;
	let lineIndex = 0;
	for (const line of content.split("\n")) {
		const normalized = normalizeText(line);
		if (normalized.text !== "" && (centerLine === undefined || Math.abs(lineIndex - centerLine) <= 12)) {
			const score =
				levenshteinDistance(token.normalized, normalized.text) /
				Math.max(1, token.normalized.length, normalized.text.length);
			ranked.push({ line, offset, normalized, score });
			ranked.sort((left, right) => left.score - right.score);
			if (ranked.length > 3) ranked.pop();
		}
		lineIndex++;
		offset += line.length + 1;
	}
	const first = ranked[0];
	if (!first && centerOffset !== undefined) return closestFragment(content, token);
	if (!first) return { text: token.text, offset: 0 };

	let best = { text: first.line, offset: first.offset, score: first.score };
	if (token.normalized.length <= 160) {
		for (const candidateLine of ranked) {
			const lineText = candidateLine.normalized.text;
			const width = Math.min(token.normalized.length, lineText.length);
			for (let start = 0; start <= lineText.length - width; start++) {
				const end = start + width;
				const candidate = lineText.slice(start, end);
				const score =
					levenshteinDistance(token.normalized, candidate) /
					Math.max(1, token.normalized.length, candidate.length);
				if (score >= best.score) continue;
				const rawStart = sourceStart(candidateLine.normalized, start, 0);
				const rawEnd = sourceEnd(candidateLine.normalized, end, candidateLine.line.length);
				best = {
					text: candidateLine.line.slice(rawStart, rawEnd),
					offset: candidateLine.offset + rawStart,
					score,
				};
			}
		}
	}
	return { text: best.text, offset: best.offset };
}

function numberedPreview(content: string, offset: number): string {
	const lines = content.split("\n");
	const anchor = Math.max(0, lineNumberAt(content, Math.min(offset, content.length)) - 1);
	let start = Math.max(0, anchor - 4);
	if (lines.length - start < 10) start = Math.max(0, lines.length - 10);
	return lines
		.slice(start, start + 10)
		.map((line, index) => `${start + index + 1}: ${line}`)
		.join("\n");
}

function noMatchGuidance(
	content: string,
	normalized: NormalizedText,
	pattern: ParsedPattern,
	operation: Operation,
): { reason: string; previewOffset: number; correctedPattern: string; additionRetry?: string } {
	const literals = pattern.tokens.flatMap((token, index) =>
		token.kind === "literal" ? [{ index, token, occurrences: occurrencesForLiteral(normalized, token) }] : [],
	);
	const missing = literals.find(literal => literal.occurrences.length === 0);
	if (missing) {
		const anchor = literals
			.filter(literal => literal.occurrences.length > 0)
			.sort(
				(left, right) =>
					right.token.normalized.length - left.token.normalized.length ||
					left.occurrences.length - right.occurrences.length,
			)[0];
		const anchorOffset = anchor?.occurrences[0] ? sourceStart(normalized, anchor.occurrences[0].start, 0) : undefined;
		const closest = closestFragment(content, missing.token, anchorOffset);
		const at = operation.patternText.indexOf(missing.token.text);
		const correctedPattern =
			at >= 0 && closest.text !== ""
				? operation.patternText.slice(0, at) +
					closest.text +
					operation.patternText.slice(at + missing.token.text.length)
				: operation.patternText;
		const lineStart = content.lastIndexOf("\n", Math.max(0, closest.offset - 1)) + 1;
		const newline = content.indexOf("\n", closest.offset);
		const neighborLine = content.slice(lineStart, newline === -1 ? content.length : newline);
		const explicitRewrite = operation.rewrite.kind === "explicit" ? operation.rewrite.text : undefined;
		const looksLikeAddition =
			explicitRewrite !== undefined &&
			!normalized.text.includes(missing.token.normalized) &&
			(explicitRewrite === "" || explicitRewrite.includes(missing.token.text));
		const additionText = explicitRewrite === "" ? missing.token.text : explicitRewrite;
		return {
			reason:
				`Failed fragment: ${displayFragment(missing.token.text)} has 0 occurrences.` +
				(anchor ? ` It broke relative to matched anchor ${displayFragment(anchor.token.text)}.` : ""),
			previewOffset: anchorOffset ?? closest.offset,
			correctedPattern,
			additionRetry:
				looksLikeAddition && additionText !== undefined && neighborLine.trim() !== ""
					? `If you are ADDING this text: match the existing neighbor line it belongs next to, and put the new text in the REWRITE —\n${OPENER}\n${SELECT_OPEN}${SELECT_CLOSE}${neighborLine}\n${REWRITE_HEADER}\n${additionText}`
					: undefined,
		};
	}

	let broken:
		| {
				left: (typeof literals)[number];
				right: (typeof literals)[number];
		  }
		| undefined;
	let reachable = literals[0]?.occurrences ?? [];
	for (let index = 1; index < literals.length; index++) {
		const left = literals[index - 1];
		const right = literals[index];
		const nextReachable = right.occurrences.filter(rightOccurrence =>
			pairCanAlign(content, normalized, pattern, left.index, right.index, reachable, [rightOccurrence]),
		);
		if (nextReachable.length === 0) {
			broken = { left, right };
			break;
		}
		reachable = nextReachable;
	}
	broken ??= literals.length >= 2 ? { left: literals.at(-2)!, right: literals.at(-1)! } : undefined;
	if (!broken) {
		const only = literals[0];
		return {
			reason: `Failed fragment: ${displayFragment(only?.token.text ?? operation.patternText)} could not align.`,
			previewOffset: only?.occurrences[0] ? sourceStart(normalized, only.occurrences[0].start, 0) : 0,
			correctedPattern: operation.patternText,
		};
	}

	const between = pattern.tokens.slice(broken.left.index + 1, broken.right.index);
	const rightAt = operation.patternText.indexOf(
		broken.right.token.text,
		operation.patternText.indexOf(broken.left.token.text) + broken.left.token.text.length,
	);
	const correctedPattern =
		between.some(token => token.kind === "gap") || rightAt < 0
			? operation.patternText
			: `${operation.patternText.slice(0, rightAt)}${GAP}${operation.patternText.slice(rightAt)}`;
	return {
		reason: `Ordered pair broke: ${displayFragment(broken.left.token.text)} did not precede ${displayFragment(broken.right.token.text)} as written.`,

		previewOffset: sourceStart(normalized, broken.left.occurrences[0]?.start ?? 0, 0),
		correctedPattern,
	};
}
function nonConsecutiveGuidance(
	content: string,
	operation: Operation,
): { locations: number[]; correctedPattern: string; previewOffset: number } | undefined {
	if (
		operation.patternText.includes(SELECT_OPEN) ||
		operation.patternText.includes(SELECT_CLOSE) ||
		operation.patternText.includes(GAP)
	) {
		return undefined;
	}
	const authoredLines = operation.patternText.split("\n").filter(line => line.trim() !== "");
	if (authoredLines.length < 2) return undefined;
	const fileLines = content.split("\n");
	const locations: number[] = [];
	let from = 0;
	for (const authoredLine of authoredLines) {
		const normalizedAuthored = normalizeText(authoredLine).text;
		let found = -1;
		for (let index = from; index < fileLines.length; index++) {
			if (normalizeText(fileLines[index]).text === normalizedAuthored) {
				found = index;
				break;
			}
		}
		if (found === -1) return undefined;
		locations.push(found + 1);
		from = found + 1;
	}
	if (locations.every((line, index) => index === 0 || line === locations[index - 1] + 1)) return undefined;
	const previewLine = Math.max(0, locations[0] - 1);
	const previewOffset = fileLines.slice(0, previewLine).reduce((sum, line) => sum + line.length + 1, 0);
	return {
		locations,
		correctedPattern: authoredLines.join(`\n${GAP}\n`),
		previewOffset,
	};
}

function rewriteGapCount(rewrite: string): number {
	let count = 0;
	for (let index = 0; index < rewrite.length; ) {
		if (rewrite.startsWith(GAP, index)) {
			count++;
			index += GAP.length;
			continue;
		}
		const codePoint = rewrite.codePointAt(index);
		if (codePoint === undefined) break;
		index += String.fromCodePoint(codePoint).length;
	}
	return count;
}

function capturesAreIdentical(captureIndices: number[], candidates: Candidate[]): boolean {
	return captureIndices.every(captureIndex =>
		candidates.every(candidate => candidate.captures[captureIndex] === candidates[0]?.captures[captureIndex]),
	);
}

function rewriteIsIdenticalForAll(pattern: ParsedPattern, operation: Operation, candidates: Candidate[]): boolean {
	if (operation.rewrite.kind === "explicit") {
		return capturesAreIdentical(
			pattern.selectedCaptureIndices.slice(0, rewriteGapCount(operation.rewrite.text)),
			candidates,
		);
	}
	return operation.rewrite.replacements.every((replacement, index) => {
		const selection = pattern.selectionPairs[index];
		return (
			selection !== undefined &&
			capturesAreIdentical(selection.captureIndices.slice(0, rewriteGapCount(replacement)), candidates)
		);
	});
}

function locate(
	content: string,
	pattern: ParsedPattern,
	operation: Operation,
	operationNumber: number,
	path: string,
): Candidate[] {
	const normalized = normalizeText(content);
	if (pattern.literalFallback) {
		const exact = exactOccurrences(normalized.text, pattern.literalFallback.normalized);
		if (exact.length > 0 && (operation.all || exact.length === 1)) {
			const fallbackCandidates = exact.map(occurrence => {
				const matchStart = sourceStart(normalized, occurrence.start, 0);
				const matchEnd = sourceEnd(normalized, occurrence.end, content.length);
				const fallbackStart = occurrence.start + pattern.literalFallback!.selectionStart;
				const fallbackEnd = occurrence.start + pattern.literalFallback!.selectionEnd;
				const start =
					pattern.literalFallback!.selectionStart === pattern.literalFallback!.normalized.length
						? matchEnd
						: sourceStart(normalized, fallbackStart, matchEnd);
				const end =
					pattern.literalFallback!.selectionEnd === pattern.literalFallback!.normalized.length
						? matchEnd
						: pattern.literalFallback!.insertion
							? sourceStart(normalized, fallbackEnd, matchEnd)
							: sourceEnd(normalized, fallbackEnd, matchEnd);
				return {
					start,
					end,
					matchStart,
					matchEnd,
					captures: [],
					selectionSpans: pattern.selectionPairs.length === 1 ? [{ start, end }] : [],
					tuple: [occurrence.start],
				};
			});
			return operation.all ? fallbackCandidates : [fallbackCandidates[0]];
		}
	}
	let result = collectCandidates(content, normalized, pattern, false);
	if (result.candidates.length === 0 && !result.overflow) {
		result = collectCandidates(content, normalized, pattern, true);
		if (result.candidates.length === 0 && !result.overflow && !operation.all) {
			const punctuationTolerant = collectCandidates(content, normalized, pattern, true, true);
			if (!punctuationTolerant.overflow && punctuationTolerant.candidates.length === 1) {
				result = punctuationTolerant;
			}
		}
	}
	if (result.overflow) {
		throw new Error(`Operation ${operationNumber} pattern is too broad; add another distinctive ${GAP} fragment.`);
	}
	const candidates = result.candidates;
	if (operation.all && candidates.length > 0) return candidates;
	if (candidates.length === 1) return [candidates[0]];
	if (candidates.length === 0) {
		const separated = nonConsecutiveGuidance(content, operation);
		if (separated) {
			const replacementGuidance =
				operation.rewrite.kind === "explicit"
					? `The REWRITE then replaces the whole span lines ${separated.locations[0]}-${separated.locations.at(-1)}, including the skipped lines — re-emit kept gaps with ${GAP}.`
					: `The inline replacements then target the whole span lines ${separated.locations[0]}-${separated.locations.at(-1)}, including skipped lines — re-emit kept gaps with ${GAP}.`;
			throw new Error(
				[
					`Operation ${operationNumber} did not match ${path}: your lines match individually at lines ${separated.locations.join(", ")} but are not consecutive.`,
					"Copy-ready corrected operation:",
					operationPayload(operation, operation.all ? "*" : "", separated.correctedPattern),
					replacementGuidance,
				].join("\n"),
			);
		}
		const guidance = noMatchGuidance(content, normalized, pattern, operation);
		throw new Error(
			[
				operation.all
					? `Operation ${operationNumber} ${OPENER}* found 0 matches in ${path}. ${guidance.reason}`
					: `Operation ${operationNumber} did not match ${path}. ${guidance.reason}`,
				"Current file content near the closest match (no re-read needed):",
				numberedPreview(content, guidance.previewOffset),
				"Copy-ready corrected operation:",
				operationPayload(operation, operation.all ? "*" : "", guidance.correctedPattern),
				...(guidance.additionRetry ? [guidance.additionRetry] : []),
			].join("\n"),
		);
	}
	const retries = candidates.slice(0, 2).map(candidate => {
		const line = lineNumberAt(content, candidate.start);
		const distinguishing = distinguishingContext(content, candidate, candidates);
		const pattern = !distinguishing
			? operation.patternText
			: distinguishing.side === "before"
				? `${distinguishing.line}${GAP}\n${operation.patternText}`
				: `${operation.patternText}\n${GAP}\n${distinguishing.line}`;
		return `Near line ${line}:\n${operationPayload(operation, "", pattern)}`;
	});
	const allRetry = rewriteIsIdenticalForAll(pattern, operation, candidates)
		? `All candidates receive the same rewrite; retry every match:\n${operationPayload(operation, "*")}\n\n`
		: "";
	throw new Error(
		`Operation ${operationNumber} is ambiguous: ${candidates.length} ordered tuples match.\n\n${allRetry}Add context that only the intended match has — one of these:\n\n${retries.join("\n\n")}`,
	);
}

/**
 * A nearby line that only this candidate has — searched above first, then
 * below. Because gaps span freely, an anchor only disambiguates when it does
 * not also sit on the same side of every other candidate. Turns an ambiguous
 * pattern into a unique one for one line plus a gap: cheaper than an ordinal
 * and impossible to misread as an operation index.
 */
function distinguishingContext(
	content: string,
	candidate: Candidate,
	all: Candidate[],
): { side: "before" | "after"; line: string } | undefined {
	const others = all.filter(entry => entry.start !== candidate.start);
	const usable = (line: string | undefined): line is string =>
		line !== undefined && line.length >= 3 && /[\p{L}\p{N}_$]/u.test(line);

	const before = content
		.slice(0, candidate.start)
		.split("\n")
		.map(line => line.trim());
	const othersBefore = others.map(entry =>
		content
			.slice(0, entry.start)
			.split("\n")
			.map(line => line.trim()),
	);
	for (let back = 2; back <= 12 && back <= before.length; back++) {
		const line = before[before.length - back];
		if (!usable(line)) continue;
		if (othersBefore.every(lines => !lines.includes(line))) return { side: "before", line };
	}

	const after = content
		.slice(candidate.end)
		.split("\n")
		.map(line => line.trim());
	const othersAfter = others.map(entry =>
		content
			.slice(entry.end)
			.split("\n")
			.map(line => line.trim()),
	);
	for (let forward = 0; forward < 12 && forward < after.length; forward++) {
		const line = after[forward];
		if (!usable(line)) continue;
		if (othersAfter.every(lines => !lines.includes(line))) return { side: "after", line };
	}
	return undefined;
}

function commonIndent(lines: string[]): number {
	let minimum = Number.POSITIVE_INFINITY;
	for (const line of lines) {
		if (line.trim() === "") continue;
		minimum = Math.min(minimum, line.length - line.trimStart().length);
	}
	return minimum === Number.POSITIVE_INFINITY ? 0 : minimum;
}

function spaceIndentUnit(content: string): number {
	let unit = 0;
	for (const line of content.split("\n")) {
		const indent = line.match(/^ +/)?.[0].length ?? 0;
		if (indent === 0) continue;
		let left = unit;
		let right = indent;
		while (right !== 0) {
			const remainder = left % right;
			left = right;
			right = remainder;
		}
		unit = left;
	}
	return unit || 4;
}

function adaptRelativeIndent(line: string, fileIndent: string, spaceUnit: number): string {
	const indent = line.match(/^[ \t]+/)?.[0] ?? "";
	if (indent === "") return line;
	const rest = line.slice(indent.length);
	if (fileIndent === "\t" && !indent.includes("\t")) {
		const levels = Math.max(1, Math.round(indent.length / Math.max(1, spaceUnit)));
		return "\t".repeat(levels) + rest;
	}
	if (fileIndent === " " && indent.includes("\t") && !indent.includes(" ")) {
		return " ".repeat(indent.length * spaceUnit) + rest;
	}
	return line;
}

function reindentReplacement(content: string, start: number, replacement: string): string {
	if (replacement === "") return replacement;
	const lineStart = content.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
	const baseIndent = content.slice(lineStart, start);
	if (!/^[ \t]*$/.test(baseIndent)) return replacement;
	const lines = replacement.split("\n");
	const remove = commonIndent(lines);
	const stripped = lines.map(line => (line.trim() === "" ? "" : line.slice(Math.min(remove, line.length))));
	const fileIndent = baseIndent[0] ?? detectIndentChar(content);
	const unit = spaceIndentUnit(content);
	return stripped
		.map((line, index) => {
			const adapted = adaptRelativeIndent(line, fileIndent, unit);
			if (index === 0) return adapted;
			if (line === "" && index < stripped.length - 1) return "";
			return baseIndent + adapted;
		})
		.join("\n");
}

function hasIndentAdoptionEvidence(content: string, candidate: Candidate, replacement: string): boolean {
	if (replacement === "") return false;
	const sourceLineStart = content.lastIndexOf("\n", Math.max(0, candidate.matchStart - 1)) + 1;
	const sourceLines = content.slice(sourceLineStart, candidate.matchEnd).split("\n");
	const rewriteLines = replacement.split("\n");
	const deltas: number[] = [];
	let sourceIndex = 0;
	for (const rewriteLine of rewriteLines) {
		if (rewriteLine.trim() === "") continue;
		let aligned = -1;
		for (let index = sourceIndex; index < sourceLines.length; index++) {
			if (sourceLines[index].trim() === rewriteLine.trim()) {
				aligned = index;
				break;
			}
		}
		if (aligned === -1) continue;
		const sourceIndent = sourceLines[aligned].length - sourceLines[aligned].trimStart().length;
		const rewriteIndent = rewriteLine.length - rewriteLine.trimStart().length;
		deltas.push(sourceIndent - rewriteIndent);
		sourceIndex = aligned + 1;
	}
	const repeatedBoundaryAnchor =
		sourceLines.length === 1 &&
		rewriteLines.filter(line => line.trim() !== "").length >= 2 &&
		commonIndent(rewriteLines) === 0 &&
		deltas.length === 1 &&
		deltas[0] > 0 &&
		(rewriteLines[0]?.trim() === sourceLines[0].trim() || rewriteLines.at(-1)?.trim() === sourceLines[0].trim());
	return repeatedBoundaryAnchor || (deltas.length >= 2 && deltas[0] > 0 && deltas.every(delta => delta === deltas[0]));
}

function renderRewrite(
	content: string,
	start: number,
	rewrite: string,
	selectedCaptureIndices: number[],
	captures: string[],
	operationNumber: number,
	adoptIndent: boolean,
): string {
	if (rewrite.includes(SELECT_OPEN) || rewrite.includes(SELECT_CLOSE)) {
		throw new Error(
			`Operation ${operationNumber} has selection markers in REWRITE; PATTERN is current text, REWRITE is final text.`,
		);
	}
	const sentinels = selectedCaptureIndices.map((_, index) => `\u0000V8GAP${index}\u0000`);
	let markerIndex = 0;
	let marked = "";
	for (let index = 0; index < rewrite.length; ) {
		const gapMarker = rewrite.startsWith(GAP, index) ? GAP : undefined;
		if (gapMarker) {
			marked += markerIndex < sentinels.length ? sentinels[markerIndex] : gapMarker;
			markerIndex++;
			index += gapMarker.length;
			continue;
		}
		const codePoint = rewrite.codePointAt(index);
		if (codePoint === undefined) break;
		const character = String.fromCodePoint(codePoint);
		marked += character;
		index += character.length;
	}
	const indent = (value: string) => (adoptIndent ? reindentReplacement(content, start, value) : value);
	if (markerIndex === 0 || sentinels.length === 0) return indent(marked);
	let rendered = indent(marked);
	for (let index = 0; index < sentinels.length; index++) {
		const sentinel = sentinels[index];
		const capture = captures[selectedCaptureIndices[index]] ?? "";
		const sentinelAt = rendered.indexOf(sentinel);
		if (sentinelAt === -1) continue;
		let before = rendered.slice(0, sentinelAt);
		let after = rendered.slice(sentinelAt + sentinel.length);
		if (/^\s/u.test(capture) && /\s$/u.test(before)) before = before.replace(/\s+$/u, "");
		if (/\s$/u.test(capture) && /^\s/u.test(after)) after = after.replace(/^\s+/u, "");
		rendered = before + capture + after;
	}
	return rendered;
}

function alignBoundaryEchoes(content: string, candidate: Candidate, replacement: string): string {
	if (replacement === "" || (candidate.start === candidate.matchStart && candidate.end === candidate.matchEnd)) {
		return replacement;
	}
	const prefix = content.slice(candidate.matchStart, candidate.start);
	const suffix = content.slice(candidate.end, candidate.matchEnd);
	const normalizedReplacement = normalizeText(replacement);
	const normalizedPrefix = normalizeText(prefix).text;
	const normalizedSuffix = normalizeText(suffix).text;
	const prefixEcho = normalizedPrefix.length >= 3 && normalizedReplacement.text.startsWith(normalizedPrefix);
	const suffixEcho =
		normalizedSuffix.length > 0 &&
		normalizedReplacement.text.endsWith(normalizedSuffix) &&
		(normalizedSuffix.length >= 3 || prefixEcho);
	if (!prefixEcho && !suffixEcho) return replacement;

	let from = 0;
	let to = replacement.length;
	if (prefixEcho) {
		from = replacement.startsWith(prefix)
			? prefix.length
			: sourceEnd(normalizedReplacement, normalizedPrefix.length, replacement.length);
	}
	if (suffixEcho) {
		to = replacement.endsWith(suffix)
			? replacement.length - suffix.length
			: sourceStart(
					normalizedReplacement,
					normalizedReplacement.text.length - normalizedSuffix.length,
					replacement.length,
				);
	}
	if (from > to) return replacement;
	let aligned = replacement.slice(from, to);
	if (/\s$/u.test(prefix) && /^\s/u.test(aligned)) aligned = aligned.replace(/^\s+/u, "");
	if (/^\s/u.test(suffix) && /\s$/u.test(aligned)) aligned = aligned.replace(/\s+$/u, "");
	return aligned;
}

function expandFullLineDeletion(content: string, candidate: Candidate): Candidate {
	if (candidate.start === candidate.end) return candidate;
	const lineStart = content.lastIndexOf("\n", Math.max(0, candidate.start - 1)) + 1;
	const newline = content.indexOf("\n", candidate.end);
	const lineEnd = newline === -1 ? content.length : newline;
	if (
		!/^[ \t]*$/.test(content.slice(lineStart, candidate.start)) ||
		!/^[ \t]*$/.test(content.slice(candidate.end, lineEnd))
	) {
		return candidate;
	}
	let end = newline === -1 ? lineEnd : newline + 1;
	if (lineStart > 0 && end < content.length) {
		const previousEnd = lineStart - 1;
		const previousStart = content.lastIndexOf("\n", Math.max(0, previousEnd - 1)) + 1;
		const nextEnd = content.indexOf("\n", end);
		const previousBlank = content.slice(previousStart, previousEnd).trim() === "";
		const nextBlank = content.slice(end, nextEnd === -1 ? content.length : nextEnd).trim() === "";
		if (previousBlank && nextBlank) end = nextEnd === -1 ? content.length : nextEnd + 1;
	}
	return { ...candidate, start: lineStart, end };
}

function positionalRewriteSegments(rewrite: string, count: number, patternHasGaps: boolean): string[] | undefined {
	const lines = rewrite.split("\n");
	const isWholeLineGap = (line: string) => line.trim() === GAP;
	const hasWholeLineGap = lines.some(isWholeLineGap);
	if (hasWholeLineGap) {
		if (patternHasGaps) return undefined;
		const groups: string[][] = [[]];
		for (const line of lines) {
			if (isWholeLineGap(line)) {
				groups.push([]);
			} else {
				groups.at(-1)?.push(line);
			}
		}
		if (groups.length === count) return groups.map(group => group.join("\n"));
		return undefined;
	}
	if (lines.length === count) return lines;
	if (!rewrite.includes("\n")) {
		const segments = rewrite.split(GAP);
		if (segments.length === count) return segments;
	}
	return undefined;
}

function prepareCandidateEdit(
	content: string,
	candidate: Candidate,
	pattern: ParsedPattern,
	operation: Operation,
	rewrite: string,
	operationNumber: number,
): { candidate: Candidate; replacement: string; deletedText: string | undefined } {
	const lineStart = content.lastIndexOf("\n", Math.max(0, candidate.start - 1)) + 1;
	const leadingSourceWhitespace = content.slice(lineStart, candidate.start);
	const controlsWholeIndent =
		!(operation.patternText.includes(SELECT_OPEN) || operation.patternText.includes(SELECT_CLOSE)) &&
		/^[ \t]*$/u.test(leadingSourceWhitespace);
	const authoredStart = controlsWholeIndent ? lineStart : candidate.start;
	const authoredSource = content.slice(authoredStart, candidate.end);
	const whitespaceOnly =
		authoredSource !== rewrite && normalizeText(authoredSource).text === normalizeText(rewrite).text;
	const adoptIndent =
		!whitespaceOnly &&
		!(operation.patternText.includes(SELECT_OPEN) || operation.patternText.includes(SELECT_CLOSE)) &&
		hasIndentAdoptionEvidence(content, candidate, rewrite);
	if (controlsWholeIndent && !adoptIndent && lineStart < candidate.start) {
		candidate = { ...candidate, start: lineStart, matchStart: Math.min(lineStart, candidate.matchStart) };
	}
	let replacement = renderRewrite(
		content,
		candidate.start,
		rewrite,
		candidate.captures.length === 0 ? [] : pattern.selectedCaptureIndices,
		candidate.captures,
		operationNumber,
		adoptIndent || operation.patternText.includes(SELECT_OPEN) || operation.patternText.includes(SELECT_CLOSE),
	);
	replacement = alignBoundaryEchoes(content, candidate, replacement);
	let deletedText: string | undefined;
	if (replacement === "") {
		deletedText = content.slice(candidate.start, candidate.end);
		candidate = expandFullLineDeletion(content, candidate);
	}
	return { candidate, replacement, deletedText };
}

function prepareInlineSelectionEdit(
	content: string,
	located: Candidate,
	span: { start: number; end: number },
	selection: SelectionPair,
	rewrite: string,
	operationNumber: number,
): { candidate: Candidate; replacement: string; deletedText: string | undefined } {
	let candidate: Candidate = {
		...located,
		start: span.start,
		end: span.end,
		matchStart: span.start,
		matchEnd: span.end,
	};
	const desired =
		candidate.start === candidate.end && rewrite.startsWith("\n") && content[candidate.start - 1] === "\n"
			? rewrite.slice(1)
			: rewrite;
	// Multi-line desired text may be authored at absolute file columns (it
	// visually continues the pattern) or relative to the selection; reuse the
	// legacy alignment evidence to decide instead of always re-indenting.
	const adoptIndent = !desired.includes("\n") || hasIndentAdoptionEvidence(content, candidate, desired);
	const replacement = renderRewrite(
		content,
		candidate.start,
		selection.lineInsertion && desired !== "" && !desired.startsWith("\n") && !desired.endsWith("\n")
			? `${desired}\n`
			: desired,
		selection.captureIndices,
		candidate.captures,
		operationNumber,
		adoptIndent,
	);
	if (replacement === "" && candidate.start !== candidate.end) {
		const deletedText = content.slice(candidate.start, candidate.end);
		candidate = expandFullLineDeletion(content, candidate);
		return { candidate, replacement, deletedText };
	}
	return { candidate, replacement, deletedText: undefined };
}

function wouldChangeHint(
	content: string,
	chosen: Candidate,
	pattern: ParsedPattern,
	operation: Operation,
	rewrite: string,
	operationNumber: number,
): string | undefined {
	const alternatives = exactAndFuzzyCandidates(content, pattern);
	if (alternatives.overflow) return undefined;
	for (let index = 0; index < alternatives.candidates.length; index++) {
		const alternative = alternatives.candidates[index];
		if (
			alternative.start === chosen.start &&
			alternative.end === chosen.end &&
			alternative.matchStart === chosen.matchStart &&
			alternative.matchEnd === chosen.matchEnd
		) {
			continue;
		}
		const prepared = prepareCandidateEdit(content, alternative, pattern, operation, rewrite, operationNumber);
		if (content.slice(prepared.candidate.start, prepared.candidate.end) === prepared.replacement) continue;
		const line = lineNumberAt(content, prepared.candidate.start);
		return `Line ${line} also matches and WOULD change — target it by adding context unique to it.`;
	}
	return undefined;
}

function positionalWouldChangeHint(
	content: string,
	chosen: Candidate,
	pattern: ParsedPattern,
	replacements: string[],
): string | undefined {
	const alternatives = exactAndFuzzyCandidates(content, pattern);
	if (alternatives.overflow) return undefined;
	for (let index = 0; index < alternatives.candidates.length; index++) {
		const alternative = alternatives.candidates[index];
		if (
			alternative.start === chosen.start &&
			alternative.end === chosen.end &&
			alternative.matchStart === chosen.matchStart &&
			alternative.matchEnd === chosen.matchEnd
		) {
			continue;
		}
		const changes = alternative.selectionSpans.some(
			(span, selectionIndex) => content.slice(span.start, span.end) !== replacements[selectionIndex],
		);
		if (!changes) continue;
		const line = lineNumberAt(content, alternative.start);
		return `Line ${line} also matches and WOULD change — target it by adding context unique to it.`;
	}
	return undefined;
}

function inlineWouldChangeHint(
	content: string,
	chosen: Candidate,
	pattern: ParsedPattern,
	replacements: string[],
	operationNumber: number,
): string | undefined {
	const alternatives = exactAndFuzzyCandidates(content, pattern);
	if (alternatives.overflow) return undefined;
	for (const alternative of alternatives.candidates) {
		if (
			alternative.start === chosen.start &&
			alternative.end === chosen.end &&
			alternative.matchStart === chosen.matchStart &&
			alternative.matchEnd === chosen.matchEnd
		) {
			continue;
		}
		const changes = alternative.selectionSpans.some((span, index) => {
			const selection = pattern.selectionPairs[index];
			if (selection === undefined) return false;
			const prepared = prepareInlineSelectionEdit(
				content,
				alternative,
				span,
				selection,
				replacements[index] ?? "",
				operationNumber,
			);
			return content.slice(prepared.candidate.start, prepared.candidate.end) !== prepared.replacement;
		});
		if (!changes) continue;
		const line = lineNumberAt(content, alternative.start);
		return `Line ${line} also matches and WOULD change — target it by adding context unique to it.`;
	}
	return undefined;
}

function rewriteProvesWholeSpan(content: string, candidate: Candidate, rewrite: string): boolean {
	const normalizedRewrite = normalizeText(rewrite).text;
	const contexts = candidate.selectionSpans
		.slice(0, -1)
		.map((span, index) => normalizeText(content.slice(span.end, candidate.selectionSpans[index + 1].start)).text)
		.filter(context => context !== "");
	if (contexts.length === 0) return false;
	let from = 0;
	for (const context of contexts) {
		const found = normalizedRewrite.indexOf(context, from);
		if (found === -1) return false;
		from = found + context.length;
	}
	return true;
}

function rewriteSelectionSpans(content: string, candidate: Candidate, replacements: string[]): string {
	let rewritten = content.slice(candidate.start, candidate.end);
	const indexed = candidate.selectionSpans
		.map((span, index) => ({ span, replacement: replacements[index] }))
		.sort((left, right) => right.span.start - left.span.start);
	for (const { span, replacement } of indexed) {
		const start = span.start - candidate.start;
		const end = span.end - candidate.start;
		rewritten = rewritten.slice(0, start) + replacement + rewritten.slice(end);
	}
	return rewritten;
}

/**
 * Merge two overlapping planned edits when they agree. Each edit is applied
 * independently to the union span; identical results mean the payload is
 * consistent (typically a `«*` rename plus a narrower op over one of its
 * matches), so one merged edit replaces both. Disagreement returns undefined
 * and the caller reports the conflict.
 */
function reconcileOverlap(content: string, left: PlannedEdit, right: PlannedEdit): PlannedEdit | undefined {
	const start = Math.min(left.start, right.start);
	const end = Math.max(left.end, right.end);
	const project = (edit: PlannedEdit): string =>
		content.slice(start, edit.start) + edit.replacement + content.slice(edit.end, end);
	const projected = project(left);
	if (projected !== project(right)) return undefined;
	return { start, end, replacement: projected, operationNumber: left.operationNumber };
}

/**
 * Line-level echo recoveries for a pattern that found nothing: drop a previous
 * line that merely retypes a selection-bearing line (`X` above `if (⟪X⟫)`),
 * or relocate a selection-only line into its unique occurrence inside the
 * previous anchor line (`A old B` above `⟪old⟫` → `A ⟪old⟫ B`).
 */
function echoLineCandidates(patternText: string): string[] {
	const lines = patternText.split("\n");
	const balancedInline = (line: string) => (line.match(/⟪/gu) || []).length === (line.match(/⟫/gu) || []).length;
	const results: string[] = [];
	for (let index = 1; index < lines.length; index++) {
		const previous = lines[index - 1];
		const line = lines[index];
		if (!line.includes(SELECT_OPEN) || !balancedInline(line)) continue;
		if (previous.includes(SELECT_OPEN) || previous.includes(GAP) || previous.trim() === "") continue;
		const withOld = line.replaceAll(/⟪([^⟪⟫]*)⟫/gu, "$1");
		const previousNormalized = normalizeText(previous);
		if (normalizeText(withOld).text !== "" && normalizeText(withOld).text === previousNormalized.text) {
			results.push([...lines.slice(0, index - 1), ...lines.slice(index)].join("\n"));
			continue;
		}
		const only = line.trim().match(/^⟪([^⟪⟫]*)⟫$/u);
		if (!only) continue;
		const oldNormalized = normalizeText(only[1]).text;
		if (oldNormalized === "") continue;
		const first = previousNormalized.text.indexOf(oldNormalized);
		if (first === -1 || previousNormalized.text.indexOf(oldNormalized, first + 1) !== -1) continue;
		const rawStart = previousNormalized.starts[first] ?? 0;
		const rawEnd = previousNormalized.ends[first + oldNormalized.length - 1] ?? previous.length;
		const embedded = previous.slice(0, rawStart) + line.trim() + previous.slice(rawEnd);
		results.push([...lines.slice(0, index - 1), embedded, ...lines.slice(index + 1)].join("\n"));
	}
	return results;
}

/**
 * Drop a literal echo of a selection's current text that immediately precedes
 * the selection (`X⟪X⟫` → `⟪X⟫`). Models sometimes retype the old text as
 * anchor context; the duplicated text demands two consecutive occurrences and
 * never matches. Used only as a retry after the authored pattern found nothing.
 */
function dropSelectionEchoes(patternText: string): string | undefined {
	let result = "";
	let runStart = 0;
	let changed = false;
	let index = 0;
	while (index < patternText.length) {
		if (patternText.startsWith(GAP, index)) {
			result += patternText.slice(runStart, index + GAP.length);
			index += GAP.length;
			runStart = index;
			continue;
		}
		const codePoint = patternText.codePointAt(index);
		if (codePoint === undefined) break;
		const character = String.fromCodePoint(codePoint);
		if (character !== SELECT_OPEN) {
			index += character.length;
			continue;
		}
		const close = patternText.indexOf(SELECT_CLOSE, index + character.length);
		if (close === -1) return undefined;
		const selected = patternText.slice(index + character.length, close);
		const run = patternText.slice(runStart, index);
		const runNormalized = normalizeText(run);
		const oldNormalized = normalizeText(selected).text;
		if (oldNormalized !== "" && runNormalized.text.endsWith(oldNormalized)) {
			const cut = runNormalized.starts[runNormalized.text.length - oldNormalized.length] ?? 0;
			result += patternText.slice(runStart, runStart + cut);
			changed = true;
		} else {
			result += run;
		}
		result += patternText.slice(index, close + SELECT_CLOSE.length);
		index = close + SELECT_CLOSE.length;
		runStart = index;
	}
	result += patternText.slice(runStart);
	return changed ? result : undefined;
}

/**
 * Trim boundary text double-typed on both a selection and its adjacent
 * literal (`crypto.⟪.? .get⟫` after `crypto.` → `crypto.⟪? .get⟫`): the
 * duplicated characters demand the shared text twice and never match. The
 * literal stays authoritative so the operation's stated final text survives.
 */
function overlapTrimCandidates(patternText: string): string[] {
	const results: string[] = [];
	for (let index = 0; index < patternText.length; ) {
		if (patternText.startsWith(GAP, index)) {
			index += GAP.length;
			continue;
		}
		const codePoint = patternText.codePointAt(index);
		if (codePoint === undefined) break;
		const character = String.fromCodePoint(codePoint);
		if (character !== SELECT_OPEN) {
			index += character.length;
			continue;
		}
		const close = patternText.indexOf(SELECT_CLOSE, index + character.length);
		if (close === -1) return results;
		const old = patternText.slice(index + character.length, close);
		const oldNormalized = normalizeText(old);
		const lineStart = patternText.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
		const previousBoundary = Math.max(
			lineStart,
			patternText.lastIndexOf(SELECT_CLOSE, index - 1) + 1,
			patternText.lastIndexOf(GAP, index - 1) + GAP.length,
		);
		const previousNormalized = normalizeText(patternText.slice(previousBoundary, index)).text;
		const lineEnd = patternText.indexOf("\n", close + 1);
		const nextOpen = patternText.indexOf(SELECT_OPEN, close + 1);
		const nextGap = patternText.indexOf(GAP, close + 1);
		const nextBoundary = Math.min(
			lineEnd === -1 ? patternText.length : lineEnd,
			nextOpen === -1 ? patternText.length : nextOpen,
			nextGap === -1 ? patternText.length : nextGap,
		);
		const nextNormalized = normalizeText(patternText.slice(close + 1, nextBoundary)).text;
		for (let overlap = Math.min(oldNormalized.text.length - 1, previousNormalized.length); overlap >= 1; overlap--) {
			if (oldNormalized.text.slice(0, overlap) !== previousNormalized.slice(-overlap)) continue;
			const rawStart = oldNormalized.starts[overlap] ?? old.length;
			results.push(patternText.slice(0, index + character.length) + old.slice(rawStart) + patternText.slice(close));
			break;
		}
		for (let overlap = Math.min(oldNormalized.text.length - 1, nextNormalized.length); overlap >= 1; overlap--) {
			if (oldNormalized.text.slice(-overlap) !== nextNormalized.slice(0, overlap)) continue;
			const rawEnd = oldNormalized.starts[oldNormalized.text.length - overlap] ?? old.length;
			results.push(patternText.slice(0, index + character.length) + old.slice(0, rawEnd) + patternText.slice(close));
			break;
		}
		index = close + 1;
	}
	return results;
}

/**
 * Join a multi-line pattern's lines with `…` gaps: models often list only the
 * lines they edit, omitting the unchanged lines between them, which fails
 * consecutive matching. Gap-joined, each listed line anchors independently.
 */
function gapJoinCandidate(patternText: string): string | undefined {
	if (patternText.includes(GAP)) return undefined;
	const lines = patternText.split("\n").filter(line => line.trim() !== "");
	// Only when every listed line is itself an edit site: selections replace
	// nothing outside themselves, so gap-joined skipped lines survive. A
	// whole-span REWRITE would silently swallow the skipped lines instead —
	// those patterns keep the fail-closed non-consecutive diagnosis.
	if (lines.length < 2 || !lines.every(line => line.includes(SELECT_OPEN))) return undefined;
	return lines.join(`\n${GAP}\n`);
}

/** Ordered echo-recovery pattern rewrites to retry after a failed match. */
function recoverPatternCandidates(patternText: string): string[] {
	const candidates: string[] = [];
	const push = (candidate: string | undefined) => {
		if (candidate !== undefined && candidate !== patternText && !candidates.includes(candidate)) {
			candidates.push(candidate);
		}
	};
	push(dropSelectionEchoes(patternText));
	for (const candidate of echoLineCandidates(patternText)) push(candidate);
	for (const candidate of overlapTrimCandidates(patternText)) push(candidate);
	push(gapJoinCandidate(patternText));
	return candidates;
}

function normalizedIndexAt(normalized: NormalizedText, rawOffset: number): number {
	let low = 0;
	let high = normalized.starts.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (normalized.starts[mid] < rawOffset) low = mid + 1;
		else high = mid;
	}
	return low;
}

/**
 * A no-op rewrite whose text is duplicated immediately before or after the
 * match means "collapse two copies to one" (duplicated-block cleanup): widen
 * the span to swallow the adjacent copy so applying the rewrite deduplicates.
 */
function duplicateCollapseSpan(
	content: string,
	candidate: Candidate,
	replacement: string,
): { start: number; end: number } | undefined {
	const MIN_OVERLAP = 8;
	const rewriteNormalized = normalizeText(replacement).text;
	if (rewriteNormalized.length < MIN_OVERLAP || rewriteNormalized.length > 5000) return undefined;
	const normalized = normalizeText(content);
	const matchStart = normalizedIndexAt(normalized, candidate.start);
	const matchEnd = normalizedIndexAt(normalized, candidate.end);
	for (let overlap = Math.min(rewriteNormalized.length, matchStart); overlap >= MIN_OVERLAP; overlap--) {
		if (normalized.text.slice(matchStart - overlap, matchStart) !== rewriteNormalized.slice(0, overlap)) continue;
		let start = normalized.starts[matchStart - overlap] ?? candidate.start;
		const lineStart = content.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
		if (/^[ \t]*$/u.test(content.slice(lineStart, start))) start = lineStart;
		return { start, end: candidate.end };
	}
	for (
		let overlap = Math.min(rewriteNormalized.length, normalized.text.length - matchEnd);
		overlap >= MIN_OVERLAP;
		overlap--
	) {
		if (normalized.text.slice(matchEnd, matchEnd + overlap) !== rewriteNormalized.slice(-overlap)) continue;
		let end = normalized.ends[matchEnd + overlap - 1] ?? candidate.end;
		const newline = content.indexOf("\n", end);
		const lineEnd = newline === -1 ? content.length : newline;
		if (/^[ \t]*$/u.test(content.slice(end, lineEnd))) end = lineEnd;
		return { start: candidate.start, end };
	}
	return undefined;
}

function resolveRewriteReferences(rewrite: string, removedByOperation: Array<string | undefined>): string {
	return rewrite
		.split("\n")
		.map(line => {
			const reference = line.trim().match(/^»([1-9]\d*)$/u);
			if (!reference) return line;
			const referenced = removedByOperation[Number(reference[1]) - 1];
			if (referenced === undefined) {
				throw new Error(`${REWRITE_HEADER}${reference[1]} must reference an earlier deletion operation.`);
			}
			return referenced;
		})
		.join("\n");
}

/**
 * Locate an operation's candidates; when the authored pattern finds nothing,
 * retry echo-recovery variants (`X⟪X⟫` dedup, echoed anchor lines) and keep
 * the original error when every variant fails too.
 */
function locateWithEchoRecovery(
	content: string,
	operation: Operation,
	operationNumber: number,
	path: string,
): { operation: Operation; pattern: ParsedPattern; candidates: Candidate[] } {
	const pattern = parsePattern(operation.patternText, operationNumber);
	try {
		return { operation, pattern, candidates: locate(content, pattern, operation, operationNumber, path) };
	} catch (error) {
		for (const candidatePattern of recoverPatternCandidates(operation.patternText)) {
			try {
				const retryPattern = parsePattern(candidatePattern, operationNumber);
				const retryOperation = { ...operation, patternText: candidatePattern };
				const candidates = locate(content, retryPattern, retryOperation, operationNumber, path);
				return { operation: retryOperation, pattern: retryPattern, candidates };
			} catch {
				// Try the next echo-recovery candidate.
			}
		}
		throw error;
	}
}

function applyOperations(content: string, input: string, context: SloppyApplyContext): string {
	let payloadHash = 2166136261;
	for (let index = 0; index < input.length; index++) {
		payloadHash ^= input.charCodeAt(index);
		payloadHash = Math.imul(payloadHash, 16777619);
	}
	const hash = (payloadHash >>> 0).toString(16);
	if (noOpByPath.get(context.path)?.hash !== hash) noOpByPath.delete(context.path);
	const throwNoOp = (
		operationNumber?: number,
		preview?: { content: string; offset: number },
		matchCount?: number,
		hint?: string,
	): never => {
		const previous = noOpByPath.get(context.path);
		const count = previous?.hash === hash ? previous.count + 1 : 1;
		noOpByPath.set(context.path, { hash, count });
		const base =
			count >= 3
				? `STOP: identical no-op repeated ${count} times for ${context.path}. Re-read current code and send a changed payload, or move on.`
				: operationNumber === undefined
					? `Edits to ${context.path} made no change.`
					: matchCount === undefined
						? `Operation ${operationNumber} makes no change to ${context.path}.`
						: `Operation ${operationNumber} ${OPENER}* matched ${matchCount} occurrences but all make no change to ${context.path}.`;
		const grounding = preview
			? `\nYour rewrite normalized to text identical to these lines. Indentation-only changes are applied verbatim; adjust the authored REWRITE if another whitespace change was intended.\nCurrent file content near the closest match (no re-read needed):\n${numberedPreview(preview.content, preview.offset)}`
			: "";
		throw new Error(base + grounding + (hint ? `\n${hint}` : ""));
	};

	let operations: Operation[];
	try {
		operations = parseOperations(input, content);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		// A parse error that already carries a copy-ready payload (e.g. the
		// fill-in skeleton) must not be followed by an echo of the broken input.
		if (error.message.includes("Copy-ready corrected payload")) throw error;
		const normalizedPayload = normalizeInput(input);
		const retry =
			parseOpener(normalizedPayload.split("\n")[0] ?? "") === false
				? `${OPENER}\n${normalizedPayload}`
				: normalizedPayload;
		throw new Error(`${error.message}\nCopy-ready corrected payload:\n${retry}`);
	}
	const removedByOperation: Array<string | undefined> = [];
	const planned: PlannedEdit[] = [];
	const deletionNotes = new Map<number, string>();
	const recoveryNotes: string[] = [];
	let lastMatchOffset = 0;
	for (let index = 0; index < operations.length; index++) {
		const operationNumber = index + 1;
		const parsedNote = operations[index].recoveryNote;
		if (parsedNote !== undefined) recoveryNotes.push(parsedNote);
		const located = locateWithEchoRecovery(content, operations[index], operationNumber, context.path);
		const operation = located.operation;
		const pattern = located.pattern;
		const candidates = located.candidates;
		const orderedCandidates = operation.all
			? [...candidates].sort((left, right) => right.start - left.start)
			: candidates;

		if (operation.rewrite.kind === "inline") {
			const replacements = operation.rewrite.replacements.map(rewrite =>
				resolveRewriteReferences(rewrite, removedByOperation),
			);
			if (pattern.selectionPairs.length !== replacements.length) {
				throw new Error(`Operation ${operationNumber} inline replacements do not align with its selections.`);
			}
			let changes = 0;
			let deletedText: string | undefined;
			for (const located of orderedCandidates) {
				const selections = located.selectionSpans
					.map((span, selectionIndex) => ({
						span,
						selection: pattern.selectionPairs[selectionIndex],
						rewrite: replacements[selectionIndex],
					}))
					.sort((left, right) => right.span.start - left.span.start);
				for (const selection of selections) {
					if (selection.selection === undefined || selection.rewrite === undefined) {
						throw new Error(`Operation ${operationNumber} inline replacements do not align with its selections.`);
					}
					const prepared = prepareInlineSelectionEdit(
						content,
						located,
						selection.span,
						selection.selection,
						selection.rewrite,
						operationNumber,
					);
					if (content.slice(prepared.candidate.start, prepared.candidate.end) === prepared.replacement) continue;
					if (
						prepared.deletedText !== undefined &&
						candidates.length === 1 &&
						pattern.selectionPairs.length === 1
					) {
						deletedText = prepared.deletedText;
					}
					planned.push({
						start: prepared.candidate.start,
						end: prepared.candidate.end,
						replacement: prepared.replacement,
						operationNumber,
					});
					changes++;
				}
				lastMatchOffset = located.matchStart;
			}
			if (deletedText !== undefined) removedByOperation[index] = deletedText;
			if (changes === 0) {
				const hint =
					inlineWouldChangeHint(content, candidates[0], pattern, replacements, operationNumber) ??
					`The desired side equals the current text — identical ${SELECT_OPEN}current${SELECT_DIVIDER}desired${SELECT_CLOSE} sides never change the file. Restate the selection with the actual change after ${SELECT_DIVIDER}; do not drop the operation.`;
				throwNoOp(
					operationNumber,
					{ content, offset: candidates[0].matchStart },
					operation.all ? candidates.length : undefined,
					hint,
				);
			}
			continue;
		}

		const explicitRewrite = operation.rewrite.text;
		const loneReference = explicitRewrite.match(/^[ \t]*»([1-9]\d*)[ \t]*$/u);
		const resolvedRewrite = resolveRewriteReferences(explicitRewrite, removedByOperation);
		const baseResolvedRewrite = resolvedRewrite.trim() === "" ? (pattern.insertion ? "\n" : "") : resolvedRewrite;
		if (pattern.selectionRanges.length > 1) {
			const segments = positionalRewriteSegments(
				baseResolvedRewrite,
				pattern.selectionRanges.length,
				pattern.tokens.some(token => token.kind === "gap"),
			);
			if (segments) {
				let positionalChanges = 0;
				for (const candidate of orderedCandidates) {
					const selections = candidate.selectionSpans
						.map((span, selectionIndex) => ({ span, replacement: segments[selectionIndex] }))
						.sort((left, right) => right.span.start - left.span.start);
					for (const { span, replacement } of selections) {
						if (content.slice(span.start, span.end) === replacement) continue;
						planned.push({ ...span, replacement, operationNumber });
						positionalChanges++;
					}
					lastMatchOffset = candidate.matchStart;
				}
				if (positionalChanges === 0) {
					const hint = positionalWouldChangeHint(content, candidates[0], pattern, segments);
					throwNoOp(
						operationNumber,
						{ content, offset: candidates[0].matchStart },
						operation.all ? candidates.length : undefined,
						hint,
					);
				}
				continue;
			}
			if (!candidates.every(candidate => rewriteProvesWholeSpan(content, candidate, baseResolvedRewrite))) {
				const candidate = candidates[0];
				const oneLineRewrite = baseResolvedRewrite.replace(/\s*\n\s*/gu, " ");
				const repeated = new Array<string>(pattern.selectionRanges.length).fill(oneLineRewrite);
				const header = operation.all ? `${OPENER}*` : OPENER;
				throw new Error(
					[
						`Operation ${operationNumber} has ${pattern.selectionRanges.length} selections, but REWRITE proves neither positional substitution nor whole-span replacement.`,
						"Copy-ready per-selection interpretation:",
						`${header}\n${operation.patternText}\n${REWRITE_HEADER}\n${repeated.join("\n")}`,
						"Copy-ready whole-span interpretation:",
						`${header}\n${operation.patternText}\n${REWRITE_HEADER}\n${rewriteSelectionSpans(content, candidate, repeated)}`,
					].join("\n"),
				);
			}
		}
		let changes = 0;
		for (const located of orderedCandidates) {
			let candidate = located;
			let resolvedCandidateRewrite = baseResolvedRewrite;
			if (loneReference && !operation.all) {
				const referenced = removedByOperation[Number(loneReference[1]) - 1];
				const anchorLineStart = content.lastIndexOf("\n", Math.max(0, candidate.matchStart - 1)) + 1;
				const anchorNewline = content.indexOf("\n", candidate.matchEnd);
				const anchorLineEnd = anchorNewline === -1 ? content.length : anchorNewline;
				const anchorLine = content.slice(anchorLineStart, anchorLineEnd);
				const singleWholeLine =
					!pattern.insertion &&
					anchorLine.trim() !== "" &&
					!content.slice(candidate.matchStart, candidate.matchEnd).includes("\n") &&
					/^[ \t]*$/u.test(content.slice(anchorLineStart, candidate.matchStart)) &&
					/^[ \t]*$/u.test(content.slice(candidate.matchEnd, anchorLineEnd));
				const anchorNormalized = normalizeText(anchorLine).text;
				if (
					referenced !== undefined &&
					singleWholeLine &&
					anchorNormalized !== "" &&
					!normalizeText(referenced).text.includes(anchorNormalized)
				) {
					resolvedCandidateRewrite = `${referenced.replace(/\n+$/u, "")}\n\n${anchorLine}`;
				}
			}
			const rewrite =
				pattern.lineInsertion && resolvedCandidateRewrite !== "" && !resolvedCandidateRewrite.endsWith("\n")
					? `${resolvedCandidateRewrite}\n`
					: resolvedCandidateRewrite;
			const prepared = prepareCandidateEdit(content, candidate, pattern, operation, rewrite, operationNumber);
			candidate = prepared.candidate;
			const replacement = prepared.replacement;
			if (prepared.deletedText !== undefined && candidates.length === 1) {
				removedByOperation[index] = prepared.deletedText;
			}
			if (prepared.deletedText !== undefined) {
				const deletedLines = prepared.deletedText.split("\n").filter(entry => entry.trim() !== "").length;
				deletionNotes.set(
					operationNumber,
					operation.assumedDeletion
						? `Note: operation ${operationNumber} had no ${REWRITE_HEADER} REWRITE and was applied as a move deletion (a later operation re-emits its block).`
						: `Note: operation ${operationNumber} deleted ${deletedLines} line(s); an empty REWRITE means deletion — resend with the final text if you meant to replace.`,
				);
			}
			lastMatchOffset = candidate.matchStart;
			if (content.slice(candidate.start, candidate.end) === replacement) {
				if (operation.all) continue;
				const collapsed = duplicateCollapseSpan(content, candidate, replacement);
				if (collapsed) {
					planned.push({ ...collapsed, replacement, operationNumber });
					changes++;
					continue;
				}
				const hint =
					loneReference === null
						? wouldChangeHint(content, located, pattern, operation, rewrite, operationNumber)
						: undefined;
				throwNoOp(operationNumber, { content, offset: candidate.matchStart }, undefined, hint);
			}
			planned.push({ start: candidate.start, end: candidate.end, replacement, operationNumber });
			changes++;
		}
		if (operation.all && changes === 0) {
			const rewrite =
				pattern.lineInsertion && baseResolvedRewrite !== "" && !baseResolvedRewrite.endsWith("\n")
					? `${baseResolvedRewrite}\n`
					: baseResolvedRewrite;
			const hint =
				loneReference === null
					? wouldChangeHint(content, candidates[0], pattern, operation, rewrite, operationNumber)
					: undefined;
			throwNoOp(operationNumber, { content, offset: candidates[0].matchStart }, candidates.length, hint);
		}
	}
	if (planned.length === 0) throwNoOp(undefined, { content, offset: lastMatchOffset });
	const sorted = [...planned].sort((left, right) => left.start - right.start || left.end - right.end);
	const ordered: PlannedEdit[] = [];
	for (const current of sorted) {
		const previous = ordered.at(-1);
		const overlaps =
			previous !== undefined &&
			(current.start < previous.end ||
				(current.start === previous.start && (current.end === current.start || previous.end === previous.start)));
		if (!previous || !overlaps) {
			ordered.push(current);
			continue;
		}
		// Overlapping spans are only a conflict when they disagree. A broad
		// `«*` plus a narrower op over one of its matches (rename + the line
		// that contains it) produces byte-identical text for the shared
		// region — merge instead of rejecting a payload that is consistent.
		const merged = reconcileOverlap(content, previous, current);
		if (merged) {
			ordered[ordered.length - 1] = merged;
			continue;
		}
		const firstLine = lineNumberAt(content, previous.start);
		const secondLine = lineNumberAt(content, current.start);
		throw new Error(
			[
				`Operations ${previous.operationNumber} and ${current.operationNumber} target overlapping original spans near lines ${firstLine} and ${secondLine}.`,
				"Conflicting candidates:",
				`Operation ${previous.operationNumber} near line ${firstLine}:\n${operationPayload(operations[previous.operationNumber - 1])}`,
				`Operation ${current.operationNumber} near line ${secondLine}:\n${operationPayload(operations[current.operationNumber - 1])}`,
				"Keep whichever states the intended final text and drop the other.",
			].join("\n\n"),
		);
	}
	let result = content;
	for (const edit of ordered.reverse()) {
		result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
	}
	if (result === content) throwNoOp(undefined, { content, offset: lastMatchOffset });
	noOpByPath.delete(context.path);
	context.notes?.push(...recoveryNotes, ...deletionNotes.values());
	return result;
}

function apply(content: string, input: string, context: SloppyApplyContext): string {
	try {
		return applyOperations(content, input, context);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		let message = error.message;
		if (
			!message.includes("Current file content near the closest match (no re-read needed):") &&
			!/\bNear line \d+:/u.test(message) &&
			!message.includes("Copy-ready corrected operation:") &&
			!message.includes("Copy-ready corrected payload:") &&
			!message.includes("Copy-ready per-selection interpretation:")
		) {
			message += `\nCurrent file content near the closest match (no re-read needed):\n${numberedPreview(content, 0)}`;
		}
		if (!message.includes(ATOMICITY_NOTICE)) message += `\n${ATOMICITY_NOTICE}`;
		throw new Error(message);
	}
}

/** The official sloppy implementation; docs re-skinned to the active marker alphabet. */
export const sloppyVariant: SloppyVariant = { id: "sloppy", description, apply };

/** Lark grammar for constrained decoding, in the active marker alphabet. */
export const sloppyGrammar: string = sloppyGrammarSource;

export interface ExecuteSloppyOptions {
	session: ToolSession;
	/** Payload sections with display paths already workspace-resolved. */
	sections: SloppySection[];
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

interface PreparedSloppySection {
	path: string;
	absolutePath: string;
	rawContent: string;
	bom: string;
	originalEnding: "\n" | "\r\n";
	normalizedContent: string;
	newContent: string;
	notes: string[];
}

/**
 * Execute a sloppy payload against its `[path]` sections. Hashline-style
 * all-or-nothing: every section is applied in memory first; a failure in any
 * section means no file is written. Mirrors `executeReplace`'s per-file
 * lifecycle (plan-mode guard, BOM/EOL preservation, LSP writethrough, diff
 * details); {@link sloppyVariant} owns payload parsing and matching.
 */
export async function executeSloppy(
	options: ExecuteSloppyOptions,
): Promise<AgentToolResult<EditToolDetails, SloppyParams>> {
	const { session, sections, signal, batchRequest, writethrough, beginDeferredDiagnosticsForPath } = options;
	const multiFile = sections.length > 1;

	// Phase 1 — preflight every section in memory; nothing is written unless all succeed.
	const prepared: PreparedSloppySection[] = [];
	for (const section of sections) {
		// Models copy read-tool selectors into paths (`file.ts:23`, `file.ts:grep=x`).
		// When the authored path is missing but the selector-less base exists, edit the base.
		let path = section.path;
		let absolutePath = resolvePlanPath(session, path);
		try {
			await Bun.file(absolutePath).stat();
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const stripped = path.replace(/:[^/:]*$/, "");
			if (stripped && stripped !== path) {
				const strippedAbsolute = resolvePlanPath(session, stripped);
				try {
					await Bun.file(strippedAbsolute).stat();
					path = stripped;
					absolutePath = strippedAbsolute;
				} catch (strippedError) {
					if (!isEnoent(strippedError)) throw strippedError;
				}
			}
		}

		enforcePlanModeWrite(session, path);

		const rawContent = await readEditFileText(absolutePath, path);
		const { bom, text: fileText } = stripBom(rawContent);
		const originalEnding = detectLineEnding(fileText);
		const normalizedContent = normalizeToLF(fileText);

		const notes: string[] = [];
		let newContent: string;
		try {
			newContent = sloppyVariant.apply(normalizedContent, normalizeToLF(section.body), { path, notes });
		} catch (error) {
			if (!(error instanceof Error) || !multiFile) throw error;
			throw new Error(`[${path}]: ${error.message}\nNo files were modified — sections apply atomically.`);
		}
		if (newContent === normalizedContent) {
			throw new Error(`Edits to ${path} resulted in no changes being made.`);
		}
		prepared.push({ path, absolutePath, rawContent, bom, originalEnding, normalizedContent, newContent, notes });
	}

	// Phase 2 — write every prepared section; only the last write flushes the LSP batch.
	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];
	let firstChangedLine: number | undefined;
	for (let index = 0; index < prepared.length; index++) {
		const entry = prepared[index];
		const isLast = index === prepared.length - 1;
		const sectionBatch: LspBatchRequest | undefined = batchRequest
			? { id: batchRequest.id, flush: isLast && batchRequest.flush }
			: undefined;
		const finalContent = await serializeEditFileText(
			entry.absolutePath,
			entry.path,
			entry.bom + restoreLineEndings(entry.newContent, entry.originalEnding),
		);

		// Route through ACP bridge when available; skips internal artifacts.
		let diagnostics: FileDiagnosticsResult | undefined;
		if (await routeWriteThroughBridge(session, entry.path, entry.absolutePath, finalContent, signal)) {
			// bridge handled the write; diagnostics not available via writethrough
		} else {
			diagnostics = await writethrough(
				entry.absolutePath,
				finalContent,
				signal,
				Bun.file(entry.absolutePath),
				sectionBatch,
				dst => (dst === entry.absolutePath ? beginDeferredDiagnosticsForPath(entry.absolutePath) : undefined),
			);
			invalidateFsScanAfterWrite(entry.absolutePath);
		}

		const diffResult = generateDiffString(entry.normalizedContent, entry.newContent, undefined, { path: entry.path });
		const meta = outputMeta()
			.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
			.get();
		firstChangedLine ??= diffResult.firstChangedLine;
		contentTexts.push(
			entry.notes.length > 0
				? `Successfully edited ${entry.path}.\n${entry.notes.join("\n")}`
				: `Successfully edited ${entry.path}.`,
		);
		perFileResults.push({
			path: entry.absolutePath,
			diff: diffResult.diff,
			firstChangedLine: diffResult.firstChangedLine,
			diagnostics,
			meta,
			oldText: entry.rawContent,
			newText: finalContent,
		});
	}

	if (!multiFile) {
		const only = perFileResults[0];
		return {
			content: [{ type: "text", text: contentTexts[0] }],
			details: pruneOversizedEditSnapshots({
				diff: only.diff,
				path: only.path,
				firstChangedLine: only.firstChangedLine,
				diagnostics: only.diagnostics,
				meta: only.meta,
				oldText: only.oldText,
				newText: only.newText,
			}),
		};
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: pruneOversizedEditSnapshots({
			diff: perFileResults
				.map(entry => entry.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine,
			perFileResults,
		}),
	};
}
