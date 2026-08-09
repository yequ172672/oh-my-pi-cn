#!/usr/bin/env bun

/** Prepare and atomically push an omp-cn fork release. CI owns npm and GitHub publication. */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import * as gitUtils from "../packages/coding-agent/src/utils/git.ts";
import { compareVersions } from "../packages/utils/src/version.ts";
import { isStableForkVersion, parseStableForkReleaseTag } from "./fork-release-identity";
import {
	assertSecureTlsEnvironment,
	type ForkManifestMetadata,
	type ForkReleaseMetadata,
	parseForkReleaseMetadata,
} from "./publish-fork-package";

const repoRoot = path.join(import.meta.dir, "..");
const metadataPath = path.join(repoRoot, "packages/coding-agent/fork-release.json");
const changelogPath = path.join(repoRoot, "docs/FORK_CHANGELOG.md");
export const GIT_TIMEOUT_MS = 120_000;

interface NpmManifest {
	version?: string;
	ompFork?: Partial<ForkManifestMetadata>;
}

export interface ReleaseForkOptions extends ForkReleaseMetadata {}

export interface CheckoutVersionSnapshot {
	codingAgentVersion: string;
	nativeVersion: string;
	catalog: Readonly<Record<string, string>>;
}

export interface ReleaseRemoteState {
	headSha: string;
	localTagSha: string;
	remoteTagSha: string;
	remoteMainSha: string;
	recoverableReleaseCommit?: boolean;
}

export interface RecoverableReleaseCommitSnapshot {
	changedPaths: readonly string[];
	changelog: string;
	metadataMatches: boolean;
	parentSha: string;
	remoteMainSha: string;
	requireRemoteParent: boolean;
	subject: string;
	version: string;
}

const EXPECTED_ORIGIN = "github.com/yequ172672/oh-my-pi-cn";
const EXPECTED_UPSTREAM = "github.com/can1357/oh-my-pi";

export function validateCheckoutVersions(metadata: ForkReleaseMetadata, snapshot: CheckoutVersionSnapshot): void {
	const failures: string[] = [];
	if (snapshot.codingAgentVersion !== metadata.upstreamVersion) {
		failures.push(`coding-agent=${snapshot.codingAgentVersion} (expected ${metadata.upstreamVersion})`);
	}
	if (snapshot.nativeVersion !== metadata.nativeVersion) {
		failures.push(`pi-natives=${snapshot.nativeVersion} (expected ${metadata.nativeVersion})`);
	}
	for (const [name, version] of Object.entries(snapshot.catalog)) {
		if (!name.startsWith("@oh-my-pi/")) continue;
		const expected = name === "@oh-my-pi/pi-natives" ? metadata.nativeVersion : metadata.upstreamVersion;
		if (version !== expected) failures.push(`catalog ${name}=${version} (expected ${expected})`);
	}
	if (failures.length > 0)
		throw new Error(`Checkout versions do not match fork release metadata: ${failures.join(", ")}`);
}

export function assessExistingReleaseState(state: ReleaseRemoteState): "prepare" | "tag" | "push" | "complete" {
	if (!state.localTagSha) {
		if (state.remoteTagSha) {
			if (state.remoteTagSha === state.headSha && state.remoteMainSha === state.headSha) return "complete";
			throw new Error("Remote fork tag exists without a matching local release tag");
		}
		return state.recoverableReleaseCommit ? "tag" : "prepare";
	}
	if (state.localTagSha !== state.headSha) throw new Error("Local fork tag does not point at current main HEAD");
	if (!state.remoteTagSha) return "push";
	if (state.remoteTagSha === state.headSha && state.remoteMainSha === state.headSha) return "complete";
	throw new Error("Remote fork tag or main points at a different commit; manual reconciliation is required");
}

export function validateUpstreamBaseline(requested: string, mergeBase: string): void {
	if (requested !== mergeBase) {
		throw new Error(`upstreamCommit ${requested} is not the actual HEAD/upstream-main merge base ${mergeBase}`);
	}
}

