import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { disposeJuliaKernelSessionsByOwner, executeJulia } from "../../src/eval/jl/executor";

const HAS_JULIA = Boolean($which("julia"));
const OWNER_ID = "julia-prelude-tests";

describe.skipIf(!HAS_JULIA)("eval Julia prelude helpers", () => {
	afterEach(async () => {
		await disposeJuliaKernelSessionsByOwner(OWNER_ID);
	}, 30_000);

	it("supports prelude helpers and renders exception details in one kernel session", async () => {
		using tempDir = TempDir.createSync("@omp-eval-julia-prelude-");
		const artifactsDir = path.join(tempDir.path(), "session-artifacts");
		await Bun.write(path.join(artifactsDir, "alpha.md"), "one\ntwo\nthree\nfour");
		await Bun.write(path.join(artifactsDir, "json.md"), JSON.stringify({ items: [{ name: "a" }, { name: "b" }] }));
		await Bun.write(path.join(artifactsDir, "ansi.md"), "\u001b[31mred\u001b[0m");
		const sessionId = `julia-prelude:${crypto.randomUUID()}`;

		const helpers = await executeJulia(
			`
println("RANGE=", replace(output("alpha", offset=2, limit=2), "\\n" => "|"))
println("QUERY=", output("json", query=".items[1].name"))
println("STRIPPED=", output("ansi", format="stripped"))
meta = output("alpha", format="json")
println("META=", meta["id"], ":", meta["char_count"] > 0)
multi = output("alpha", "json")
println("MULTI=", length(multi), ":", multi[1]["id"], ":", multi[2]["id"])
nothing
`,
			{
				cwd: tempDir.path(),
				artifactsDir,
				sessionId,
				kernelOwnerId: OWNER_ID,
				reset: true,
			},
		);

		expect(helpers.exitCode).toBe(0);
		expect(helpers.output).toContain("RANGE=two|three");
		expect(helpers.output).toContain('QUERY="b"');
		expect(helpers.output).toContain("STRIPPED=red");
		expect(helpers.output).toContain("META=alpha:true");
		expect(helpers.output).toContain("MULTI=2:alpha:json");

		const error = await executeJulia(`println("="^8)\nmissing_var_xyz + 1`, {
			cwd: tempDir.path(),
			artifactsDir,
			sessionId,
			kernelOwnerId: OWNER_ID,
		});

		// The rendered error must carry the actual exception, not only the
		// runner-internal backtrace frames (regression: traceback-only output
		// hid `ename`/`evalue`).
		expect(error.output).toContain("UndefVarError");
		expect(error.output).toContain("missing_var_xyz");
		// Frames are still present alongside the message.
		expect(error.output).toContain("top-level scope");
	}, 60_000);
});
