import { describe, expect, test } from "bun:test";
import { interpretEmptyDiagnosticsResult } from "../src/lsp/workspace-diagnostics";

const command = ["npx", "tsc", "--noEmit"];

describe("interpretEmptyDiagnosticsResult", () => {
	test("reports a silent non-zero exit as an unverified workspace", () => {
		expect(interpretEmptyDiagnosticsResult(17, null, command)).toBe(
			"Failed to run npx tsc --noEmit: the checker exited with code 17 without reporting anything, so the workspace was not verified",
		);
	});

	test("reports a signal when the checker was killed silently", () => {
		expect(interpretEmptyDiagnosticsResult(137, "SIGKILL", command)).toBe(
			"Failed to run npx tsc --noEmit: the checker was killed by SIGKILL without reporting anything, so the workspace was not verified",
		);
	});

	test("preserves the clean-workspace result for a successful silent checker", () => {
		expect(interpretEmptyDiagnosticsResult(0, null, command)).toBe("No issues found");
	});
});