export function validateRecoverableReleaseCommit(snapshot: RecoverableReleaseCommitSnapshot): void {
	if (!snapshot.metadataMatches) throw new Error("Release commit metadata does not match the requested release");
	if (snapshot.subject !== `chore(fork): release omp-cn ${snapshot.version}`) {
		throw new Error(`Release commit has an unexpected subject: ${snapshot.subject}`);
	}
	if (snapshot.requireRemoteParent && snapshot.parentSha !== snapshot.remoteMainSha) {
		throw new Error("Release commit is not the direct child of origin/main");
	}
	const expectedPaths = ["docs/FORK_CHANGELOG.md", "packages/coding-agent/fork-release.json"];
	const actualPaths = [...snapshot.changedPaths].sort();
	if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
		throw new Error(`Release commit changed unexpected paths: ${actualPaths.join(", ")}`);
	}
	const heading = `## [${snapshot.version}] - `;
	const start = snapshot.changelog.indexOf(heading);
	if (start < 0) throw new Error(`FORK_CHANGELOG.md has no released section for ${snapshot.version}`);
	const contentStart = snapshot.changelog.indexOf("\n", start + heading.length);
	if (contentStart < 0) throw new Error(`FORK_CHANGELOG.md release heading ${snapshot.version} has no content`);
	const next = snapshot.changelog.indexOf("\n## [", contentStart + 1);
	const released = snapshot.changelog.slice(contentStart + 1, next < 0 ? undefined : next).trim();
	if (!released) throw new Error(`FORK_CHANGELOG.md release section ${snapshot.version} is empty`);
}

function normalizeGitRemote(value: string): string {
	return value
		.trim()
		.replace(/^git@github\.com:/, "github.com/")
		.replace(/^ssh:\/\/git@github\.com\//, "github.com/")
		.replace(/^https?:\/\//, "")
		.replace(/\.git$/, "")
		.toLowerCase();
}

function validateCanonicalRemote(value: string, expected: string, label: string): void {
	if (/^http:\/\//i.test(value.trim())) throw new Error(`${label} must not use insecure HTTP: ${value}`);
	if (normalizeGitRemote(value) !== expected) {
		throw new Error(`${label} must be the canonical repository ${expected}, received ${value}`);
	}
}

export function validateGitReleaseIdentity(
	originUrl: string,
	originPushUrls: readonly string[],
	upstreamUrl: string,
	trackingBranch: string,
): void {
	validateCanonicalRemote(originUrl, EXPECTED_ORIGIN, "origin fetch URL");
	if (originPushUrls.length === 0) throw new Error("origin must have at least one push URL");
	for (const originPushUrl of originPushUrls) {
		validateCanonicalRemote(originPushUrl, EXPECTED_ORIGIN, "origin push URL");
	}
	validateCanonicalRemote(upstreamUrl, EXPECTED_UPSTREAM, "upstream fetch URL");
	if (trackingBranch !== "origin/main") {
		throw new Error(`main must track origin/main, received ${trackingBranch || "no upstream"}`);
	}
}

export function formatReleaseRecoveryError(commit: string, tag: string, cause: unknown): Error {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return new Error(
		`Fork release tag/push step failed after creating commit ${commit} for ${tag}: ${detail}. ` +
			"The atomic push cannot update only one remote ref. Re-run the same release-fork command to reconcile and retry; " +
			`verify with git ls-remote origin refs/heads/main refs/tags/${tag}.`,
	);
}

export function parseReleaseForkOptions(argv: readonly string[]): ReleaseForkOptions {
	const forkVersion = argv[0];
	if (!forkVersion || forkVersion.startsWith("--"))
		throw new Error("Usage: release-fork.ts <forkVersion> --upstream-version <v> --native-version <v>");
	const allowed = new Set(["--upstream-version", "--native-version", "--upstream-commit"]);
	const values = new Map<string, string>();
	for (let index = 1; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!allowed.has(flag)) throw new Error(`Unknown fork release option: ${flag}`);
		if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
		if (values.has(flag)) throw new Error(`Duplicate fork release option: ${flag}`);
		values.set(flag, value);
	}
	const upstreamVersion = values.get("--upstream-version");
	const nativeVersion = values.get("--native-version");
	const upstreamCommit = values.get("--upstream-commit");
	if (!upstreamVersion) throw new Error("--upstream-version is required");
	if (!nativeVersion) throw new Error("--native-version is required");
	if (!upstreamCommit) throw new Error("--upstream-commit is required");
	const metadata = parseForkReleaseMetadata({
		schemaVersion: 1,
		forkVersion,
		upstreamVersion,
		nativeVersion,
		upstreamCommit,
	});
	for (const [field, version] of [
		["forkVersion", metadata.forkVersion],
		["upstreamVersion", metadata.upstreamVersion],
		["nativeVersion", metadata.nativeVersion],
	] as const) {
		if (!isStableForkVersion(version)) {
			throw new Error(`${field} must be a stable X.Y.Z version for a stable fork release`);
		}
	}
	parseStableForkReleaseTag(`omp-cn-v${metadata.forkVersion}`);
	return metadata;
}

export function validateReleaseBridge(metadata: ForkReleaseMetadata, latest: NpmManifest | null): void {
	if (!latest?.ompFork?.schemaVersion && metadata.forkVersion !== metadata.nativeVersion) {
		throw new Error(
			`The latest omp-cn package has no schema-1 ompFork metadata; bridge release requires forkVersion (${metadata.forkVersion}) to equal nativeVersion (${metadata.nativeVersion})`,
		);
	}
	if (latest?.ompFork?.schemaVersion !== undefined && latest.ompFork.schemaVersion !== 1) {
		throw new Error(`Unsupported latest ompFork schemaVersion: ${String(latest.ompFork.schemaVersion)}`);
	}
}

export function validateReleaseVersionAdvance(metadata: ForkReleaseMetadata, latest: NpmManifest): void {
	if (!latest.version) throw new Error("omp-cn@latest did not report a version");
	if (compareVersions(metadata.forkVersion, latest.version) <= 0) {
		throw new Error(
			`forkVersion ${metadata.forkVersion} must be newer than the published latest omp-cn ${latest.version}`,
		);
	}
}

export function finalizeForkChangelog(source: string, version: string, date: string): string {
	const heading = "## [Unreleased]";
	const start = source.indexOf(heading);
	if (start < 0) throw new Error("FORK_CHANGELOG.md is missing ## [Unreleased]");
	const contentStart = start + heading.length;
	const next = source.indexOf("\n## [", contentStart);
	const unreleased = source.slice(contentStart, next < 0 ? source.length : next).trim();
	if (!unreleased) throw new Error("FORK_CHANGELOG.md [Unreleased] has no release notes");
	const tail = next < 0 ? "" : source.slice(next);
	return `${source.slice(0, start)}## [Unreleased]\n\n## [${version}] - ${date}\n\n${unreleased}${tail}\n`;
}

async function git(args: readonly string[], effect = false): Promise<string> {
	return (
		await gitUtils.plumbing.text(repoRoot, args, {
			readOnly: !effect,
			timeoutMs: GIT_TIMEOUT_MS,
		})
	).trim();
}

async function gitIsAncestor(ancestor: string, descendant: string): Promise<boolean> {
	const result = await gitUtils.plumbing.result(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant], {
		readOnly: true,
		timeoutMs: GIT_TIMEOUT_MS,
	});
	if (result.exitCode === 0) return true;
	if (result.exitCode === 1) return false;
	throw new Error(`git merge-base --is-ancestor failed: ${result.stderr.trim()}`);
}

function lsRemoteSha(output: string): string {
	return output.split(/\s+/)[0] ?? "";
}

async function fetchLatestNpmManifest(): Promise<NpmManifest> {
	const result = await $`npm view omp-cn@latest --json`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`Cannot query omp-cn@latest for release bridge validation: ${result.stderr.toString().trim()}`);
	}
	return JSON.parse(result.text()) as NpmManifest;
}

