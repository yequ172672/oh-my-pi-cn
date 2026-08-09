import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as gitUtils from "../packages/coding-agent/src/utils/git";
import { parseStableForkReleaseTag } from "./fork-release-identity";
import type { ForkReleaseMetadata } from "./publish-fork-package";
import {
	assessExistingReleaseState,
	finalizeForkChangelog,
	formatReleaseRecoveryError,
	parseReleaseForkOptions,
	validateCheckoutVersions,
	validateGitReleaseIdentity,
	validateRecoverableReleaseCommit,
	validateReleaseBridge,
	validateReleaseVersionAdvance,
	validateUpstreamBaseline,
} from "./release-fork";

const metadata: ForkReleaseMetadata = {
	schemaVersion: 1,
	forkVersion: "17.2.12",
	upstreamVersion: "17.2.11",
	nativeVersion: "17.2.11",
	upstreamCommit: "0123456789abcdef0123456789abcdef01234567",
};
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function gitText(cwd: string, args: readonly string[], effect = false): Promise<string> {
	return (await gitUtils.plumbing.text(cwd, args, { readOnly: !effect, timeoutMs: 15_000 })).trim();
}

describe("fork release preparation", () => {
	it("parses independent fork, upstream, and native versions", () => {
		expect(
			parseReleaseForkOptions([
				metadata.forkVersion,
				"--upstream-version",
				metadata.upstreamVersion,
				"--native-version",
				metadata.nativeVersion,
				"--upstream-commit",
				metadata.upstreamCommit,
			]),
		).toEqual({
			schemaVersion: 1,
			forkVersion: metadata.forkVersion,
			upstreamVersion: metadata.upstreamVersion,
			nativeVersion: metadata.nativeVersion,
			upstreamCommit: metadata.upstreamCommit,
		});
	});

	it("allows only stable release versions in the stable release transaction", () => {
		expect(() =>
			parseReleaseForkOptions([
				"17.2.12-cn.1",
				"--upstream-version",
				metadata.upstreamVersion,
				"--native-version",
				metadata.nativeVersion,
				"--upstream-commit",
				metadata.upstreamCommit,
			]),
		).toThrow("stable X.Y.Z");
		expect(parseStableForkReleaseTag("omp-cn-v17.2.12")).toBe("17.2.12");
		expect(() => parseStableForkReleaseTag("omp-cn-v17.2.12+local")).toThrow("stable X.Y.Z");
		expect(() => parseStableForkReleaseTag("v17.2.12")).toThrow("must start");
	});

	it("requires every dual-version input explicitly and rejects unknown options", () => {
		expect(() =>
			parseReleaseForkOptions([
				metadata.forkVersion,
				"--upstream-version",
				metadata.upstreamVersion,
				"--upstream-commit",
				metadata.upstreamCommit,
			]),
		).toThrow("--native-version is required");
		expect(() =>
			parseReleaseForkOptions([
				metadata.forkVersion,
				"--upstream-version",
				metadata.upstreamVersion,
				"--native-version",
				metadata.nativeVersion,
				"--upstream-commit",
				metadata.upstreamCommit,
				"--force",
				"yes",
			]),
		).toThrow("Unknown fork release option");
	});

	it("requires a same-version bridge from a legacy npm package", () => {
		expect(() => validateReleaseBridge(metadata, { version: "17.2.11" })).toThrow("bridge release requires");
		expect(() =>
			validateReleaseBridge({ ...metadata, forkVersion: metadata.nativeVersion }, { version: "17.2.11" }),
		).not.toThrow();
	});

	it("allows independent versions after schema 1 has reached npm", () => {
		expect(() =>
			validateReleaseBridge(metadata, { version: "17.2.11", ompFork: { schemaVersion: 1 } }),
		).not.toThrow();
	});

	it("requires a new npm version with greater SemVer precedence", () => {
		expect(() =>
			validateReleaseVersionAdvance({ ...metadata, forkVersion: "17.2.12" }, { version: "17.2.11" }),
		).not.toThrow();
		expect(() =>
			validateReleaseVersionAdvance({ ...metadata, forkVersion: "17.2.11" }, { version: "17.2.11" }),
		).toThrow("must be newer");
		expect(() =>
			validateReleaseVersionAdvance({ ...metadata, forkVersion: "17.2.11-cn.1" }, { version: "17.2.11" }),
		).toThrow("must be newer");
	});

	it("moves only Unreleased fork notes into the requested release", () => {
		const source =
			"# Fork changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixed distribution.\n\n## [1.0.0] - 2026-01-01\n\n- Old.\n";
		const result = finalizeForkChangelog(source, "1.0.1", "2026-08-09");
		expect(result).toContain("## [Unreleased]\n\n## [1.0.1] - 2026-08-09");
		expect(result).toContain("### Fixed\n\n- Fixed distribution.");
		expect(result).toContain("## [1.0.0] - 2026-01-01");
	});

	it("pins releases to the canonical fork, upstream, and tracked main branch", () => {
		expect(() =>
			validateGitReleaseIdentity(
				"git@github.com:yequ172672/oh-my-pi-cn.git",
				["https://github.com/yequ172672/oh-my-pi-cn.git"],
				"https://github.com/can1357/oh-my-pi.git",
				"origin/main",
			),
		).not.toThrow();
		expect(() =>
			validateGitReleaseIdentity(
				"https://github.com/can1357/oh-my-pi.git",
				["https://github.com/yequ172672/oh-my-pi-cn.git"],
				"https://github.com/can1357/oh-my-pi.git",
				"origin/main",
			),
		).toThrow("origin fetch URL");
		expect(() =>
			validateGitReleaseIdentity(
				"https://github.com/yequ172672/oh-my-pi-cn.git",
				["https://github.com/yequ172672/oh-my-pi-cn.git"],
				"https://github.com/can1357/oh-my-pi.git",
				"upstream/main",
			),
		).toThrow("track origin/main");
		expect(() =>
			validateGitReleaseIdentity(
				"https://github.com/yequ172672/oh-my-pi-cn.git",
				["https://github.com/yequ172672/oh-my-pi-cn.git", "https://github.com/example/typo.git"],
				"https://github.com/can1357/oh-my-pi.git",
				"origin/main",
			),
		).toThrow("origin push URL");
		expect(() =>
			validateGitReleaseIdentity(
				"http://github.com/yequ172672/oh-my-pi-cn.git",
				["https://github.com/yequ172672/oh-my-pi-cn.git"],
				"https://github.com/can1357/oh-my-pi.git",
				"origin/main",
			),
		).toThrow("insecure HTTP");
	});

	it("requires checkout package, native, and every @oh-my-pi catalog version to match metadata", () => {
		expect(() =>
			validateCheckoutVersions(metadata, {
				codingAgentVersion: metadata.upstreamVersion,
				nativeVersion: metadata.nativeVersion,
				catalog: {
					"@oh-my-pi/pi-ai": metadata.upstreamVersion,
					"@oh-my-pi/pi-natives": metadata.nativeVersion,
					thirdParty: "1.0.0",
				},
			}),
		).not.toThrow();
		expect(() =>
			validateCheckoutVersions(metadata, {
				codingAgentVersion: "17.2.10",
				nativeVersion: metadata.nativeVersion,
				catalog: { "@oh-my-pi/pi-ai": "17.2.10" },
			}),
		).toThrow("coding-agent=17.2.10");
	});

	it("pins upstreamCommit to the actual fork/upstream merge base", () => {
		expect(() => validateUpstreamBaseline(metadata.upstreamCommit, metadata.upstreamCommit)).not.toThrow();
		expect(() => validateUpstreamBaseline(metadata.upstreamCommit, "f".repeat(40))).toThrow(
			"actual HEAD/upstream-main",
		);
	});

	it("accepts recovery only for the exact release transaction commit", () => {
		const snapshot = {
			changedPaths: ["packages/coding-agent/fork-release.json", "docs/FORK_CHANGELOG.md"],
			changelog: `# Fork\n\n## [Unreleased]\n\n## [${metadata.forkVersion}] - 2026-08-09\n\n- Release notes.\n`,
			metadataMatches: true,
			parentSha: "a".repeat(40),
			remoteMainSha: "a".repeat(40),
			requireRemoteParent: true,
			subject: `chore(fork): release omp-cn ${metadata.forkVersion}`,
			version: metadata.forkVersion,
		} as const;
		expect(() => validateRecoverableReleaseCommit(snapshot)).not.toThrow();
		expect(() =>
			validateRecoverableReleaseCommit({ ...snapshot, changedPaths: [...snapshot.changedPaths, "README.md"] }),
		).toThrow("unexpected paths");
		expect(() => validateRecoverableReleaseCommit({ ...snapshot, parentSha: "b".repeat(40) })).toThrow(
			"direct child",
		);
		expect(() => validateRecoverableReleaseCommit({ ...snapshot, changelog: "## [Unreleased]\n" })).toThrow(
			"no released section",
		);
	});

	it("retries a matching local tag and reconciles an already-complete atomic push", () => {
		const headSha = metadata.upstreamCommit;
		expect(
			assessExistingReleaseState({ headSha, localTagSha: headSha, remoteTagSha: "", remoteMainSha: "old" }),
		).toBe("push");
		expect(
			assessExistingReleaseState({ headSha, localTagSha: headSha, remoteTagSha: headSha, remoteMainSha: headSha }),
		).toBe("complete");
		expect(
			assessExistingReleaseState({
				headSha,
				localTagSha: "",
				remoteTagSha: headSha,
				remoteMainSha: headSha,
				recoverableReleaseCommit: true,
			}),
		).toBe("complete");
		expect(
			assessExistingReleaseState({
				headSha,
				localTagSha: "",
				remoteTagSha: "",
				remoteMainSha: "old",
				recoverableReleaseCommit: true,
			}),
		).toBe("tag");
	});

	it("reports the durable commit, tag, atomic guarantee, and retry probe after a half-failure", () => {
		const error = formatReleaseRecoveryError(metadata.upstreamCommit, "omp-cn-v17.2.12", new Error("offline"));
		expect(error.message).toContain(metadata.upstreamCommit);
		expect(error.message).toContain("omp-cn-v17.2.12");
		expect(error.message).toContain("atomic push cannot update only one remote ref");
		expect(error.message).toContain("git ls-remote origin refs/heads/main");
	});

	it("recovers a real release commit interrupted before tag creation with one atomic push", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-release-recovery-"));
		tempDirs.push(root);
		const remote = path.join(root, "origin.git");
		const work = path.join(root, "work");
		await gitText(root, ["init", "--bare", remote], true);
		await gitText(root, ["init", "-b", "main", work], true);
		await gitText(work, ["config", "user.name", "Release Test"], true);
		await gitText(work, ["config", "user.email", "release@example.invalid"], true);
		await fs.mkdir(path.join(work, "docs"), { recursive: true });
		await fs.mkdir(path.join(work, "packages/coding-agent"), { recursive: true });
		await Bun.write(path.join(work, "docs/FORK_CHANGELOG.md"), "# Fork\n\n## [Unreleased]\n\n- Pending.\n");
		await Bun.write(
			path.join(work, "packages/coding-agent/fork-release.json"),
			`${JSON.stringify({ ...metadata, forkVersion: "17.2.10" })}\n`,
		);
		await gitText(work, ["add", "."], true);
		await gitText(work, ["commit", "-m", "base"], true);
		const baseSha = await gitText(work, ["rev-parse", "HEAD"]);
		await gitText(work, ["remote", "add", "origin", remote], true);
		await gitText(work, ["push", "-u", "origin", "main"], true);

		const changelog = `# Fork\n\n## [Unreleased]\n\n## [${metadata.forkVersion}] - 2026-08-09\n\n- Release notes.\n`;
		await Bun.write(path.join(work, "docs/FORK_CHANGELOG.md"), changelog);
		await Bun.write(path.join(work, "packages/coding-agent/fork-release.json"), `${JSON.stringify(metadata)}\n`);
		await gitText(work, ["add", "."], true);
		await gitText(work, ["commit", "-m", `chore(fork): release omp-cn ${metadata.forkVersion}`], true);
		const releaseSha = await gitText(work, ["rev-parse", "HEAD"]);
		const changedPaths = (await gitText(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]))
			.split(/\r?\n/)
			.filter(Boolean);

		expect(
			assessExistingReleaseState({
				headSha: releaseSha,
				localTagSha: "",
				remoteTagSha: "",
				remoteMainSha: baseSha,
				recoverableReleaseCommit: true,
			}),
		).toBe("tag");
		validateRecoverableReleaseCommit({
			changedPaths,
			changelog,
			metadataMatches: true,
			parentSha: await gitText(work, ["rev-parse", "HEAD^"]),
			remoteMainSha: baseSha,
			requireRemoteParent: true,
			subject: await gitText(work, ["show", "-s", "--format=%s", "HEAD"]),
			version: metadata.forkVersion,
		});

		const tag = `omp-cn-v${metadata.forkVersion}`;
		await gitText(work, ["tag", tag, releaseSha], true);
		await gitText(
			work,
			["push", "--atomic", "origin", `${releaseSha}:refs/heads/main`, `${releaseSha}:refs/tags/${tag}`],
			true,
		);
		expect(await gitText(work, ["ls-remote", "--heads", "origin", "refs/heads/main"])).toStartWith(releaseSha);
		expect(await gitText(work, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`])).toStartWith(releaseSha);
	}, 15_000);
});
