import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import {
	assertSecureTlsEnvironment,
	createForkManifest,
	FORK_HOMEPAGE,
	FORK_NPM_PACKAGE,
	FORK_PACKAGE_DESCRIPTION,
	FORK_REPOSITORY,
	type ForkReleaseMetadata,
	formatSha256Record,
	inspectForkTarball,
	parseCliOptions,
	parseForkReleaseMetadata,
	sha256File,
	withRestoredFile,
	withRestoredFiles,
} from "./publish-fork-package";

const metadata: ForkReleaseMetadata = {
	schemaVersion: 1,
	forkVersion: "17.2.11-cn.1",
	upstreamVersion: "17.2.11",
	nativeVersion: "17.2.11",
	upstreamCommit: "0123456789abcdef0123456789abcdef01234567",
};

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("fork npm package manifest", () => {
	it("publishes an independent fork version while retaining upstream and native dependency versions", () => {
		const manifest = createForkManifest(
			{
				name: "@oh-my-pi/pi-coding-agent",
				version: "17.2.11",
				license: "MIT",
				bin: { omp: "dist/cli.js" },
				dependencies: {
					"@oh-my-pi/pi-ai": "workspace:*",
					"@oh-my-pi/pi-natives": "workspace:*",
					chalk: "5.0.0",
				},
			},
			metadata,
		);

		expect(manifest.name).toBe(FORK_NPM_PACKAGE);
		expect(manifest.version).toBe(metadata.forkVersion);
		expect(manifest.description).toBe(FORK_PACKAGE_DESCRIPTION);
		expect(manifest.license).toBe("MIT");
		expect(manifest.homepage).toBe(FORK_HOMEPAGE);
		expect(manifest.repository).toEqual({
			type: "git",
			url: `git+https://github.com/${FORK_REPOSITORY}.git`,
			directory: "packages/coding-agent",
		});
		expect(manifest.dependencies).toEqual({
			"@oh-my-pi/pi-ai": metadata.upstreamVersion,
			"@oh-my-pi/pi-natives": metadata.nativeVersion,
			chalk: "5.0.0",
		});
		expect(manifest.ompFork).toEqual({ ...metadata, releaseTag: `omp-cn-v${metadata.forkVersion}` });
		expect(manifest.files).toEqual(expect.arrayContaining(["LICENSE", "THIRD-PARTY-NOTICES.txt"]));
	});

	it("rejects malformed versions and upstream commit identities", () => {
		expect(() => parseForkReleaseMetadata({ ...metadata, forkVersion: "17.02.11" })).toThrow("valid SemVer");
		expect(() => parseForkReleaseMetadata({ ...metadata, upstreamCommit: "abc" })).toThrow("40-character");
	});

	it("rejects disabled TLS before any release command can run", () => {
		expect(() => assertSecureTlsEnvironment({ NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toThrow(
			"disables TLS verification",
		);
	});

	it("allows skipped checks only for a dry run", () => {
		expect(parseCliOptions(["--dry-run", "--skip-check"]).skipCheck).toBe(true);
		expect(() => parseCliOptions(["--pack", "--skip-check"])).toThrow("allowed only with --dry-run");
		expect(() => parseCliOptions(["--skip-check"])).toThrow("exactly one");
	});

	it("requires an explicit non-publishing package mode", () => {
		expect(parseCliOptions(["--dry-run"]).dryRun).toBe(true);
		expect(parseCliOptions(["--pack"]).packOnly).toBe(true);
		expect(() => parseCliOptions([])).toThrow("npm publication is CI-only");
		expect(() => parseCliOptions(["--dry-run", "--pack"])).toThrow("exactly one");
	});

	it("records a reproducible SHA-256 for the exact validated archive", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cn-sha-test-"));
		tempDirs.push(root);
		const artifact = path.join(root, "omp-cn.tgz");
		await Bun.write(artifact, "abc");
		const digest = await sha256File(artifact);
		expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
		expect(formatSha256Record(digest, "omp-cn.tgz")).toBe(`${digest}  omp-cn.tgz\n`);
	});

	it("restores the exact source bytes when temporary manifest work fails", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cn-restore-test-"));
		tempDirs.push(root);
		const manifest = path.join(root, "package.json");
		const original = new Uint8Array([0, 1, 2, 127, 128, 255]);
		await Bun.write(manifest, original);

		await expect(
			withRestoredFile(manifest, async () => {
				await Bun.write(manifest, "temporary publish manifest");
				throw new Error("simulated pack failure");
			}),
		).rejects.toThrow("simulated pack failure");

		expect(new Uint8Array(await Bun.file(manifest).arrayBuffer())).toEqual(original);
	});

	it("restores existing legal payloads and removes temporary staged files after failure", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cn-legal-restore-test-"));
		tempDirs.push(root);
		const license = path.join(root, "LICENSE");
		const notices = path.join(root, "THIRD-PARTY-NOTICES.txt");
		const originalLicense = new Uint8Array([0, 1, 255]);
		await Bun.write(license, originalLicense);

		await expect(
			withRestoredFiles([license, notices], async () => {
				await Bun.write(license, "temporary license");
				await Bun.write(notices, "temporary notices");
				throw new Error("simulated staging failure");
			}),
		).rejects.toThrow("simulated staging failure");

		expect(new Uint8Array(await Bun.file(license).arrayBuffer())).toEqual(originalLicense);
		expect(await Bun.file(notices).exists()).toBe(false);
	});

	it("validates the actual manifest and bundle entry inside a tgz", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cn-tar-test-"));
		tempDirs.push(root);
		const packageRoot = path.join(root, "package");
		await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
		const manifest = createForkManifest(
			{
				license: "MIT",
				bin: { omp: "dist/cli.js" },
				dependencies: { "@oh-my-pi/pi-ai": metadata.upstreamVersion },
			},
			metadata,
		);
		await Bun.write(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
		await Bun.write(path.join(packageRoot, "fork-release.json"), JSON.stringify(metadata));
		await Bun.write(path.join(packageRoot, "dist", "cli.js"), "#!/usr/bin/env bun\n");
		await Bun.write(path.join(packageRoot, "LICENSE"), "MIT\n");
		await Bun.write(path.join(packageRoot, "THIRD-PARTY-NOTICES.txt"), "notices\n");
		const tarball = path.join(root, "omp-cn.tgz");
		await $`tar -czf ${tarball} package`.cwd(root).quiet();

		const packed = await inspectForkTarball(tarball, metadata);
		expect(packed.name).toBe(FORK_NPM_PACKAGE);
	}, 15_000);
});