async function assertNpmVersionIsUnpublished(version: string): Promise<void> {
	const response = await fetch(`https://registry.npmjs.org/omp-cn/${encodeURIComponent(version)}`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 404) return;
	if (!response.ok) {
		throw new Error(
			`Cannot verify whether omp-cn@${version} is unpublished: ${response.status} ${response.statusText}`,
		);
	}
	throw new Error(`omp-cn@${version} is already published and cannot be reused`);
}

async function loadCheckoutVersionSnapshot(): Promise<CheckoutVersionSnapshot> {
	const codingAgent = (await Bun.file(path.join(repoRoot, "packages/coding-agent/package.json")).json()) as {
		version?: unknown;
	};
	const natives = (await Bun.file(path.join(repoRoot, "packages/natives/package.json")).json()) as {
		version?: unknown;
	};
	const rootManifest = (await Bun.file(path.join(repoRoot, "package.json")).json()) as {
		workspaces?: { catalog?: Record<string, string> };
	};
	if (
		typeof codingAgent.version !== "string" ||
		typeof natives.version !== "string" ||
		!rootManifest.workspaces?.catalog
	) {
		throw new Error("Cannot read checkout versions from coding-agent, natives, and root catalog manifests");
	}
	return {
		codingAgentVersion: codingAgent.version,
		nativeVersion: natives.version,
		catalog: rootManifest.workspaces.catalog,
	};
}

async function restoreFile(filePath: string, original: string | null): Promise<void> {
	if (original === null) {
		await fs.rm(filePath, { force: true });
	} else {
		await Bun.write(filePath, original);
	}
}

