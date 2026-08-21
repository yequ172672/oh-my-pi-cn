import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Regression coverage for #8897: `omp commit` split-commit captured the staged
// diff with `git diff --cached --binary`, whose stdout is hard-capped at
// GIT_COMMAND_OUTPUT_LIMIT_BYTES (8 MiB). A single large binary (base85-encoded
// inline) pushed the diff past the cap; readCappedText silently truncated it and
// `stage.hunks` then threw a misleading "No diff found" for any file sorting
// after the binary. The fix surfaces truncation as `GitCommandResult.truncated`
// and lets `diff({ requireComplete: true })` fail loudly with the real cause.

const GIT_ENV = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
} as const;

function gitRun(cwd: string, args: string[]): void {
	const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV };
	const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, env, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
}

describe("git.diff with a staged binary past the 8 MiB capture cap", () => {
	let repo: string;

	beforeAll(async () => {
		repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-trunc-test-"));
		gitRun(repo, ["init", "-q", "-b", "main"]);
		// ~9 MiB of incompressible bytes so `--binary` (zlib + base85) alone
		// exceeds the 8 MiB cap. Name sorts before the text file so the text
		// file's diff entry is the one that gets cut off.
		const bin = new Uint8Array(9 * 1024 * 1024);
		for (let offset = 0; offset < bin.length; offset += 65536) {
			crypto.getRandomValues(bin.subarray(offset, Math.min(offset + 65536, bin.length)));
		}
		await Bun.write(path.join(repo, "a.bin"), bin);
		await Bun.write(path.join(repo, "z.txt"), "hello world\nchanged line\n");
		await git.stage.files(repo);
	});

	afterAll(async () => {
		await removeWithRetries(repo);
	});

	test("unguarded capture silently truncates and drops the later-sorting file", async () => {
		const staged = await git.diff(repo, { cached: true, binary: true });
		expect(staged.length).toBeLessThanOrEqual(git.GIT_COMMAND_OUTPUT_LIMIT_BYTES + 64);
		// Root cause: the truncated diff no longer contains `z.txt`, which is what
		// made `stage.hunks` throw "No diff found for z.txt".
		const files = git.diff.parseFiles(staged).map(f => f.filename);
		expect(files).not.toContain("z.txt");
	});

	test("requireComplete converts silent truncation into a typed, descriptive error", async () => {
		let thrown: unknown;
		try {
			await git.diff(repo, { cached: true, binary: true, requireComplete: true });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(git.GitOutputTruncatedError);
		expect((thrown as Error).message).toContain("truncated");
		expect((thrown as git.GitOutputTruncatedError).result.truncated).toBe(true);
	});

	test("requireComplete leaves a complete diff untouched", async () => {
		const small = await fs.mkdtemp(path.join(os.tmpdir(), "omp-git-small-test-"));
		try {
			gitRun(small, ["init", "-q", "-b", "main"]);
			await Bun.write(path.join(small, "s.txt"), "one\ntwo\n");
			await git.stage.files(small);
			const diff = await git.diff(small, { cached: true, binary: true, requireComplete: true });
			expect(diff).toContain("s.txt");
		} finally {
			await removeWithRetries(small);
		}
	});
});
