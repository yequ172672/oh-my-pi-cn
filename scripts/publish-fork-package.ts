#!/usr/bin/env bun

/** Pack, validate, and smoke-test the localized CLI. CI owns npm publication. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import {
	type ForkReleaseManifest,
	parseForkReleaseManifest,
} from "../packages/coding-agent/src/distribution-schema.ts";
import { applyPublishBin, legalPayloadFiles, packages, stageLegalPayloads } from "./ci-release-publish.ts";

export const FORK_NPM_PACKAGE = "omp-cn";
export const FORK_REPOSITORY = "yequ172672/oh-my-pi-cn";
export const FORK_HOMEPAGE = "https://yequ172672.github.io/oh-my-pi-cn/";
export const FORK_PACKAGE_DESCRIPTION =
	"omp coding agent 的简体中文本地化分支，包含设置、供应商配置、提示和 CLI 文案中文化";

const repoRoot = path.join(import.meta.dir, "..");
const packageRelDir = "packages/coding-agent";
const packageDir = path.join(repoRoot, packageRelDir);
const manifestPath = path.join(packageDir, "package.json");
const releaseMetadataPath = path.join(packageDir, "fork-release.json");
export type ForkReleaseMetadata = ForkReleaseManifest;

export interface ForkManifestMetadata extends ForkReleaseMetadata {
	releaseTag: string;
}

interface Manifest {
	[key: string]: unknown;
	name?: string;
	version?: string;
	bin?: Record<string, string>;
	license?: string;
	homepage?: string;
	repository?: { type?: string; url?: string; directory?: string };
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	files?: unknown[];
	ompFork?: ForkManifestMetadata;
}

interface CliOptions {
	dryRun: boolean;
	packOnly: boolean;
	skipCheck: boolean;
	outputDir?: string;
}

export function parseForkReleaseMetadata(value: unknown): ForkReleaseMetadata {
	return parseForkReleaseManifest(value);
}

export async function loadForkReleaseMetadata(filePath: string = releaseMetadataPath): Promise<ForkReleaseMetadata> {
	return parseForkReleaseMetadata(await Bun.file(filePath).json());
}

function rewriteOhMyPiDependencies(
	dependencies: Record<string, string> | undefined,
	metadata: ForkReleaseMetadata,
): Record<string, string> | undefined {
	if (!dependencies) return dependencies;
	return Object.fromEntries(
		Object.entries(dependencies).map(([name, version]) => {
			if (!name.startsWith("@oh-my-pi/")) return [name, version];
			const expected =
				name === "@oh-my-pi/pi-natives" || name.startsWith("@oh-my-pi/pi-natives-")
					? metadata.nativeVersion
					: metadata.upstreamVersion;
			return [name, expected];
		}),
	);
}

export function createForkManifest(manifest: Manifest, metadata: ForkReleaseMetadata): Manifest {
	const ompFork: ForkManifestMetadata = { ...metadata, releaseTag: `omp-cn-v${metadata.forkVersion}` };
	const files = Array.isArray(manifest.files) ? [...manifest.files] : [];
	if (!files.includes("fork-release.json")) files.push("fork-release.json");
	for (const legalFile of legalPayloadFiles(manifest.license)) {
		if (!files.includes(legalFile)) files.push(legalFile);
	}
	return {
		...manifest,
		name: FORK_NPM_PACKAGE,
		version: metadata.forkVersion,
		description: FORK_PACKAGE_DESCRIPTION,
		author: "yequ172672",
		contributors: ["Mario Zechner", "Can Boluk"],
		homepage: FORK_HOMEPAGE,
		repository: {
			type: "git",
			url: `git+https://github.com/${FORK_REPOSITORY}.git`,
			directory: packageRelDir,
		},
		bugs: { url: `https://github.com/${FORK_REPOSITORY}/issues` },
		publishConfig: { access: "public" },
		dependencies: rewriteOhMyPiDependencies(manifest.dependencies, metadata),
		optionalDependencies: rewriteOhMyPiDependencies(manifest.optionalDependencies, metadata),
		peerDependencies: rewriteOhMyPiDependencies(manifest.peerDependencies, metadata),
		files,
		ompFork,
	};
}

export function validateForkManifest(manifest: Manifest, metadata: ForkReleaseMetadata): void {
	const expectedRepository = `git+https://github.com/${FORK_REPOSITORY}.git`;
	const failures: string[] = [];
	if (manifest.name !== FORK_NPM_PACKAGE) failures.push(`name=${String(manifest.name)}`);
	if (manifest.version !== metadata.forkVersion) failures.push(`version=${String(manifest.version)}`);
	if (manifest.bin?.omp !== "dist/cli.js") failures.push(`bin.omp=${String(manifest.bin?.omp)}`);
	if (manifest.license !== "MIT") failures.push(`license=${String(manifest.license)}`);
	if (manifest.homepage !== FORK_HOMEPAGE) failures.push("homepage");
	if (
		manifest.repository?.type !== "git" ||
		manifest.repository.url !== expectedRepository ||
		manifest.repository.directory !== packageRelDir
	)
		failures.push("repository");
	const expectedOmpFork: ForkManifestMetadata = { ...metadata, releaseTag: `omp-cn-v${metadata.forkVersion}` };
	if (JSON.stringify(manifest.ompFork) !== JSON.stringify(expectedOmpFork)) failures.push("ompFork");
	for (const legalFile of legalPayloadFiles(manifest.license)) {
		if (!manifest.files?.includes(legalFile)) failures.push(`files.${legalFile}`);
	}
	for (const section of [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies]) {
		for (const [name, version] of Object.entries(section ?? {})) {
			if (!name.startsWith("@oh-my-pi/")) continue;
			const expected =
				name === "@oh-my-pi/pi-natives" || name.startsWith("@oh-my-pi/pi-natives-")
					? metadata.nativeVersion
					: metadata.upstreamVersion;
			if (version !== expected) failures.push(`${name}=${version} (expected ${expected})`);
		}
	}
	if (failures.length > 0) throw new Error(`Invalid omp-cn packed manifest: ${failures.join(", ")}`);
}

export function assertSecureTlsEnvironment(env: NodeJS.ProcessEnv = process.env): void {
	if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
		throw new Error("Refusing fork release while NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS verification");
	}
}

export async function sha256File(filePath: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(await Bun.file(filePath).arrayBuffer());
	return hasher.digest("hex");
}

export function formatSha256Record(digest: string, fileName: string): string {
	return `${digest}  ${fileName}\n`;
}

export async function withRestoredFile<T>(filePath: string, action: () => Promise<T>): Promise<T> {
	const original = new Uint8Array(await Bun.file(filePath).arrayBuffer());
	try {
		return await action();
	} finally {
		await Bun.write(filePath, original);
	}
}

export async function withRestoredFiles<T>(filePaths: readonly string[], action: () => Promise<T>): Promise<T> {
	const backups = new Map<string, Uint8Array | null>();
	for (const filePath of filePaths) {
		try {
			backups.set(filePath, new Uint8Array(await Bun.file(filePath).arrayBuffer()));
		} catch (error) {
			if (!isEnoent(error)) throw error;
			backups.set(filePath, null);
		}
	}
	try {
		return await action();
	} finally {
		for (const [filePath, original] of backups) {
			if (original) await Bun.write(filePath, original);
			else await fs.rm(filePath, { force: true });
		}
	}
}

export function parseCliOptions(argv: readonly string[]): CliOptions {
	const options: CliOptions = {
		dryRun: argv.includes("--dry-run"),
		packOnly: argv.includes("--pack"),
		skipCheck: argv.includes("--skip-check"),
	};
	const outputIndex = argv.indexOf("--output");
	if (outputIndex >= 0) {
		const value = argv[outputIndex + 1];
		if (!value || value.startsWith("--")) throw new Error("--output requires a directory");
		options.outputDir = path.resolve(value);
	}
	if (options.dryRun === options.packOnly) {
		throw new Error("Choose exactly one of --dry-run or --pack; npm publication is CI-only");
	}
	if (options.skipCheck && !options.dryRun) throw new Error("--skip-check is allowed only with --dry-run");
	return options;
}

export async function inspectForkTarball(tarballPath: string, metadata: ForkReleaseMetadata): Promise<Manifest> {
	const manifestResult = await $`tar -xOzf ${tarballPath} package/package.json`.quiet().nothrow();
	if (manifestResult.exitCode !== 0) throw new Error(`Cannot read package/package.json from ${tarballPath}`);
	const manifest = JSON.parse(manifestResult.stdout.toString()) as Manifest;
	validateForkManifest(manifest, metadata);
	const listing = await $`tar -tzf ${tarballPath}`.quiet().nothrow();
	const entries = listing.stdout.toString().split(/\r?\n/);
	if (listing.exitCode !== 0 || !entries.includes("package/dist/cli.js")) {
		throw new Error("Validated tarball is missing package/dist/cli.js");
	}
	if (!entries.includes("package/fork-release.json")) {
		throw new Error("Validated tarball is missing package/fork-release.json");
	}
	for (const legalFile of legalPayloadFiles(manifest.license)) {
		if (!entries.includes(`package/${legalFile}`)) {
			throw new Error(`Validated tarball is missing package/${legalFile}`);
		}
	}
	const metadataResult = await $`tar -xOzf ${tarballPath} package/fork-release.json`.quiet().nothrow();
	if (metadataResult.exitCode !== 0) throw new Error("Cannot read fork-release.json from validated tarball");
	const packedMetadata = parseForkReleaseMetadata(JSON.parse(metadataResult.stdout.toString()));
	if (JSON.stringify(packedMetadata) !== JSON.stringify(metadata)) {
		throw new Error("Packed fork-release.json does not match the release metadata used to build the tarball");
	}
	return manifest;
}

async function runCommand(argv: readonly string[], cwd: string): Promise<string> {
	const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
	return stdout;
}

async function validateInstalledTarball(tarballPath: string, metadata: ForkReleaseMetadata): Promise<void> {
	const prefix = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cn-install-"));
	try {
		await runCommand(["npm", "install", "--prefix", prefix, "--no-save", tarballPath], repoRoot);
		const cliPath = path.join(prefix, "node_modules", FORK_NPM_PACKAGE, "dist", "cli.js");
		const version = await runCommand(["bun", cliPath, "--version"], prefix);
		if (version.trim() !== `omp/${metadata.forkVersion}`) {
			throw new Error(`Installed omp reports ${version.trim()}, expected fork version ${metadata.forkVersion}`);
		}
		await runCommand(["bun", cliPath, "--help"], prefix);
		const smoke = await runCommand(["bun", cliPath, "--smoke-test"], prefix);
		if (!smoke.includes("smoke-test: ok")) throw new Error("Installed omp smoke test did not report success");
	} finally {
		await fs.rm(prefix, { recursive: true, force: true });
	}
}

async function packValidatedTarball(
	metadata: ForkReleaseMetadata,
): Promise<{ tempDir: string; tarballPath: string; sha256: string }> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cn-pack-"));
	try {
		const result = await $`bun pm pack --quiet --destination ${tempDir}`.cwd(packageDir).quiet().nothrow();
		if (result.exitCode !== 0) throw new Error(`bun pm pack failed: ${result.stderr.toString().trim()}`);
		const tarballName = (await fs.readdir(tempDir)).find(entry => entry.endsWith(".tgz"));
		if (!tarballName) throw new Error("bun pm pack produced no tarball");
		const tarballPath = path.join(tempDir, tarballName);
		await inspectForkTarball(tarballPath, metadata);
		await validateInstalledTarball(tarballPath, metadata);
		return { tempDir, tarballPath, sha256: await sha256File(tarballPath) };
	} catch (error) {
		await fs.rm(tempDir, { recursive: true, force: true });
		throw error;
	}
}

async function runChecks(skip: boolean): Promise<void> {
	if (skip) return;
	const result = await $`bun run check:ts`.cwd(repoRoot).nothrow();
	if (result.exitCode !== 0) throw new Error(`TypeScript checks failed with exit code ${result.exitCode}`);
}

async function main(): Promise<void> {
	const options = parseCliOptions(process.argv.slice(2));
	assertSecureTlsEnvironment();
	const packageEntry = packages.find(pkg => pkg.dir === packageRelDir);
	if (!packageEntry) throw new Error(`Publish configuration is missing ${packageRelDir}`);
	const metadata = await loadForkReleaseMetadata();
	await runChecks(options.skipCheck);
	let packed: { tempDir: string; tarballPath: string; sha256: string } | undefined;
	await withRestoredFiles(
		legalPayloadFiles("MIT").map(fileName => path.join(packageDir, fileName)),
		async () =>
			withRestoredFile(manifestPath, async () => {
				try {
					await stageLegalPayloads(packageDir, "MIT", true, repoRoot);
					await applyPublishBin(packageRelDir, true);
					const manifest = (await Bun.file(manifestPath).json()) as Manifest;
					await Bun.write(manifestPath, `${JSON.stringify(createForkManifest(manifest, metadata), null, "\t")}\n`);
					packed = await packValidatedTarball(metadata);
					let retainedPath: string | undefined;
					if (options.outputDir) {
						await fs.mkdir(options.outputDir, { recursive: true });
						retainedPath = path.join(options.outputDir, path.basename(packed.tarballPath));
						await fs.copyFile(packed.tarballPath, retainedPath);
						await Bun.write(
							`${retainedPath}.sha256`,
							formatSha256Record(packed.sha256, path.basename(retainedPath)),
						);
					}
					const action = options.dryRun ? "DRY RUN" : "VALIDATED";
					const destination = retainedPath
						? ` -> ${retainedPath}`
						: options.packOnly
							? " (temporary tarball removed after validation)"
							: "";
					console.log(
						`${action} ${FORK_NPM_PACKAGE}@${metadata.forkVersion} sha256=${packed.sha256}${destination}`,
					);
				} finally {
					if (packed) await fs.rm(packed.tempDir, { recursive: true, force: true });
				}
			}),
	);
}

if (import.meta.main) await main();