async function main(): Promise<void> {
	assertSecureTlsEnvironment();
	const options = parseReleaseForkOptions(process.argv.slice(2));
	if ((await git(["branch", "--show-current"])) !== "main") throw new Error("Fork releases must run from main");
	if (await git(["status", "--porcelain"])) throw new Error("Fork releases require a clean working tree");
	validateGitReleaseIdentity(
		await git(["remote", "get-url", "origin"]),
		(await git(["remote", "get-url", "--all", "--push", "origin"])).split(/\r?\n/).filter(Boolean),
		await git(["remote", "get-url", "upstream"]),
		await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
	);
	await git(["fetch", "origin", "--prune", "--no-tags"], true);
	await git(["fetch", "upstream", "--prune", "--no-tags"], true);
	validateUpstreamBaseline(options.upstreamCommit, await git(["merge-base", "HEAD", "upstream/main"]));
	const metadata = parseForkReleaseMetadata({ schemaVersion: 1, ...options });
	validateCheckoutVersions(metadata, await loadCheckoutVersionSnapshot());
	const tag = `omp-cn-v${metadata.forkVersion}`;
	const headSha = await git(["rev-parse", "HEAD"]);
	const localTagSha = await git(["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]).catch(() => "");
	const remoteTagSha = lsRemoteSha(await git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]));
	const remoteMainSha = lsRemoteSha(await git(["ls-remote", "--heads", "origin", "refs/heads/main"]));
	if (!remoteMainSha || !(await gitIsAncestor(remoteMainSha, headSha))) {
		throw new Error(
			"origin/main is missing or is not an ancestor of local main; reconcile the branch before release",
		);
	}
	const checkedIn = parseForkReleaseMetadata(await Bun.file(metadataPath).json());
	const requestedMetadataMatches = JSON.stringify(checkedIn) === JSON.stringify(metadata);
	const headSubject = await git(["show", "-s", "--format=%s", "HEAD"]);
	const recoverableReleaseCommit =
		requestedMetadataMatches && headSubject === `chore(fork): release omp-cn ${metadata.forkVersion}`;
	const existingState = assessExistingReleaseState({
		headSha,
		localTagSha,
		remoteTagSha,
		remoteMainSha,
		recoverableReleaseCommit,
	});
	if (existingState !== "prepare") {
		validateRecoverableReleaseCommit({
			changedPaths: (await git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]))
				.split(/\r?\n/)
				.filter(Boolean),
			changelog: await Bun.file(changelogPath).text(),
			metadataMatches: requestedMetadataMatches,
			parentSha: await git(["rev-parse", "HEAD^"]),
			remoteMainSha,
			requireRemoteParent: existingState !== "complete",
			subject: headSubject,
			version: metadata.forkVersion,
		});
	}
	if (existingState === "complete") {
		console.log(`${tag} is already present on origin/main; no release preparation is needed.`);
		return;
	}
	if ((existingState === "tag" || existingState === "push") && !requestedMetadataMatches) {
		throw new Error("Checked-in fork-release.json does not match the requested retry metadata");
	}
	const latestNpmManifest = await fetchLatestNpmManifest();
	validateReleaseVersionAdvance(metadata, latestNpmManifest);
	validateReleaseBridge(metadata, latestNpmManifest);
	await assertNpmVersionIsUnpublished(metadata.forkVersion);
	if (existingState === "tag" || existingState === "push") {
		if (!recoverableReleaseCommit) {
			throw new Error("Checked-in fork-release.json does not match the requested retry metadata");
		}
		await $`bun scripts/publish-fork-package.ts --pack`.cwd(repoRoot);
		if (existingState === "tag") await git(["tag", tag, headSha], true);
		await git(["push", "--atomic", "origin", `${headSha}:refs/heads/main`, `${headSha}:refs/tags/${tag}`], true);
		console.log(`Retried atomic push for ${tag}; CI now owns npm and GitHub Release publication.`);
		return;
	}

	const originalMetadata = (await Bun.file(metadataPath).exists()) ? await Bun.file(metadataPath).text() : null;
	const originalChangelog = await Bun.file(changelogPath).text();
	let committed = false;
	let releaseCommit = "";
	try {
		await Bun.write(metadataPath, `${JSON.stringify(metadata, null, "\t")}\n`);
		await Bun.write(
			changelogPath,
			finalizeForkChangelog(originalChangelog, metadata.forkVersion, new Date().toISOString().slice(0, 10)),
		);
		await $`bun scripts/publish-fork-package.ts --pack`.cwd(repoRoot);
		await git(["add", "--", "packages/coding-agent/fork-release.json", "docs/FORK_CHANGELOG.md"], true);
		await git(["commit", "-m", `chore(fork): release omp-cn ${metadata.forkVersion}`], true);
		committed = true;
		releaseCommit = await git(["rev-parse", "HEAD"]);
		await git(["tag", tag, releaseCommit], true);
		await git(
			["push", "--atomic", "origin", `${releaseCommit}:refs/heads/main`, `${releaseCommit}:refs/tags/${tag}`],
			true,
		);
		console.log(`Prepared and pushed ${tag}; CI now owns npm and GitHub Release publication.`);
	} catch (error) {
		if (!committed) {
			await restoreFile(metadataPath, originalMetadata);
			await Bun.write(changelogPath, originalChangelog);
		}
		if (committed) throw formatReleaseRecoveryError(releaseCommit, tag, error);
		throw error;
	}
}

if (import.meta.main) await main();
