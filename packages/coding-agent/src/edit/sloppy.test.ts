import { describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import {
	computeSloppySectionDiff,
	executeSloppy,
	SLOPPY_MARKERS,
	splitSloppySections,
	sloppyVariant as variant,
} from "./sloppy";

const context = { path: "src/example.ts" };
const M = SLOPPY_MARKERS;
const esc = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function operation(pattern: string, rewrite: string): string {
	return `${M.open}\n${pattern}\n${M.put}\n${rewrite}`;
}

function inlineOperation(pattern: string, all = false): string {
	return `${M.open}${all ? "*" : ""}\n${pattern}`;
}

describe("sloppy v8", () => {
	test("replaces only the selected token and preserves outside gaps", () => {
		const content = "const timeout = readConfig().timeout ?? 1000;\nrun(timeout);\n";
		const input = operation("timeout = …⟪1000⟫…\nrun(timeout)", "5000");

		expect(variant.apply(content, input, context)).toBe(
			"const timeout = readConfig().timeout ?? 5000;\nrun(timeout);\n",
		);
	});

	test("applies inline replacements to each named selection", () => {
		const content = "const timeout = 1000;\nconst retries = 3;\n";
		const input = inlineOperation("const timeout = ⟪1000│5000⟫;\nconst retries = ⟪3│5⟫;");

		expect(variant.apply(content, input, context)).toBe("const timeout = 5000;\nconst retries = 5;\n");
	});

	test("re-emits selected gaps from an inline replacement", () => {
		const content = "const value = oldCall(options);\nreport(value);\n";
		const input = inlineOperation("const value = ⟪oldCall(…)│newCall(…) ?? fallback⟫;\nreport(value)");

		expect(variant.apply(content, input, context)).toBe(
			"const value = newCall(options) ?? fallback;\nreport(value);\n",
		);
	});

	test("applies inline insertion and deletion as independent operations", () => {
		const content = "const timeout = 5000;\nconst debug = true;\nrun();\n";
		const input = [
			inlineOperation("const timeout = 5000;\n⟪│\nconst retries = 3;⟫"),
			inlineOperation("⟪const debug = true;│⟫"),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("const timeout = 5000;\nconst retries = 3;\nrun();\n");
	});

	test("applies an inline all-match replacement", () => {
		const content = "logger.debug(first);\nlogger.debug(second);\n";

		expect(variant.apply(content, inlineOperation("logger.⟪debug│trace⟫(", true), context)).toBe(
			"logger.trace(first);\nlogger.trace(second);\n",
		);
	});

	test("reuses an inline deletion register in a later inline insertion", () => {
		const content = "const moved = createMoved();\nbefore();\nafter();\n";
		const input = [
			inlineOperation("⟪const moved = createMoved();│⟫"),
			inlineOperation("before();\n⟪│\n»1\n⟫\nafter();"),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("before();\nconst moved = createMoved();\nafter();\n");
	});

	test("ignores a stray ⟫ terminator after the mistyped ⟫ separator", () => {
		const content = [
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = contextPercentDisplay;",
			"    } else {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    }",
			"",
		].join("\n");
		const input = [
			M.open,
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = contextPercentDisplay;",
			"    } else {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"⟫",
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    } else {",
			"      contextPercentStr = contextPercentDisplay;",
			"⟫",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			[
				"    } else if (contextPercentValue > 70) {",
				"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
				"    } else {",
				"      contextPercentStr = contextPercentDisplay;",
				"    }",
				"",
			].join("\n"),
		);
	});

	test("treats a lone balanced ⟫ line as the mistyped rewrite separator", () => {
		const content = [
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = contextPercentDisplay;",
			"    } else {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    }",
			"",
		].join("\n");
		const input = [
			M.open,
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = contextPercentDisplay;",
			"    } else {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    }",
			"⟫",
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    } else {",
			"      contextPercentStr = contextPercentDisplay;",
			"    }",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			[
				"    } else if (contextPercentValue > 70) {",
				"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
				"    } else {",
				"      contextPercentStr = contextPercentDisplay;",
				"    }",
				"",
			].join("\n"),
		);
	});

	test("drops an echoed literal before an inline selection", () => {
		const content = [
			"const newlineIndex = stdinBuffer.indexOf('n');",
			"if (enwlineIndex === -1) return;",
			"const line = stdinBuffer.slice(0, enwlineIndex).trim();",
			"",
		].join("\n");

		expect(variant.apply(content, inlineOperation("enwlineIndex⟪enwlineIndex│newlineIndex⟫", true), context)).toBe(
			content.replaceAll("enwlineIndex", "newlineIndex"),
		);
	});

	test("drops an echoed anchor line before a deletion selection", () => {
		const content = ["function parse(value: unknown) {", "// exact replacement", "  return value;", "}", ""].join(
			"\n",
		);
		const input = inlineOperation("// exact replacement\n⟪// exact replacement\n│⟫");

		expect(variant.apply(content, input, context)).toBe(
			["function parse(value: unknown) {", "  return value;", "}", ""].join("\n"),
		);
	});

	test("still deletes one of two adjacent duplicate lines without echo dedup", () => {
		const content = ["reportStatus();", "reportStatus();", "finish();", ""].join("\n");
		const input = inlineOperation("reportStatus();\n⟪reportStatus();\n│⟫");

		expect(variant.apply(content, input, context)).toBe(["reportStatus();", "finish();", ""].join("\n"));
	});

	test("hands back a fill-in skeleton for a truncated »N rewrite without echoing the broken payload", () => {
		const content = "const first = enwlineIndex;\n";
		let message = "";

		try {
			variant.apply(content, `${M.open}*\nenwlineIndex\n${M.put}1`, context);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toMatch(
			/reads as the » separator, leaving REWRITE empty[\s\S]*«\*\nenwlineIndex\n»\n<final text>/,
		);
		expect(message).not.toContain(`enwlineIndex\n${M.put}1`);
	});

	test("treats every lone »N separator as » across a multi-op payload", () => {
		const content = ["const first = avlue;", "report(avlue.models);", "check(typeof avlue);", ""].join("\n");
		const input = [
			`${M.open}\nconst first = avlue;\n${M.put}1\nconst first = value;`,
			`${M.open}\nreport(avlue.models);\n${M.put}1\nreport(value.models);`,
			`${M.open}\ncheck(typeof avlue);\n${M.put}1\ncheck(typeof value);`,
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(content.replaceAll("avlue", "value"));
	});

	test("treats a lone self-referencing »N after MATCH as the rewrite separator", () => {
		const content = "const first = avlue;\nconst second = avlue;\n";
		const input = `${M.open}*\navlue\n${M.put}1\nvalue`;

		expect(variant.apply(content, input, context)).toBe("const first = value;\nconst second = value;\n");
	});

	test("ignores a trailing self-referencing »N after an inline operation", () => {
		const content = "  switch (reason) {\n    case 'pause_turn':\n      return 'stop';\n  }\n";
		const input = `${M.open}\n  switch (reason) {\n    ⟪case 'pause_turn':│case 'end_turn':\n    case 'pause_turn':⟫\n${M.put}1`;

		expect(variant.apply(content, input, context)).toBe(
			"  switch (reason) {\n    case 'end_turn':\n    case 'pause_turn':\n      return 'stop';\n  }\n",
		);
	});

	test("strips a bare // annotation line from the top of a REWRITE", () => {
		const content = [
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = contextPercentDisplay;",
			"    } else {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    }",
			"",
		].join("\n");
		const rewrite = [
			"//",
			"    } else if (contextPercentValue > 70) {",
			"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
			"    } else {",
			"      contextPercentStr = contextPercentDisplay;",
			"    }",
		].join("\n");
		const pattern = content.trimEnd();

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			[
				"    } else if (contextPercentValue > 70) {",
				"      contextPercentStr = theme.fg('warning', contextPercentDisplay);",
				"    } else {",
				"      contextPercentStr = contextPercentDisplay;",
				"    }",
				"",
			].join("\n"),
		);
	});

	test("keeps a worded comment line at the top of a REWRITE", () => {
		const content = "return cached;\n";

		expect(variant.apply(content, operation("return cached;", "// Fast path\nreturn cached;"), context)).toBe(
			"// Fast path\nreturn cached;\n",
		);
	});

	test("relocates an anchored selection line even when it would fuzzy-match elsewhere", () => {
		const content = [
			"function fillRandomBytes(bytes) {",
			"  if (globalThis.crypto.getRandomValues) {",
			"    globalThis.crypto?.getRandomValues(bytes);",
			"  }",
			"}",
			"",
		].join("\n");
		const input = [
			inlineOperation(
				"  if (globalThis.crypto.getRandomValues) {\n⟪globalThis.crypto.getRandomValues│globalThis.crypto?.getRandomValues⟫",
			),
			inlineOperation(
				"    globalThis.crypto?.getRandomValues(bytes);\n⟪globalThis.crypto?.getRandomValues│globalThis.crypto.getRandomValues⟫",
			),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			[
				"function fillRandomBytes(bytes) {",
				"  if (globalThis.crypto?.getRandomValues) {",
				"    globalThis.crypto.getRandomValues(bytes);",
				"  }",
				"}",
				"",
			].join("\n"),
		);
	});

	test("relocates a selection-only line into its echoed anchor line", () => {
		const content = "      .run(...materializedStateValues(createEmptyMaterializedState(), options.sessionId));\n";
		const input = inlineOperation(
			"      .run(...materializedStateValues(createEmptyMaterializedState(), options.sessionId));\n      ⟪materializedStateValues(createEmptyMaterializedState(), options.sessionId)│materializedStateValues(options.sessionId, createEmptyMaterializedState())⟫",
		);

		expect(variant.apply(content, input, context)).toBe(
			"      .run(...materializedStateValues(options.sessionId, createEmptyMaterializedState()));\n",
		);
	});

	test("drops an echoed anchor line above an embedded selection", () => {
		const content = "    if (entryRow)\n      throw invalidSession(entryId);\n";
		const input = inlineOperation("    if (entryRow)\n    if (⟪entryRow│!entryRow⟫)");

		expect(variant.apply(content, input, context)).toBe("    if (!entryRow)\n      throw invalidSession(entryId);\n");
	});

	test("trims a boundary character double-typed between literal and selection", () => {
		const content = "  if (globalThis.crypto.? .getRandomValues) {\n    globalThis.crypto.getRandomValues(bytes);\n";
		const input = inlineOperation("  if (globalThis.crypto.⟪.? .get│?.get⟫RandomValues) {");

		expect(variant.apply(content, input, context)).toBe(
			"  if (globalThis.crypto.?.getRandomValues) {\n    globalThis.crypto.getRandomValues(bytes);\n",
		);
	});

	test("treats a sole trailing empty inline selection as whole-match deletion", () => {
		const content = [
			"  prepare();",
			"",
			"  const parseAnsiRgb = (ansi: string): [number, number, number] | null => {",
			"    const match = ansi.match(/x/);",
			"    return match ? [1, 2, 3] : null;",
			"  };",
			"",
			"  run();",
			"",
		].join("\n");
		const input = inlineOperation(
			[
				"  const parseAnsiRgb = (ansi: string): [number, number, number] | null => {",
				"    const match = ansi.match(/x/);",
				"    return match ? [1, 2, 3] : null;",
				"  };",
				"⟪│⟫",
			].join("\n"),
		);

		expect(variant.apply(content, input, context)).toBe(["  prepare();", "", "  run();", ""].join("\n"));
	});

	test("keeps a genuine empty inline insertion anchored to a neighbor line as a no-op error", () => {
		const content = "before();\nafter();\n";

		expect(() => variant.apply(content, inlineOperation("⟪│⟫before();"), context)).toThrow(/makes no change/);
	});

	test("collapses a duplicated block when the rewrite equals the match", () => {
		const block = "  await db.exec(`\nCREATE TABLE IF NOT EXISTS migrations (\n\tid TEXT PRIMARY KEY\n);\n`);";
		const content = `async function ensureMigrationsTable() {\n${block}\n\n${block}\n}\n`;
		const input = operation(`${block}\n}`, `${block}\n}`);

		expect(variant.apply(content, input, context)).toBe(`async function ensureMigrationsTable() {\n${block}\n}\n`);
	});

	test("applies a pattern-only block as the delete half of a move", () => {
		const block = [
			"  const parseAnsiRgb = (ansi: string): [number, number, number] | null => {",
			"    return null;",
			"  };",
		].join("\n");
		const content = `  const first = 0;\n\n${block}\n\n  const other = 1;\n\n  const getContrast = () => 2;\n`;
		const input = [
			`${M.open}\n${block}`,
			`${M.open}\n  const getContrast = () => 2;\n${M.put}\n${block}\n\n  const getContrast = () => 2;`,
		].join("\n");
		const notes: string[] = [];

		expect(variant.apply(content, input, { path: context.path, notes })).toBe(
			`  const first = 0;\n\n  const other = 1;\n\n${block}\n\n  const getContrast = () => 2;\n`,
		);
		expect(notes.join("\n")).toContain("move deletion");
	});

	test("never adopts a gap-only remainder as rewrite text", () => {
		const content = [
			"  const getContrastVsBlack = (colorName: string): string => {",
			"    const ansi = theme.getFgAnsi(colorName);",
			"    return ansi;",
			"  };",
			"",
		].join("\n");
		const input = `${M.open}\n  const getContrastVsBlack = (colorName: string): string => {\n…`;

		expect(() => variant.apply(content, input, context)).toThrow(/needs »/);
	});

	test("still rejects a pattern-only block no other operation re-emits", () => {
		const content = "  const kept = 1;\n  const alpha = compute();\n  const beta = alpha + 1;\n";
		const input = `${M.open}\n  const alpha = compute();\n  const beta = alpha + 1;`;

		expect(() => variant.apply(content, input, context)).toThrow(/needs »/);
	});

	test("reports deletions in apply notes", () => {
		const content = "keep();\ndebugLog(request);\nfinish();\n";
		const notes: string[] = [];

		expect(variant.apply(content, operation("debugLog(request);", ""), { path: context.path, notes })).toBe(
			"keep();\nfinish();\n",
		);
		expect(notes.join("\n")).toMatch(/operation 1 deleted 1 line/i);
	});

	test("gap-joins listed-only lines that are not consecutive", () => {
		const content = [
			"      if (enwlineIndex === -1) {",
			"        return;",
			"      }",
			"      const line = stdinBuffer.slice(0, enwlineIndex).trim();",
			"      stdinBuffer = stdinBuffer.slice(enwlineIndex + 1);",
			"",
		].join("\n");
		const input = inlineOperation(
			[
				"      if (⟪enwlineIndex│newlineIndex⟫ === -1) {",
				"      const line = stdinBuffer.slice(0, ⟪enwlineIndex│newlineIndex⟫).trim();",
				"      stdinBuffer = stdinBuffer.slice(⟪enwlineIndex│newlineIndex⟫ + 1);",
			].join("\n"),
			true,
		);

		expect(variant.apply(content, input, context)).toBe(content.replaceAll("enwlineIndex", "newlineIndex"));
	});

	test("names identical inline sides in the no-op error", () => {
		const content = "const flag = a || b;\n";

		expect(() => variant.apply(content, inlineOperation("const flag = ⟪a || b│a || b⟫;"), context)).toThrow(
			/identical ⟪current│desired⟫ sides never change the file[\s\S]*do not drop the operation/,
		);
	});

	test("drops a » rewrite that restates an inline replacement's result", () => {
		const content = "const value = oldValue;\nconst other = keep;\n";
		const notes: string[] = [];
		const input = `${inlineOperation("const value = ⟪oldValue│newValue⟫;")}\n${M.put}\nconst value = newValue;`;

		expect(variant.apply(content, input, { path: context.path, notes })).toBe(
			"const value = newValue;\nconst other = keep;\n",
		);
		expect(notes.join("\n")).toMatch(/operation 1 combined [\s\S]* REWRITE only restated the inline result/);
	});

	test("drops a » rewrite that only echoes the desired sides", () => {
		const content = "url = https://a.example/repo.git\n";
		const input = `${inlineOperation("url = ⟪https://a.example/repo.git│https://b.example/repo.git⟫")}\n${M.put}\nhttps://b.example/repo.git`;

		expect(variant.apply(content, input, context)).toBe("url = https://b.example/repo.git\n");
	});

	test("drops an empty » rewrite trailing an inline replacement", () => {
		const content = "const value = oldValue;\n";
		const input = `${inlineOperation("const value = ⟪oldValue│newValue⟫;")}\n${M.put}`;

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\n");
	});

	test("applies a diverging » rewrite as final text over the inline current sides", () => {
		const content = "const value = oldValue;\nconst other = keep;\n";
		const notes: string[] = [];
		const input = `${inlineOperation("const value = ⟪oldValue│newValue⟫;")}\n${M.put}\nconst value = newValue; // updated\nconst added = 1;`;

		expect(variant.apply(content, input, { path: context.path, notes })).toBe(
			"const value = newValue; // updated\nconst added = 1;\nconst other = keep;\n",
		);
		expect(notes.join("\n")).toMatch(/operation 1 combined [\s\S]* applied as the final text/);
	});

	test("rejects mixed inline and bare selections", () => {
		const content = "const value = oldValue;\nconst other = oldOther;\n";

		expect(() =>
			variant.apply(
				content,
				inlineOperation("const value = ⟪oldValue│newValue⟫;\nconst other = ⟪oldOther⟫;"),
				context,
			),
		).toThrow(/mixes inline and bare selections/);
	});

	test("substitutes multiple selections positionally when REWRITE has one line per selection", () => {
		const content = [
			"while (true) {",
			"  const newlineIndex = stdinBuffer.indexOf('\\n');",
			"  if (enwlineIndex === -1) {",
			"    return;",
			"  }",
			"  const line = stdinBuffer.slice(0, enwlineIndex).trim();",
			"  stdinBuffer = stdinBuffer.slice(enwlineIndex + 1);",
			"  if (!line) continue;",
			"}",
			"",
		].join("\n");
		const input = operation(
			[
				"  if (⟪enwlineIndex⟫ === -1) {",
				"    return;",
				"  }",
				"  const line = stdinBuffer.slice(0, ⟪enwlineIndex⟫).trim();",
				"  stdinBuffer = stdinBuffer.slice(⟪enwlineIndex⟫ + 1);",
			].join("\n"),
			"newlineIndex\nnewlineIndex\nnewlineIndex",
		);

		expect(variant.apply(content, input, context)).toBe(content.replaceAll("enwlineIndex", "newlineIndex"));
	});

	test("uses whole-line ellipses as positional separators when the pattern has no gaps", () => {
		const content = ["if (avlue === first) use(avlue);", "const second = avlue;", ""].join("\n");
		const pattern = ["if (⟪avlue⟫ === first) use(⟪avlue⟫);", "const second = ⟪avlue⟫;"].join("\n");

		expect(variant.apply(content, operation(pattern, "value\n…\nvalue\n…\nvalue"), context)).toBe(
			content.replaceAll("avlue", "value"),
		);
	});

	test("supports multi-line positional groups separated by whole-line ellipses", () => {
		const content = "const first = oldA;\nconst second = oldB;\n";
		const pattern = "const first = ⟪oldA⟫;\nconst second = ⟪oldB⟫;";
		const rewrite = "computeA(\n  input,\n)\n…\ncomputeB(\n  input,\n)";

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			"const first = computeA(\n  input,\n);\nconst second = computeB(\n  input,\n);\n",
		);
	});

	test("fails closed on whole-line rewrite ellipses when a multi-selection pattern has gaps", () => {
		const content = "first oldA extra\nsecond oldB\nthird oldC\n";
		const pattern = "first ⟪oldA⟫…\nsecond ⟪oldB⟫\nthird ⟪oldC⟫";
		const input = operation(pattern, "newA\n…\nnewC");

		expect(() => variant.apply(content, input, context)).toThrow(
			/has 3 selections, but REWRITE proves neither positional substitution nor whole-span replacement/,
		);
	});

	test("allows proven whole-span replacement for multiple selections", () => {
		const content = "if (oldA) {\n  keep();\n  return oldB;\n}\n";
		const pattern = "if (⟪oldA⟫) {\n  keep();\n  return ⟪oldB⟫;";
		const rewrite = "if (newA) {\n  keep();\n  return newB;";

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			"if (newA) {\n  keep();\n  return newB;\n}\n",
		);
	});

	test("fails closed when a multi-selection rewrite proves neither interpretation", () => {
		const content = "const pair = oldA + oldB;\n";
		const input = operation("const pair = ⟪oldA⟫ + ⟪oldB⟫;", "newValue");

		expect(() => variant.apply(content, input, context)).toThrow(
			/Copy-ready per-selection interpretation:[\s\S]*Copy-ready whole-span interpretation:[\s\S]*No operations were applied — ops apply atomically/,
		);
	});

	test("re-emits selected gaps positionally without retyping their spans", () => {
		const content = [
			"function loadUser(id: string) {",
			"  const cached = cache.get(id);",
			"  if (cached) return cached;",
			"  const user = legacyStore.read(id);",
			"  return user;",
			"}",
			"",
		].join("\n");
		const pattern = "loadUser(…\n⟪const cached = …\nconst user = legacyStore.read(…);\nreturn user;⟫\n…}";
		const rewrite = "const cached = …\nconst user = await database.users.read(…);\nreturn user;";

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			[
				"function loadUser(id: string) {",
				"  const cached = cache.get(id);",
				"  if (cached) return cached;",
				"  const user = await database.users.read(id);",
				"  return user;",
				"}",
				"",
			].join("\n"),
		);
	});

	test("allows zero rewrite gaps to replace a selection containing gaps", () => {
		const content = "function choose() {\n  if (legacy) {\n    return oldValue;\n  }\n}\n";
		const pattern = "choose() …\n⟪if (legacy) {…\nreturn oldValue;…\n}⟫\n…}";

		expect(variant.apply(content, operation(pattern, "return newValue;"), context)).toBe(
			"function choose() {\n  return newValue;\n}\n",
		);
	});

	test("preserves a large region outside a tiny selection", () => {
		const middle = Array.from({ length: 30 }, (_, index) => `  step${index}();`).join("\n");
		const content = `class ReportBuilder {\n${middle}\n  render(legacyFormatter);\n  finalize(report);\n}\n`;
		const pattern = "class ReportBuilder …\nrender(…⟪legacyFormatter⟫…\nfinalize(";

		expect(variant.apply(content, operation(pattern, "streamingFormatter"), context)).toBe(
			content.replace("legacyFormatter", "streamingFormatter"),
		);
	});

	test("inserts at a single-marker point and adopts tab indentation", () => {
		const content = "function dispatch(request: Request) {\n\treturn send(request);\n}\n";
		const pattern = "function dispatch(…\n⟪⟫return send(request);";

		expect(variant.apply(content, operation(pattern, "validate(request);"), context)).toBe(
			"function dispatch(request: Request) {\n\tvalidate(request);\n\treturn send(request);\n}\n",
		);
	});

	test("keeps a same-line insertion inline", () => {
		const content = "const value = compute(input);\nreport(value);\n";
		const pattern = "const value = …⟪⟫compute(input)…\nreport(value)";

		expect(variant.apply(content, operation(pattern, "await "), context)).toBe(
			"const value = await compute(input);\nreport(value);\n",
		);
	});

	test("deletes a selected whole line including indentation and newline", () => {
		const content = "function runTask() {\n  prepare();\n  debugLog(request);\n  return result;\n}\n";
		const pattern = "runTask(…\n⟪debugLog(request);⟫…\nreturn result";

		expect(variant.apply(content, operation(pattern, ""), context)).toBe(
			"function runTask() {\n  prepare();\n  return result;\n}\n",
		);
	});

	test("applies a non-overlapping batch and accepts an EOF transport newline", () => {
		const content = "const status = oldStatus;\nreport(status);\ndebugLog(status);\nfinish(status);\n";
		const first = operation("const status …⟪oldStatus⟫…\nreport(status)", "newStatus");
		const second = operation("report(status)…\n⟪debugLog(status);⟫…\nfinish(status)", "");

		expect(variant.apply(content, `${first}\n${second}\n`, context)).toBe(
			"const status = newStatus;\nreport(status);\nfinish(status);\n",
		);
	});

	test("checks ordered-tuple uniqueness before choosing a match", () => {
		const content = [
			"function first() {",
			"  return value;",
			"  audit();",
			"}",
			"function second() {",
			"  return value;",
			"  audit();",
			"}",
			"",
		].join("\n");
		const input = operation("function …\n⟪return value;⟫…\naudit();", "return nextValue;");

		expect(() => variant.apply(content, input, context)).toThrow(
			new RegExp(
				String.raw`ambiguous: 2 ordered tuples match[\s\S]*retry every match:\n${esc(M.open)}\*[\s\S]*Add context that only the intended match has`,
			),
		);
	});

	test("ambiguity retries carry a distinguishing context line, not an ordinal", () => {
		const content = [
			"function first() {",
			"  return value;",
			"  audit();",
			"}",
			"function second() {",
			"  return value;",
			"  audit();",
			"}",
			"",
		].join("\n");
		let message = "";

		try {
			variant.apply(content, operation("⟪return value;⟫…\naudit();", "return nextValue;"), context);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		// The later match gets a leading anchor; the earlier one has nothing
		// unique above it, so it gets a trailing anchor instead. Both resolve uniquely.
		expect(message).toContain("function second() {…\n⟪return value;⟫");
		expect(message).toContain("audit();\n…\nfunction second() {");
		// And the suggested payload is directly applicable.
		expect(
			variant.apply(
				content,
				operation("function second() {…\n⟪return value;⟫…\naudit();", "return nextValue;"),
				context,
			),
		).toBe(
			[
				"function first() {",
				"  return value;",
				"  audit();",
				"}",
				"function second() {",
				"  return nextValue;",
				"  audit();",
				"}",
				"",
			].join("\n"),
		);
	});

	test("rejects a numbered opener and names the two valid openers", () => {
		const content = "function first() {\n  return value;\n}\n";
		const input = `${M.open}2\nreturn value;\n${M.put}\nreturn nextValue;`;

		expect(() => variant.apply(content, input, context)).toThrow(new RegExp(`${esc(M.open)}2 is not a valid opener`));
	});

	test("applies the all-match opener to every match with one identical rewrite", () => {
		const content = "const first = avlue;\nconst second = avlue;\nconst third = avlue;\n";
		const input = `${M.open}*\n= ⟪avlue⟫;\n${M.put}\nvalue`;

		expect(variant.apply(content, input, context)).toBe(
			"const first = value;\nconst second = value;\nconst third = value;\n",
		);
	});

	test("reports zero matches for the all-match opener without guessing", () => {
		const content = "const value = presentValue;\n";
		const input = `${M.open}*\n= ⟪missingValue⟫;\n${M.put}\nnextValue`;

		expect(() => variant.apply(content, input, context)).toThrow(new RegExp(`${esc(M.open)}\\* found 0 matches`));
	});

	test("diagnoses individually ordered but non-consecutive MATCH lines", () => {
		const content = [
			"const entries = source",
			"  ? avlue",
			"  : typeof value === 'object' &&",
			"      Array.isArray(value.models)",
			"    ? avlue.models",
			"    : typeof avlue === 'object'",
			"",
		].join("\n");
		const input = operation(
			"  ? avlue\n    ? avlue.models\n    : typeof avlue === 'object'",
			"  ? value\n    ? value.models\n    : typeof value === 'object'",
		);

		expect(() => variant.apply(content, input, context)).toThrow(
			/your lines match individually at lines 2, 5, 6 but are not consecutive[\s\S]*\? avlue\n…\n {4}\? avlue\.models\n…\n {4}: typeof avlue[\s\S]*replaces the whole span lines 2-6, including the skipped lines — re-emit kept gaps with …/,
		);
	});

	test("accepts a small fragment typo only when the fuzzy tuple is unique", () => {
		const content = "const result = calculateValue(input);\nreport(result);\n";
		const pattern = "const result = …⟪calculateVale(input)⟫…\nreport(result)";

		expect(variant.apply(content, operation(pattern, "calculateFast(input)"), context)).toBe(
			"const result = calculateFast(input);\nreport(result);\n",
		);
	});

	test("normalizes Unicode punctuation in sparse literals", () => {
		const content = 'throw new Error("not-ready");\nhandleFailure(error);\n';
		const pattern = "throw new Error(⟪“not—ready”⟫);…\nhandleFailure(";

		expect(variant.apply(content, operation(pattern, '"ready"'), context)).toBe(
			'throw new Error("ready");\nhandleFailure(error);\n',
		);
	});

	test("maps provided rewrite gaps positionally and drops omitted later gaps", () => {
		const content = "function load() {\n  const a = first();\n  const b = legacy(id);\n}\n";
		const pattern = "load() …\n⟪const a = …\nconst b = legacy(…);⟫\n…}";

		expect(variant.apply(content, operation(pattern, "const a = …\nconst b = modern(id);"), context)).toBe(
			"function load() {\n  const a = first();\n  const b = modern(id);\n}\n",
		);
	});

	test("accepts marker-free verbatim replacement", () => {
		const content = "const timeout = 1000;\nrun(timeout);\n";
		const pattern = "const timeout = 1000;";

		expect(variant.apply(content, operation(pattern, "const timeout = 5000;"), context)).toBe(
			"const timeout = 5000;\nrun(timeout);\n",
		);
	});

	test("accepts a unique single-fragment sparse selection", () => {
		const content = "const value = oldValue;\n";

		expect(variant.apply(content, operation("⟪oldValue⟫", "nextValue"), context)).toBe("const value = nextValue;\n");
	});

	test("rejects punctuation-only patterns but accepts short identifiers", () => {
		// Punctuation-only anchors match everywhere — still rejected.
		expect(() => variant.apply("if (a) {\n}\n", operation("⟪}⟫", "};"), context)).toThrow(/too generic/);
		// A short identifier is a legitimate anchor when it resolves uniquely.
		expect(variant.apply("const id = 1;\n", operation("⟪id⟫ = 1", "key"), context)).toBe("const key = 1;\n");
	});

	test("reports unmatched literals without guessing", () => {
		const content = "const value = oldValue;\nreport(value);\n";
		const pattern = "const value = …⟪missingValue⟫…\nreport(value)";

		expect(() => variant.apply(content, operation(pattern, "nextValue"), context)).toThrow(/did not match/);
	});

	test("grounds no-match failures with closest current lines and atomic retry guidance", () => {
		const content = [
			"import { fetchCurrent } from './data';",
			"",
			"function load() {",
			"  prepare();",
			"  const result = fetchCurrent();",
			"  audit(result);",
			"  return result;",
			"}",
			"",
			"export { load };",
			"finish();",
			"",
		].join("\n");
		const input = operation(
			"function load() {…\n⟪const result = fetchLegacy();⟫…\nreturn result;\n}",
			"const result = fetchCurrent();",
		);

		expect(() => variant.apply(content, input, context)).toThrow(
			/Failed fragment: "const result = fetchLegacy\(\);" has 0 occurrences\.[\s\S]*Current file content near the closest match \(no re-read needed\):[\s\S]*5: {3}const result = fetchCurrent\(\);[\s\S]*7: {3}return result;[\s\S]*Copy-ready corrected operation:[\s\S]*No operations were applied — ops apply atomically; re-send the full corrected payload\./,
		);
	});

	test("teaches insert intent when MATCH is text the author meant to add", () => {
		const content = ["switch (event.type) {", "  case 'message':", "    handleMessage(event);", "}", ""].join("\n");
		const input = operation("  case 'end_turn':", "  case 'end_turn':\n    finishTurn();");

		expect(() => variant.apply(content, input, context)).toThrow(
			new RegExp(
				String.raw`If you are ADDING this text: match the existing neighbor line it belongs next to, and put the new text in the REWRITE —[\s\S]*${esc(M.open)}\n⟪⟫ {2}case 'message':\n${esc(M.put)}\n {2}case 'end_turn':\n {4}finishTurn\(\);`,
			),
		);
	});

	test("rejects malformed envelopes, marker misuse, and no-op edits", () => {
		const content = "const value = oldValue;\nreport(value);\n";
		const pattern = "const value = …⟪oldValue⟫…\nreport(value)";

		expect(() => variant.apply(content, `${M.open}\n${pattern}`, context)).toThrow(new RegExp(`needs ${esc(M.put)}`));
		expect(() => variant.apply(content, `${operation(pattern, "nextValue")}\n${M.open} end`, context)).toThrow(
			new RegExp(`Operation 2 needs ${esc(M.put)}`),
		);
		expect(() => variant.apply(content, operation(pattern, "⟪oldValue⟫"), context)).toThrow(
			/has selection markers in REWRITE/,
		);
		expect(variant.apply(content, operation(pattern, "next…Value"), context)).toBe(
			"const value = next…Value;\nreport(value);\n",
		);
		expect(() => variant.apply(content, operation(pattern, "oldValue"), context)).toThrow(/makes no change/);
	});

	test("splits a rewrite separator glued to its first content line", () => {
		const content = [
			"function mapStopReason(reason: string) {",
			"  switch (reason) {",
			"    case 'pause_turn':",
			"      return 'stop';",
			"  }",
			"}",
			"",
		].join("\n");
		const input = [
			M.open,
			"function mapStopReason(reason: string) {",
			"  switch (reason) {",
			"⟪⟫    case 'pause_turn':",
			`${M.put}    case 'end_turn':`,
			"    case 'pause_turn':",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			[
				"function mapStopReason(reason: string) {",
				"  switch (reason) {",
				"    case 'end_turn':",
				"    case 'pause_turn':",
				"      return 'stop';",
				"  }",
				"}",
				"",
			].join("\n"),
		);
	});

	test("splits an opener glued to its first match line", () => {
		const content = "const alpha = oldValue;\n";
		const input = `${M.open} const alpha = oldValue;\n${M.put}\nconst alpha = nextValue;`;

		expect(variant.apply(content, input, context)).toBe("const alpha = nextValue;\n");
	});

	test("does not split a register reference glued to extra content", () => {
		expect(() =>
			variant.apply("const value = oldValue;\n", `${M.open}\nconst value = oldValue;\n${M.put}2 extra`, context),
		).toThrow(new RegExp(`Invalid control line "${esc(M.put)}2 extra"`));
	});

	test("accepts the Unicode ellipsis gap", () => {
		const content = "const timeout = readConfig() ?? 1000;\nrun(timeout);\n";

		expect(variant.apply(content, operation("timeout = …⟪1000⟫…\nrun(timeout)", "5000"), context)).toBe(
			"const timeout = readConfig() ?? 5000;\nrun(timeout);\n",
		);
		expect(variant.apply(content, operation("timeout = …⟪1000⟫…\nrun(timeout)", "5000"), context)).toBe(
			"const timeout = readConfig() ?? 5000;\nrun(timeout);\n",
		);
	});

	test("treats rewrite ellipses beyond the capture count as literal", () => {
		const content = "const value = oldCall(options);\nreport(value);\n";
		const pattern = "const value = ⟪oldCall(…);⟫…\nreport(value)";

		expect(variant.apply(content, operation(pattern, "newCall(…) ?? […fallback]"), context)).toBe(
			"const value = newCall(options) ?? […fallback]\nreport(value);\n",
		);
	});

	test("accepts sparse whole-region replacement without selection markers", () => {
		const content = "function read() {\n  prepare();\n  return oldValue;\n}\n";
		const pattern = "function read() {…\nreturn oldValue;…\n}";
		const rewrite = "function read() {\n  return newValue;\n}";

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			"function read() {\n  return newValue;\n}\n",
		);
	});

	test("treats several OLD selections as one whole sparse region", () => {
		const content = "if (ready) {\n  value = first;\n} else {\n  value = second;\n}\n";
		const pattern = "if (ready) {\n  value = ⟪first⟫;\n} else {\n  value = ⟪second⟫;\n}";
		const rewrite = "if (ready) {\n  value = second;\n} else {\n  value = first;\n}";

		expect(variant.apply(content, operation(pattern, rewrite), context)).toBe(
			"if (ready) {\n  value = second;\n} else {\n  value = first;\n}\n",
		);
	});

	test("keeps ambiguous verbatim regions fail-closed", () => {
		const content = "function first() {\n  return value;\n}\nfunction second() {\n  return value;\n}\n";

		expect(() => variant.apply(content, operation("return value;", "return next;"), context)).toThrow(
			/ambiguous: 2 ordered tuples match/,
		);
	});

	test("bounds same-line gaps and aligns a full-line rewrite around the selection", () => {
		const content = [
			"class Terminal {",
			"  private _kittyProtocolActive = true;",
			"  private one = 1;",
			"  private two = 2;",
			"  private three = 3;",
			"}",
			"",
		].join("\n");
		const input = operation("private _kittyProtocolActive = …⟪true⟫…;", "private _kittyProtocolActive = false;");

		expect(variant.apply(content, input, context)).toBe(
			content.replace("_kittyProtocolActive = true", "_kittyProtocolActive = false"),
		);
	});

	test("prefers an exact literal spread over ellipsis gap interpretation", () => {
		const content = [
			"insert.run(first());",
			"update.run(second());",
			"transaction.run(...materializedStateValues(createEmptyMaterializedState(), options.sessionId));",
			"",
		].join("\n");
		const input = operation(
			".run(...materializedStateValues(createEmptyMaterializedState(), options.sessionId));",
			".run(...materializedStateValues(options.sessionId, createEmptyMaterializedState()));",
		);

		expect(variant.apply(content, input, context)).toBe(
			content.replace(
				".run(...materializedStateValues(createEmptyMaterializedState(), options.sessionId));",
				".run(...materializedStateValues(options.sessionId, createEmptyMaterializedState()));",
			),
		);
	});

	test("treats ASCII ellipses inside a template literal as source text", () => {
		const content = [
			"    super(",
			"      'branchSummary',",
			"      ui,",
			"      (spinner) => theme.fg('accent', spinner),",
			"      (text) => theme.fg('muted', text),",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: test fixture contains template literal
			"      `Summarizing branch... (${keyText('app.interrupt')} to cancel)`,",
			"    );",
			"",
		].join("\n");
		const pattern = [
			"super(\u2026",
			"⟪'branchSummary'⟫,\u2026",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: test fixture contains template literal
			"`Summarizing branch... (${keyText('app.interrupt')} to cancel)`,",
			");",
		].join("\n");

		expect(variant.apply(content, operation(pattern, "'branchSummaryNext'"), context)).toBe(
			content.replace("'branchSummary'", "'branchSummaryNext'"),
		);
	});

	test("anchors a missing-fragment preview on the strongest occurring fragment", () => {
		const content = [
			"class MissingTailFactory {}",
			...Array.from({ length: 18 }, (_, index) => `const filler${index} = ${index};`),
			"class BranchSummaryStatusIndicator {",
			"  constructor() {",
			"    super(",
			"      'branchSummary',",
			"      ui,",
			"    );",
			"  }",
			"}",
			"",
		].join("\n");
		const input = operation("super(\n'branchSummary',…\n⟪missingTail();⟫", "nextTail();");
		let message = "";

		try {
			variant.apply(content, input, context);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}

		expect(message).toContain("It broke relative to matched anchor");
		expect(message).toMatch(/Current file content near the closest match \(no re-read needed\):[\s\S]*\d+: +super\(/);
		expect(message).not.toContain("1: class MissingTailFactory");
		expect(message).not.toContain("MissingTailFac");
	});

	test("rejects fuzzy matches that add or remove structural tokens", () => {
		const content = [
			"function parseCatalog(value: unknown) {",
			"  const entries = Array.isArray(value)",
			"    ? avlue",
			"    : undefined;",
			"  if (!entries) throw new Error('missing');",
			"}",
			"",
		].join("\n");
		const wrongBoundary = [
			"function parseCatalog(value: unknown) {",
			"  const entries = Array.isArray(value)",
			"    ? avlue",
			"    : undefined;",
			"}",
		].join("\n");

		expect(() =>
			variant.apply(content, operation(wrongBoundary, wrongBoundary.replace("avlue", "value")), context),
		).toThrow(/did not match/);
	});

	test("strips full-statement envelope echoes around an inner selection", () => {
		const content = "if (enwlineIndex === -1) {\n  return;\n}\n";
		const input = operation("if (…⟪enwlineIndex⟫… === -1) {", "if (newlineIndex === -1) {");

		expect(variant.apply(content, input, context)).toBe("if (newlineIndex === -1) {\n  return;\n}\n");
	});

	test("uniformly shifts a de-indented multiline rewrite to the matched block", () => {
		const content = "function outer() {\n  if (ready) {\n    oldCall();\n    keep();\n  }\n}\n";
		const match = "  if (ready) {\n    oldCall();\n    keep();\n  }";
		const rewrite = "if (ready) {\n  newCall();\n  keep();\n}";

		expect(variant.apply(content, operation(match, rewrite), context)).toBe(
			"function outer() {\n  if (ready) {\n    newCall();\n    keep();\n  }\n}\n",
		);
	});

	test("applies an authored indentation-only replacement verbatim", () => {
		const content = "function run() {\n    const getContrastVsWhite = () => value;\n}\n";
		const input = operation(
			"    const getContrastVsWhite = () => value;",
			"  const getContrastVsWhite = () => value;",
		);

		expect(variant.apply(content, input, context)).toBe(
			"function run() {\n  const getContrastVsWhite = () => value;\n}\n",
		);
	});

	test("grounds no-change errors at the matched region instead of file head", () => {
		const content = [
			"const head = true;",
			"step2();",
			"step3();",
			"step4();",
			"step5();",
			"step6();",
			"step7();",
			"step8();",
			"step9();",
			"step10();",
			"step11();",
			"  const target = currentValue;",
			"step13();",
			"step14();",
		].join("\n");
		let message = "";
		try {
			variant.apply(content, operation("  const target = currentValue;", "  const target = currentValue;"), {
				path: "src/matched-noop.ts",
			});
		} catch (error) {
			if (error instanceof Error) message = error.message;
		}

		expect(message).toContain("12:   const target = currentValue;");
		expect(message).not.toContain("1: const head = true;");
		expect(message).toContain("Indentation-only changes are applied verbatim");
	});

	test("assumes an omitted leading opener for an op-shaped payload", () => {
		const content = "const value = oldValue;\n";
		const input = `const value = oldValue;\n${M.put}\nconst value = newValue;`;

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\n");
	});

	test("strips markdown fences, patch envelopes, and leading blanks", () => {
		const content = "const value = oldValue;\n";
		const input = [
			"",
			"```text",
			"*** Begin Patch",
			M.open,
			"const value = oldValue;",
			M.put,
			"const value = newValue;",
			"*** End Patch",
			"```",
			"",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\n");
	});

	test("strips uniform read line-number prefixes from both blocks", () => {
		const content = "function run() {\n    oldCall();\n}\n";
		const input = [
			M.open,
			"12:function run() {",
			"13:    oldCall();",
			"14:}",
			M.put,
			"12:function run() {",
			"13:    newCall();",
			"14:}",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("function run() {\n    newCall();\n}\n");
	});

	test("ignores copied read metadata and elision rows", () => {
		const content = "const value = oldValue;\n";
		const input = [
			M.open,
			"[Showing lines 10-12 of 40]",
			"const value = oldValue;",
			"[…2ln elided…]",
			M.put,
			"[Showing lines 10-12 of 40]",
			"const value = newValue;",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\n");
	});

	test("recovers unified-diff contamination in REWRITE", () => {
		const content = "const value = oldValue;\n";
		const input = [
			M.open,
			"const value = oldValue;",
			M.put,
			"-const value = oldValue;",
			"+const value = newValue;",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\n");
	});

	test("drops transport-only trailing blank rows at EOF", () => {
		const content = "const value = oldValue;\n";
		const input = `${operation("const value = oldValue;", "const value = newValue;")}\n\n`;

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\n");
	});

	test("strips harmless leading and trailing sparse gaps", () => {
		const content = "before();\nobsolete();\nafter();\n";
		const input = operation("…\n⟪obsolete();⟫\n…", "");

		expect(variant.apply(content, input, context)).toBe("before();\nafter();\n");
	});

	test("moves code with a delete then insertion in one batch", () => {
		const content = [
			"function run() {",
			"  const target = () => 2;",
			"  const helper = () => {",
			"    return 1;",
			"  };",
			"  finish();",
			"}",
			"",
		].join("\n");
		const input = [
			operation("const helper = () => {\n  return 1;\n};", ""),
			operation("⟪⟫const target = () => 2;", `${M.put}1`),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			[
				"function run() {",
				"  const helper = () => {",
				"    return 1;",
				"  };",
				"  const target = () => 2;",
				"  finish();",
				"}",
				"",
			].join("\n"),
		);
	});

	test("trusts authored move indentation when the destination anchor has a different indent", () => {
		const content = [
			"function run() {",
			"    const target = () => 2;",
			"    finish();",
			"",
			"  const helper = () => {",
			"    return 1;",
			"  };",
			"}",
			"",
		].join("\n");
		const input = [
			operation("  const helper = () => {\n    return 1;\n  };", ""),
			operation("  const target = () => 2;", `${M.put}1\n\n  const target = () => 2;`),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			[
				"function run() {",
				"  const helper = () => {",
				"    return 1;",
				"  };",
				"",
				"  const target = () => 2;",
				"    finish();",
				"",
				"}",
				"",
			].join("\n"),
		);
	});
	test("adopts destination indent when an unindented move rewrite repeats its anchor", () => {
		const content = [
			"function cmdTheme() {",
			"  initTheme();",
			"",
			"  const getContrastVsWhite = (colorName: string): string => {",
			"    return colorName;",
			"  };",
			"}",
			"",
		].join("\n");
		const rewrite = [
			"const parseAnsiRgb = (ansi: string): [number, number, number] | null => {",
			"  const match = ansi.match(/38;2;(\\d+);(\\d+);(\\d+)/);",
			"  return match ? [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)] : null;",
			"};",
			"",
			"const getContrastVsWhite = (colorName: string): string => {",
		].join("\n");

		expect(
			variant.apply(
				content,
				operation("const getContrastVsWhite = (colorName: string): string => {", rewrite),
				context,
			),
		).toBe(
			[
				"function cmdTheme() {",
				"  initTheme();",
				"",
				"  const parseAnsiRgb = (ansi: string): [number, number, number] | null => {",
				"    const match = ansi.match(/38;2;(\\d+);(\\d+);(\\d+)/);",
				"    return match ? [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)] : null;",
				"  };",
				"",
				"  const getContrastVsWhite = (colorName: string): string => {",
				"    return colorName;",
				"  };",
				"}",
				"",
			].join("\n"),
		);
	});

	test("treats a lone deletion register as insert-before for a distinct one-line anchor", () => {
		const content = ["const anchor = () => 1;", "const moved = () => {", "  return 2;", "};", ""].join("\n");
		const input = [
			operation("const moved = () => {\n  return 2;\n};", ""),
			operation("const anchor = () => 1;", `${M.put}1`),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			["const moved = () => {", "  return 2;", "};", "", "const anchor = () => 1;", ""].join("\n"),
		);
	});

	test("does not preserve a lone-register anchor already present in the moved block", () => {
		const content = [
			"// setup",
			"const anchor = true;",
			"const moved = () => {",
			"  const anchor = true;",
			"};",
			"",
		].join("\n");
		const input = [
			operation("const moved = () => {\n  const anchor = true;\n};", ""),
			operation(`// setup…\n${M.selectOpen}const anchor = true;${M.selectClose}`, `${M.put}1`),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			["// setup", "const moved = () => {", "  const anchor = true;", "};", ""].join("\n"),
		);
	});

	test("collapses a blank seam only when both sides of a deleted block are blank", () => {
		const surrounded = "before();\n\nconst removed = true;\n\nafter();\n";
		const oneSided = "before();\nconst removed = true;\n\nafter();\n";

		expect(variant.apply(surrounded, operation("const removed = true;", ""), context)).toBe(
			"before();\n\nafter();\n",
		);
		expect(variant.apply(oneSided, operation("const removed = true;", ""), context)).toBe("before();\n\nafter();\n");
	});

	test("rejects self, forward, MATCH, and non-deletion register references", () => {
		const content = "const first = oldFirst;\nconst second = oldSecond;\n";

		expect(() => variant.apply(content, operation("const first = oldFirst;", `${M.put}1`), context)).toThrow(
			/must reference an earlier operation/,
		);
		expect(() =>
			variant.apply(
				content,
				[operation("const first = oldFirst;", `${M.put}2`), operation("const second = oldSecond;", "")].join("\n"),
				context,
			),
		).toThrow(/must reference an earlier operation/);
		expect(() => variant.apply(content, `${M.open}\n${M.put}1\n${M.put}\nnext`, context)).toThrow(
			/valid only in REWRITE/,
		);
		expect(() =>
			variant.apply(
				content,
				[
					operation("const first = oldFirst;", "const first = newFirst;"),
					operation("⟪⟫const second = oldSecond;", `${M.put}1`),
				].join("\n"),
				context,
			),
		).toThrow(/must reference an earlier deletion operation/);
	});

	test("auto-splits a uniquely matching MATCH prefix from an omitted separator", () => {
		const content = "const value = oldValue;\nreport(value);\n";
		const input = `${M.open}\nconst value = oldValue;\nconst value = newValue;`;

		expect(variant.apply(content, input, context)).toBe("const value = newValue;\nreport(value);\n");
	});

	test("accepts evidence-backed alternating MATCH and REWRITE blocks", () => {
		const content = "const first = oldFirst;\nconst second = oldSecond;\n";
		const input = [
			M.open,
			"const first = oldFirst;",
			M.open,
			"const first = newFirst;",
			M.open,
			"const second = oldSecond;",
			M.open,
			"const second = newSecond;",
		].join("\n");

		expect(variant.apply(content, input, context)).toBe("const first = newFirst;\nconst second = newSecond;\n");
	});

	test("does not infer an opener as a separator when both neighboring blocks miss", () => {
		const content = "const value = presentValue;\n";
		const input = `${M.open}\nconst value = missingOld;\n${M.open}\nconst value = missingNew;`;

		expect(() => variant.apply(content, input, context)).toThrow(new RegExp(`needs ${esc(M.put)}`));
	});

	test("keeps an omitted separator error when the prefix match is ambiguous", () => {
		const content = "const value = oldValue;\nconst value = oldValue;\n";
		const input = `${M.open}\nconst value = oldValue;\nconst value = newValue;`;

		expect(() => variant.apply(content, input, context)).toThrow(new RegExp(`needs ${esc(M.put)}`));
	});

	test("treats empty double selection markers as an insertion point", () => {
		const content = "before();\nafter();\n";
		const input = operation("before();\n⟪⟫after();", "inserted();");

		expect(variant.apply(content, input, context)).toBe("before();\ninserted();\nafter();\n");
	});
	test("resolves every batch anchor against the original content", () => {
		const content = ["start();", "const removed = true;", "middle();", "const target = oldValue;", "end();", ""].join(
			"\n",
		);
		const input = [
			operation("const removed = true;", ""),
			operation("middle();", "middleChanged();"),
			operation(
				"start();…\nconst removed = true;…\n⟪const target = oldValue;⟫…\nend();",
				"const target = newValue;",
			),
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			["start();", "middleChanged();", "const target = newValue;", "end();", ""].join("\n"),
		);
	});

	test("rejects overlapping original target spans atomically", () => {
		const content = "const value = oldValue;\n";
		const input = [operation("const value = ⟪oldValue⟫;", "newValue"), operation("⟪oldValue⟫", "newerValue")].join(
			"\n",
		);

		expect(() => variant.apply(content, input, context)).toThrow(
			/Operations 1 and 2 target overlapping original spans/,
		);
		expect(content).toBe("const value = oldValue;\n");
	});

	test("never fuzzy-matches different operator sequences", () => {
		const content = "const shouldRun = left || right;\n";

		expect(() => variant.apply(content, operation("const shouldRun = left && ⟪right⟫;", "next"), context)).toThrow(
			/did not match/,
		);
	});

	test("a no-change match names a fuzzy-near candidate that would change", () => {
		const content = "const first = oldValue;\nconst second = oldValuf;\n";
		const input = operation("⟪oldValue⟫", "oldValue");

		expect(() => variant.apply(content, input, context)).toThrow(
			/Line 2 also matches and WOULD change — target it by adding context unique to it\./,
		);
	});

	test("treats a blank-only replacement as deletion and collapses its seam", () => {
		const content = "before();\n\nconst removed = true;\n\nafter();\n";
		const input = [M.open, "const removed = true;", M.put, "   ", M.open, "after();", M.put, "afterChanged();"].join(
			"\n",
		);

		expect(variant.apply(content, input, context)).toBe("before();\n\nafterChanged();\n");
	});

	test("uses an empty rewrite as a blank line only for an insertion operation", () => {
		const content = "before();\nafter();\n";

		expect(variant.apply(content, operation("before();\n⟪⟫after();", ""), context)).toBe("before();\n\nafter();\n");
	});

	test("allows one punctuation insertion typo for a unique changing candidate", () => {
		const content = "for (let i = 0; i < 100; i--) {\n  run();\n}\n";
		const input = operation("for (let i = 0; i < ⟪100⟫; i--;) {", "10");

		expect(variant.apply(content, input, context)).toBe("for (let i = 0; i < 10; i--) {\n  run();\n}\n");
	});

	test("does not use punctuation tolerance when more than one candidate aligns", () => {
		const content = [
			"for (let i = 0; i < 100; i--) runFirst();",
			"for (let i = 0; i < 100; i--) runSecond();",
			"",
		].join("\n");
		const input = operation("for (let i = 0; i < ⟪100⟫; i--;)", "10");

		expect(() => variant.apply(content, input, context)).toThrow(/did not match/);
	});

	test("escalates the third identical no-op with STOP guidance", () => {
		const noopContext = { path: "src/noop-loop.ts" };
		const content = "const value = currentValue;\n";
		const input = operation("const value = currentValue;", "const value = currentValue;");

		expect(() => variant.apply(content, input, noopContext)).toThrow(/makes no change/);
		expect(() => variant.apply(content, input, noopContext)).toThrow(/makes no change/);
		expect(() => variant.apply(content, input, noopContext)).toThrow(/STOP: identical no-op repeated 3 times/);
	});

	test("correctly maps source spans across multi-byte astral characters (emoji)", () => {
		const file = [
			"fn render_tree() {",
			'\tlet icon = if dir { "📁" } else { "📄" };',
			"}",
			"",
			"#[cfg(test)]",
			"mod tests {",
			"\tuse bytes::Bytes;",
			"\tuse omp_core::Str;",
			"\tuse parking_lot::Mutex;",
			"\tuse smallvec::SmallVec;",
			"\tuse url::Url;",
			"}",
			"",
		].join("\n");
		const input = operation(
			"\tuse bytes::Bytes;\n\tuse omp_core::Str;\n\tuse parking_lot::Mutex;",
			"\tuse bytes::Bytes;\n\tuse omp_core::{Str, sf};\n\tuse parking_lot::Mutex;",
		);
		const result = variant.apply(file, input, context);
		expect(result).toContain("\tuse omp_core::{Str, sf};");
		expect(result).toContain("\tuse smallvec::SmallVec;");
		expect(result).not.toContain("us\tuse");
		expect(result).not.toContain("Mutex;e smallvec");
	});
});

describe("splitSloppySections", () => {
	test("splits a payload into per-file sections", () => {
		const input = `[src/a.ts]\n${M.open}\nold\n${M.put}\nnew\n[src/b.ts]\n${M.open}\nfoo\n${M.put}\nbar`;
		const sections = splitSloppySections(input);
		expect(sections.map(section => section.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(sections[0].body).toContain("old");
		expect(sections[0].body).not.toContain("foo");
		expect(sections[1].body).toContain("bar");
	});

	test("merges repeated sections for the same file in order", () => {
		const input = `[src/a.ts]\n${M.open}\none\n${M.put}\n1\n[src/b.ts]\n${M.open}\ntwo\n${M.put}\n2\n[src/a.ts]\n${M.open}\nthree\n${M.put}\n3`;
		const sections = splitSloppySections(input);
		expect(sections.map(section => section.path)).toEqual(["src/a.ts", "src/b.ts"]);
		const first = sections[0].body;
		expect(first.indexOf("one")).toBeGreaterThanOrEqual(0);
		expect(first.indexOf("three")).toBeGreaterThan(first.indexOf("one"));
	});

	test("keeps header-looking content lines inside their operation", () => {
		// `[content]` is followed by more MATCH text, not an opener — it is code, not a header.
		const input = `[src/a.ts]\n${M.open}\nconst rows =\n[content]\n.flat();\n${M.put}\nconst rows = [content].flat();`;
		const sections = splitSloppySections(input);
		expect(sections).toHaveLength(1);
		expect(sections[0].body).toContain("[content]");
	});

	test("returns empty for a payload without a leading header", () => {
		expect(splitSloppySections(`${M.open}\nold\n${M.put}\nnew`)).toEqual([]);
	});
});

describe("executeSloppy multi-file", () => {
	async function setup(): Promise<{ dir: TempDir; session: ToolSession }> {
		const dir = await TempDir.create("@sloppy-multifile-");
		await Bun.write(dir.join("a.ts"), "const alpha = 1;\n");
		await Bun.write(dir.join("b.ts"), "const beta = 2;\n");
		// Test seam: executeSloppy only reads `cwd` (+ optional plan/bridge hooks) from the session.
		const session = { cwd: dir.absolute() } as unknown as ToolSession;
		return { dir, session };
	}
	const writethrough = async (dst: string, content: string) => {
		await Bun.write(dst, content);
		return undefined;
	};
	const deferred = () => ({ close: () => {} }) as never;

	test("applies sections to multiple files in one call", async () => {
		const { dir, session } = await setup();
		try {
			const result = await executeSloppy({
				session,
				sections: [
					{ path: "a.ts", body: `${M.open}\nconst alpha = ⟪1⟫;\n${M.put}\n10` },
					{ path: "b.ts", body: `${M.open}\nconst beta = ⟪2⟫;\n${M.put}\n20` },
				],
				writethrough,
				beginDeferredDiagnosticsForPath: deferred,
			});
			expect(await Bun.file(dir.join("a.ts")).text()).toBe("const alpha = 10;\n");
			expect(await Bun.file(dir.join("b.ts")).text()).toBe("const beta = 20;\n");
			expect(result.details?.perFileResults).toHaveLength(2);
			const text = result.content?.find(entry => entry.type === "text")?.text ?? "";
			expect(text).toContain("a.ts");
			expect(text).toContain("b.ts");
		} finally {
			await dir.remove();
		}
	});

	test("writes nothing when a later section fails", async () => {
		const { dir, session } = await setup();
		try {
			await expect(
				executeSloppy({
					session,
					sections: [
						{ path: "a.ts", body: `${M.open}\nconst alpha = ⟪1⟫;\n${M.put}\n10` },
						{ path: "b.ts", body: `${M.open}\nthis text is nowhere\n${M.put}\nreplacement` },
					],
					writethrough,
					beginDeferredDiagnosticsForPath: deferred,
				}),
			).rejects.toThrow(/\[b\.ts\]:[\s\S]*sections apply atomically/);
			expect(await Bun.file(dir.join("a.ts")).text()).toBe("const alpha = 1;\n");
		} finally {
			await dir.remove();
		}
	});
});

describe("computeSloppySectionDiff", () => {
	test("returns a diff for an applicable section and an error for a miss", async () => {
		const dir = await TempDir.create("@sloppy-preview-");
		try {
			await Bun.write(dir.join("a.ts"), "const alpha = 1;\n");
			const good = await computeSloppySectionDiff(
				{ path: "a.ts", body: `${M.open}\nconst alpha = ⟪1⟫;\n${M.put}\n10` },
				dir.absolute(),
			);
			expect("diff" in good && good.diff).toContain("const alpha = 10;");
			const bad = await computeSloppySectionDiff(
				{ path: "a.ts", body: `${M.open}\nnowhere\n${M.put}\nx` },
				dir.absolute(),
			);
			expect("error" in bad && bad.error).toContain("did not match");
		} finally {
			await dir.remove();
		}
	});
});

describe("directional selection markers", () => {
	test("throws error on unclosed opening selection marker", () => {
		const content = "const value = oldValue;\nreport(value);\n";
		const input = operation("const value = ⟪oldValue;\nreport(value);", "nextValue");
		expect(() => variant.apply(content, input, context)).toThrow(/unclosed selection marker ⟪; add closing ⟫/);
	});

	test("throws error on unmatched closing selection marker", () => {
		const content = "const value = oldValue;\nreport(value);\n";
		const input = operation("const value = oldValue⟫;\nreport(value);", "nextValue");
		expect(() => variant.apply(content, input, context)).toThrow(
			/unmatched closing selection marker ⟫; add opening ⟪/,
		);
	});

	test("supports empty directional selection ⟪⟫ as insertion point", () => {
		const content = "function run() {\n  finish();\n}\n";
		const input = operation("function run() {\n  ⟪⟫finish();\n}", "start();\n  ");
		expect(variant.apply(content, input, context)).toBe("function run() {\n  start();\n  finish();\n}\n");
	});
});

describe("overlapping operations", () => {
	test("merges overlapping edits that agree on the shared text", () => {
		// Real payload shape: a broad «* rename plus narrower ops covering some
		// of the same matches. Both state the same final text — not a conflict.
		const content = ["const a = avlue;", "const b = avlue.models;", ""].join("\n");
		const input = [
			`${M.open}*\navlue\n${M.put}\nvalue`,
			`${M.open}\nconst b = avlue.models;\n${M.put}\nconst b = value.models;`,
		].join("\n");

		expect(variant.apply(content, input, context)).toBe(
			["const a = value;", "const b = value.models;", ""].join("\n"),
		);
	});

	test("still rejects overlapping edits that disagree", () => {
		const content = "const b = avlue.models;\n";
		const input = [
			`${M.open}*\navlue\n${M.put}\nvalue`,
			`${M.open}\nconst b = avlue.models;\n${M.put}\nconst b = other.models;`,
		].join("\n");

		expect(() => variant.apply(content, input, context)).toThrow(/target overlapping original spans/);
	});
});
