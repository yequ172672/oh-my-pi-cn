import { afterEach, describe, expect, it, type Mock, spyOn, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as pluginCli from "@oh-my-pi/pi-coding-agent/cli/plugin-cli";
import * as updateCli from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import {
	buildBunInstallArgs,
	buildBunInstallArgsForRelease,
	buildHomebrewUpdateArgs,
	buildMiseForceInstallArgs,
	buildMiseUpgradeArgs,
	buildNpmInstallArgs,
	buildNpmInstallArgsForRelease,
	downloadVerifiedBinary,
	isMuslLinuxForTest,
	parseUpdateArgs,
	pruneBunInstallCache,
	replaceBinaryForUpdate,
	resolveBunGlobalNodeModulesDirFromLocations,
	resolveRegistryRelease,
	resolveReleaseBinaryAsset,
	resolveReleaseDist,
	resolveUpdateMethodForTest,
	shouldForceBinaryUpdate,
	sweepStaleBackups,
	updateViaBinaryAt,
	updateViaShimTakeover,
} from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import Update from "@oh-my-pi/pi-coding-agent/commands/update";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();

	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});
const TEST_CONFIG: CliConfig = {
	bin: "omp",
	version: "0.0.0-test",
	commands: new Map(),
};

describe("update command plugin dispatch", () => {
	it("routes -l to plugin upgrade instead of the app updater", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["-l"], TEST_CONFIG);
		await command.run();

		expect(pluginSpy).toHaveBeenCalledWith({ action: "upgrade", args: [], flags: {} });
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("keeps normal update flags on the app updater path", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["--check", "--force"], TEST_CONFIG);
		await command.run();

		expect(updateSpy).toHaveBeenCalledWith({ force: true, check: true });
		expect(pluginSpy).not.toHaveBeenCalled();
	});
});

describe("parseUpdateArgs", () => {
	it("preserves the legacy plugin update shorthand", () => {
		expect(parseUpdateArgs(["update", "-l"])).toEqual({ force: false, check: false, plugins: true });
	});
});

describe("update-cli libc detection", () => {
	it("does not mistake an installed musl loader for a glibc host", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "ldd (Ubuntu GLIBC 2.39-0ubuntu8.7) 2.39",
			}),
		).toBe(false);
	});

	it("recognizes a musl host from ldd output", () => {
		expect(
			isMuslLinuxForTest({
				platform: "linux",
				alpineRelease: false,
				lddOutput: "musl libc (x86_64)",
			}),
		).toBe(true);
	});
});

describe("update-cli install target detection", () => {
	it("uses bun update when prioritized omp is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses npm update when prioritized omp is inside an npm global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.npm-global/bin/omp", undefined, {
			npmBinDir: "/Users/test/.npm-global/bin",
		});

		expect(method).toBe("npm");
	});

	it("uses npm update for Windows npm command shims even when no package-manager bin dirs were detected", () => {
		const method = resolveUpdateMethodForTest("C:\\Users\\test\\AppData\\Roaming\\npm\\omp.cmd", undefined);

		expect(method).toBe("npm");
	});

	it("uses binary update when a plain file in the npm global bin dir is the standalone binary, not an npm symlink", () => {
		// Regression: with `npm prefix -g` pointed at the installer's default
		// (~/.local), directory containment alone misclassified the standalone
		// binary as npm-managed, so `npm install -g` failed with EEXIST refusing
		// to overwrite the existing executable.
		const method = resolveUpdateMethodForTest("/home/u/.local/bin/omp", undefined, {
			npmBinDir: "/home/u/.local/bin",
			ompIsRegularFile: true,
			platform: "linux",
		});

		expect(method).toBe("binary");
	});

	it("uses binary update when a plain file in the bun global bin dir is the standalone binary", () => {
		const method = resolveUpdateMethodForTest("/home/u/.local/bin/omp", "/home/u/.local/bin", {
			ompIsRegularFile: true,
			platform: "linux",
		});

		expect(method).toBe("binary");
	});

	it("keeps bun update for regular-file entries in the bun global bin dir on Windows, where bun writes .exe shims", () => {
		// On Windows a bun-managed global install is a regular-file .exe
		// launcher, not a symlink, so the standalone-binary override must not
		// apply there — it would clobber the shim with a raw binary. Paths use
		// forward slashes so the lexical containment check works on the POSIX
		// host running this suite; the platform gate is what is under test.
		const method = resolveUpdateMethodForTest("C:/Users/test/.bun/bin/omp.exe", "C:/Users/test/.bun/bin", {
			ompIsRegularFile: true,
			platform: "win32",
		});

		expect(method).toBe("bun");
	});

	it("still uses npm update when the npm global bin entry is a package-manager symlink, not a plain file", () => {
		const method = resolveUpdateMethodForTest("/home/u/.local/bin/omp", undefined, {
			npmBinDir: "/home/u/.local/bin",
			ompIsRegularFile: false,
		});

		expect(method).toBe("npm");
	});

	it("uses binary update when prioritized omp is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/omp", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/omp", undefined);

		expect(method).toBe("binary");
	});

	it("uses Homebrew update when prioritized omp resolves into the Homebrew formula", async () => {
		const dir = await makeTempDir();
		const prefix = path.join(dir, "opt", "omp");
		const linkedBin = path.join(dir, "bin");
		await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
		await fs.mkdir(linkedBin, { recursive: true });
		await Bun.write(path.join(prefix, "bin", "omp"), "binary");
		await fs.symlink(path.join(prefix, "bin", "omp"), path.join(linkedBin, "omp"));

		const method = resolveUpdateMethodForTest(path.join(linkedBin, "omp"), "/Users/test/.bun/bin", {
			homebrewPrefix: prefix,
		});

		expect(method).toBe("brew");
	});

	it("uses mise update when prioritized omp is in an active mise bin path", () => {
		const method = resolveUpdateMethodForTest(
			"/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin/omp",
			undefined,
			{
				miseBinDirs: ["/Users/test/.local/share/mise/installs/github-can1357-oh-my-pi/latest/bin"],
			},
		);

		expect(method).toBe("mise");
	});

	it("uses mise update when prioritized omp is a mise shim", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/share/mise/shims/omp", undefined, {
			miseDataDir: "/Users/test/.local/share/mise",
		});

		expect(method).toBe("mise");
	});
});

describe("update-cli package manager commands", () => {
	it("targets the Homebrew tap formula and switches to reinstall for forced updates", () => {
		expect(buildHomebrewUpdateArgs(false)).toEqual(["upgrade", "yequ172672/tap/omp-cn"]);
		expect(buildHomebrewUpdateArgs(true)).toEqual(["reinstall", "yequ172672/tap/omp-cn"]);
	});

	it("targets the mise GitHub backend tool and force-reinstalls the checked version when requested", () => {
		expect(buildMiseUpgradeArgs()).toEqual([
			"upgrade",
			"github:yequ172672/oh-my-pi-cn[version_prefix=omp-cn-v]",
			"--bump",
		]);
		expect(buildMiseForceInstallArgs("15.10.5")).toEqual([
			"install",
			"--force",
			"github:yequ172672/oh-my-pi-cn[version_prefix=omp-cn-v]@15.10.5",
		]);
	});

	it("pins npm package installs to the official registry and the checked native package versions", () => {
		const args = buildNpmInstallArgs("16.3.15", "win32-x64");

		expect(args.slice(0, 2)).toEqual(["install", "-g"]);
		expect(args).toContain("--registry=https://registry.npmjs.org/");
		expect(args).toContain("omp-cn@16.3.15");
		expect(args).toContain("@oh-my-pi/pi-natives@16.3.15");
		expect(args).toContain("@oh-my-pi/pi-natives-win32-x64@16.3.15");
	});

	it("installs an independently versioned fork package with its declared native core and leaf", () => {
		const release = { version: "17.2.12", nativeVersion: "17.2.11" };
		const npmArgs = buildNpmInstallArgsForRelease(release, "win32-x64");
		const bunArgs = buildBunInstallArgsForRelease(release, "linux-x64");

		expect(npmArgs).toContain("omp-cn@17.2.12");
		expect(npmArgs).toContain("@oh-my-pi/pi-natives@17.2.11");
		expect(npmArgs).toContain("@oh-my-pi/pi-natives-win32-x64@17.2.11");
		expect(bunArgs).toContain("omp-cn@17.2.12");
		expect(bunArgs).toContain("@oh-my-pi/pi-natives@17.2.11");
		expect(bunArgs).toContain("@oh-my-pi/pi-natives-linux-x64@17.2.11");
	});
});

describe("update-cli registry release metadata", () => {
	it("maps the published legacy 17.2.11 package to its original same-version native packages and v-tag", () => {
		expect(resolveRegistryRelease({ version: "17.2.11" })).toEqual({
			schemaVersion: 0,
			tag: "v17.2.11",
			version: "17.2.11",
			upstreamVersion: "17.2.11",
			nativeVersion: "17.2.11",
			upstreamCommit: null,
		});
	});

	it("uses schema 1 metadata to separate the fork, native, upstream, and GitHub release identities", () => {
		expect(
			resolveRegistryRelease({
				version: "17.2.12",
				ompFork: {
					schemaVersion: 1,
					forkVersion: "17.2.12",
					upstreamVersion: "17.2.11",
					nativeVersion: "17.2.11",
					upstreamCommit: "08819b279cf02ae2545e69dad7111ab48d91d35e",
				},
			}),
		).toEqual({
			schemaVersion: 1,
			tag: "omp-cn-v17.2.12",
			version: "17.2.12",
			upstreamVersion: "17.2.11",
			nativeVersion: "17.2.11",
			upstreamCommit: "08819b279cf02ae2545e69dad7111ab48d91d35e",
		});
	});

	it("rejects malformed schema metadata and a fork version that disagrees with npm", () => {
		const metadata = {
			schemaVersion: 1,
			forkVersion: "17.2.12",
			upstreamVersion: "17.2.11",
			nativeVersion: "17.2.11",
			upstreamCommit: "08819b279cf02ae2545e69dad7111ab48d91d35e",
		};

		expect(() => resolveRegistryRelease({ version: "17.2.12", ompFork: { ...metadata, schemaVersion: 2 } })).toThrow(
			"schemaVersion must be 1",
		);
		expect(() => resolveRegistryRelease({ version: "17.2.13", ompFork: metadata })).toThrow(
			"does not match package version 17.2.13",
		);
	});
});

describe("update-cli bun install command", () => {
	it("pins the official npm registry and bypasses the manifest cache so a stale mirror or snapshot cannot mask a freshly published version", () => {
		// Regression: omp queries https://registry.npmjs.org/<pkg>/latest directly.
		// The install MUST hit the same registry, otherwise:
		//   - a lagging mirror (corp proxy, Taobao, …) rejects the version with
		//     `No version matching "X" (but package exists)`,
		//   - or bun's local manifest snapshot does the same when the user's bun
		//     is already pointed at the official registry but its cache predates
		//     the release.
		// See https://github.com/can1357/oh-my-pi/issues/1686.
		const args = buildBunInstallArgs("15.7.6", "linux-x64");
		expect(args.slice(0, 5)).toEqual([
			"install",
			"-g",
			"--no-cache",
			"--registry=https://registry.npmjs.org/",
			"omp-cn@15.7.6",
		]);
	});

	it("pins the native addon core and the platform-specific leaf to the same version so the loader sentinel cannot drift on supported tags", () => {
		// Regression: bun install -g <pkg>@<v> would update only the top-level
		// package, leaving @oh-my-pi/pi-natives and @oh-my-pi/pi-natives-<tag>
		// at their previous version. The next launch then loaded a stale .node
		// file and aborted at validateLoadedBindings with `The .node file on
		// disk is from a different release than this loader`. See
		// https://github.com/can1357/oh-my-pi/issues/1824.
		for (const tag of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
			const args = buildBunInstallArgs("15.9.0", tag);
			expect(args).toContain("@oh-my-pi/pi-natives@15.9.0");
			expect(args).toContain(`@oh-my-pi/pi-natives-${tag}@15.9.0`);
		}
	});

	it("omits the leaf on unsupported platform tags so an EBADPLATFORM swap does not mask the underlying `no matching version` error", () => {
		// Defensive: an unsupported tag (e.g. linux-arm32) still installs the
		// core natives package — which will fail at module load if the platform
		// truly is unsupported — but we never request a leaf the release
		// pipeline doesn't publish, otherwise bun aborts with EBADPLATFORM
		// and hides the real diagnostic from `loadNative`'s aggregated error.
		const args = buildBunInstallArgs("15.9.0", "linux-arm");
		expect(args).toContain("@oh-my-pi/pi-natives@15.9.0");
		expect(args.some(arg => arg.startsWith("@oh-my-pi/pi-natives-"))).toBe(false);
	});

	it("derives global node_modules from supported bun global locations", () => {
		expect(resolveBunGlobalNodeModulesDirFromLocations(path.join("home", ".bun", "bin"), undefined)).toBe(
			path.join("home", ".bun", "install", "global", "node_modules"),
		);
		expect(
			resolveBunGlobalNodeModulesDirFromLocations(undefined, path.join("home", ".bun", "install", "cache")),
		).toBe(path.join("home", ".bun", "install", "global", "node_modules"));
	});
});

describe("update-cli bun cache pruning", () => {
	it("keeps only the newest cached version for filtered global install packages", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "react", "18.3.1@@@1"), "");
		await Bun.write(path.join(dir, "react", "19.2.6@@@1"), "");
		await Bun.write(
			path.join(dir, "react@18.3.1@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "18.3.1" }),
		);
		await Bun.write(
			path.join(dir, "react@19.2.6@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "19.2.6" }),
		);
		await Bun.write(path.join(dir, "@oh-my-pi", "pi-utils", "15.7.6@@@1"), "");
		await Bun.write(path.join(dir, "@oh-my-pi", "pi-utils", "15.8.0@@@1"), "");
		await Bun.write(
			path.join(dir, "@oh-my-pi", "pi-utils@15.7.6@@@1", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-utils", version: "15.7.6" }),
		);
		await Bun.write(
			path.join(dir, "@oh-my-pi", "pi-utils@15.8.0@@@1", "package.json"),
			JSON.stringify({ name: "@oh-my-pi/pi-utils", version: "15.8.0" }),
		);
		await Bun.write(path.join(dir, "chalk", "4.1.2@@@1"), "");
		await Bun.write(path.join(dir, "chalk", "5.6.2@@@1"), "");
		await Bun.write(
			path.join(dir, "chalk@4.1.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "4.1.2" }),
		);
		await Bun.write(
			path.join(dir, "chalk@5.6.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "5.6.2" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["react", "@oh-my-pi/pi-utils"]));

		expect(result).toEqual({ scannedPackages: 2, removedEntries: 4 });
		expect(await Bun.file(path.join(dir, "react", "18.3.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react@18.3.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react", "19.2.6@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "react@19.2.6@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils", "15.7.6@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils@15.7.6@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils", "15.8.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "@oh-my-pi", "pi-utils@15.8.0@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk", "4.1.2@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk@4.1.2@@@1", "package.json")).exists()).toBe(true);
	});

	it("keeps current registry-qualified marker entries with their materialized package", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["pkg"]));

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 0 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json")).exists()).toBe(true);
	});

	it("treats a stable release as newer than a matching prerelease", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0-beta.1@@@1"), "");
		await Bun.write(path.join(dir, "pkg", "1.0.0@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0-beta.1" }),
		);
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir);

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 2 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0-beta.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@@1", "package.json")).exists()).toBe(true);
	});

	it("compares numeric version segments without precision loss", async () => {
		const dir = await makeTempDir();
		const older = "1.0.99999999999999999999";
		const newer = "1.0.100000000000000000000";
		await Bun.write(path.join(dir, "pkg", `${older}@@@1`), "");
		await Bun.write(path.join(dir, "pkg", `${newer}@@@1`), "");
		await Bun.write(
			path.join(dir, `pkg@${older}@@@1`, "package.json"),
			JSON.stringify({ name: "pkg", version: older }),
		);
		await Bun.write(
			path.join(dir, `pkg@${newer}@@@1`, "package.json"),
			JSON.stringify({ name: "pkg", version: newer }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["pkg"]));

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 2 });
		expect(await Bun.file(path.join(dir, "pkg", `${older}@@@1`)).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, `pkg@${older}@@@1`, "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg", `${newer}@@@1`)).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, `pkg@${newer}@@@1`, "package.json")).exists()).toBe(true);
	});
});

describe("update-cli release binary integrity", () => {
	const tag = "v17.1.2";
	const binaryName = "omp-linux-x64";
	const url = `https://github.com/yequ172672/oh-my-pi-cn/releases/download/${tag}/${binaryName}`;
	const content = "verified binary";
	const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;

	function releaseAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			tag_name: tag,
			draft: false,
			prerelease: false,
			assets: [
				{
					name: binaryName,
					state: "uploaded",
					size: Buffer.byteLength(content),
					digest,
					browser_download_url: url,
					...overrides,
				},
			],
		};
	}

	it("selects an uploaded asset with a valid SHA-256 digest", () => {
		expect(resolveReleaseBinaryAsset(releaseAsset(), tag, binaryName)).toEqual({
			url,
			size: Buffer.byteLength(content),
			digest,
		});
	});

	it("rejects missing and unsupported release asset digests", () => {
		expect(() => resolveReleaseBinaryAsset(releaseAsset({ digest: null }), tag, binaryName)).toThrow("has no digest");
		expect(() => resolveReleaseBinaryAsset(releaseAsset({ digest: "sha512:abc" }), tag, binaryName)).toThrow(
			"has an unsupported digest",
		);
	});

	it("rejects release metadata that does not identify one exact stable asset", () => {
		expect(() => resolveReleaseBinaryAsset({ ...releaseAsset(), prerelease: true }, tag, binaryName)).toThrow(
			"is not a published stable release",
		);
		expect(() => resolveReleaseBinaryAsset({ ...releaseAsset(), assets: [] }, tag, binaryName)).toThrow(
			`has 0 assets named ${binaryName}`,
		);
		expect(() =>
			resolveReleaseBinaryAsset(
				{ ...releaseAsset(), assets: [releaseAsset().assets, releaseAsset().assets].flat() },
				tag,
				binaryName,
			),
		).toThrow(`has 2 assets named ${binaryName}`);
		expect(() =>
			resolveReleaseBinaryAsset(
				releaseAsset({ browser_download_url: "https://example.com/omp-linux-x64" }),
				tag,
				binaryName,
			),
		).toThrow("has an unexpected download URL");
	});

	it("writes a download only after its size and digest match", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);

		await downloadVerifiedBinary({
			url,
			targetPath,
			expectedSize: Buffer.byteLength(content),
			expectedDigest: digest,
			fetchImpl: async () => new Response(content),
		});

		expect(await Bun.file(targetPath).text()).toBe(content);
		if (process.platform !== "win32") expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755);
	});

	it("aborts the response stream as soon as it exceeds the expected size", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls++;
					controller.enqueue(new Uint8Array(pulls === 1 ? 2 : 1));
					if (pulls === 2) controller.close();
				},
			},
			{ highWaterMark: 0 },
		);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: 1,
				expectedDigest: digest,
				fetchImpl: async () => new Response(body),
			}),
		).rejects.toThrow("received at least 2");
		expect(pulls).toBe(1);
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("wraps a timeout during body streaming with a friendly message", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.enqueue(new Uint8Array(1));
					controller.error(new DOMException("The operation timed out.", "TimeoutError"));
				},
			},
			{ highWaterMark: 0 },
		);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content),
				expectedDigest: digest,
				fetchImpl: async () => new Response(body),
			}),
		).rejects.toThrow("Timed out downloading release binary after 15 minutes");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("removes downloads whose size or digest does not match", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const fetchImpl = async () => new Response(content);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content) + 1,
				expectedDigest: digest,
				fetchImpl,
			}),
		).rejects.toThrow("size mismatch");
		expect(await Bun.file(targetPath).exists()).toBe(false);

		await expect(
			downloadVerifiedBinary({
				url,
				targetPath,
				expectedSize: Buffer.byteLength(content),
				expectedDigest: `sha256:${createHash("sha256").update("different binary").digest("hex")}`,
				fetchImpl,
			}),
		).rejects.toThrow("digest mismatch");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});

	it("rejects an altered version-reporting executable before replacing the installed binary", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const installed = "#!/bin/sh\necho omp/17.0.8\n";
		const altered = "#!/bin/sh\necho omp/17.1.2\n";
		const expectedDigest = `sha256:${createHash("sha256")
			.update("x".repeat(Buffer.byteLength(altered)))
			.digest("hex")}`;
		await Bun.write(targetPath, installed);
		await fs.chmod(targetPath, 0o755);

		const metadataAuthorizations: Array<string | null> = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.startsWith("https://api.github.com/")) {
				metadataAuthorizations.push(new Headers(init?.headers).get("Authorization"));
				return new Response(
					JSON.stringify(
						releaseAsset({
							size: Buffer.byteLength(altered),
							digest: expectedDigest,
						}),
					),
				);
			}
			if (requestUrl === url) return new Response(altered);
			throw new Error(`Unexpected request: ${requestUrl}`);
		};

		const previousGitHubToken = Bun.env.GITHUB_TOKEN;
		Bun.env.GITHUB_TOKEN = "test-token";
		try {
			await expect(
				updateViaBinaryAt(targetPath, "17.1.2", {
					binaryName,
					fetchImpl,
				}),
			).rejects.toThrow("digest mismatch");
			expect(metadataAuthorizations).toEqual(["Bearer test-token"]);
			expect(await Bun.file(targetPath).text()).toBe(installed);
			if (process.platform !== "win32") expect((await fs.stat(targetPath)).mode & 0o777).toBe(0o755);
			expect(await Bun.file(`${targetPath}.new`).exists()).toBe(false);
		} finally {
			if (previousGitHubToken === undefined) delete Bun.env.GITHUB_TOKEN;
			else Bun.env.GITHUB_TOKEN = previousGitHubToken;
		}
	});

	it("explains how to authenticate after an anonymous GitHub API rate limit", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, binaryName);
		const fetchImpl = async () => new Response(null, { status: 403, statusText: "rate limit exceeded" });

		await expect(
			updateViaBinaryAt(targetPath, "17.1.2", {
				binaryName,
				fetchImpl,
				githubToken: "",
			}),
		).rejects.toThrow("retry later or set GITHUB_TOKEN or GH_TOKEN");
		expect(await Bun.file(targetPath).exists()).toBe(false);
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous omp binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});

describe("update-cli binary replacement on locked backups", () => {
	it("treats an EPERM on backup cleanup as a successful, completed update", async () => {
		// Regression: on Windows the binary moved aside during the swap is still
		// the running process image, so unlinking it throws EPERM. That cleanup
		// failure must not turn a verified swap into "Update failed" (issue #845).
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.1700000000000.4242.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		const realUnlink = nodeFs.promises.unlink.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "unlink").mockImplementation(async (p: nodeFs.PathLike) => {
			if (String(p) === backupPath) {
				const err = new Error(`EPERM: operation not permitted, unlink '${p}'`) as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return realUnlink(p);
		});
		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
		} finally {
			spy.mockRestore();
		}

		// New binary is installed and the temp consumed even though the locked
		// backup survives; the next run's sweep reclaims it once it is unlocked.
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).text()).toBe("old binary");
	});
});

describe("update-cli stale backup sweep", () => {
	it("reclaims timestamped and legacy backups while leaving unrelated .bak files", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp.exe");
		await Bun.write(targetPath, "current binary");
		await Bun.write(`${targetPath}.bak`, "legacy backup");
		await Bun.write(`${targetPath}.1700000000000.4242.bak`, "timestamped backup");
		await Bun.write(`${targetPath}.1800000000000.99.bak`, "another backup");
		// Must survive: foreign basename and a non-numeric middle segment.
		await Bun.write(path.join(dir, "notes.bak"), "keep me");
		await Bun.write(`${targetPath}.config.bak`, "keep me too");

		await sweepStaleBackups(targetPath);

		expect(await Bun.file(targetPath).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1800000000000.99.bak`).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "notes.bak")).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.bak`).exists()).toBe(true);
	});
});

describe("update-cli binary-only release gating", () => {
	it("honors an explicit omp.dist field from the registry manifest", () => {
		expect(resolveReleaseDist({ omp: { dist: "binary" } })).toBe("binary");
		expect(resolveReleaseDist({ omp: { dist: "npm" } })).toBe("npm");
	});

	it("treats unknown dist values as binary-only", () => {
		expect(resolveReleaseDist({ omp: { dist: "cargo" } })).toBe("binary");
	});

	it("returns undefined when the manifest carries no dist field", () => {
		expect(resolveReleaseDist({ version: "1.2.3" })).toBeUndefined();
		expect(resolveReleaseDist({ omp: {} })).toBeUndefined();
		expect(resolveReleaseDist(undefined)).toBeUndefined();
	});

	it("forces binary updates when dist is binary regardless of version", () => {
		expect(shouldForceBinaryUpdate({ version: "1.2.3", dist: "binary" }, "1.2.2")).toBe(true);
	});

	it("allows package-manager updates across majors when dist is explicitly npm", () => {
		expect(shouldForceBinaryUpdate({ version: "2.0.0", dist: "npm" }, "1.9.0")).toBe(false);
	});

	it("forces binary updates on a major bump without a dist field", () => {
		expect(shouldForceBinaryUpdate({ version: "2.0.0" }, "1.9.0")).toBe(true);
		expect(shouldForceBinaryUpdate({ version: "2.0.0-rc.1" }, "1.9.0")).toBe(true);
	});

	it("keeps package-manager updates within the same major and on downgrades", () => {
		expect(shouldForceBinaryUpdate({ version: "1.10.0" }, "1.9.0")).toBe(false);
		expect(shouldForceBinaryUpdate({ version: "1.0.0" }, "2.0.0")).toBe(false);
	});
});

describe("update-cli script-shim takeover", () => {
	const version = "18.0.0";
	const tag = `omp-cn-v${version}`;
	const binaryName = "omp-windows-x64.exe";
	const url = `https://github.com/yequ172672/oh-my-pi-cn/releases/download/${tag}/${binaryName}`;

	function makeFetch(content: string): (input: string | URL | Request) => Promise<Response> {
		const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
		return async (input: string | URL | Request): Promise<Response> => {
			const requestUrl = String(input);
			if (requestUrl.startsWith("https://api.github.com/")) {
				return new Response(
					JSON.stringify({
						tag_name: tag,
						draft: false,
						prerelease: false,
						assets: [
							{
								name: binaryName,
								state: "uploaded",
								size: Buffer.byteLength(content),
								digest,
								browser_download_url: url,
							},
						],
					}),
				);
			}
			if (requestUrl === url) return new Response(content);
			throw new Error(`Unexpected request: ${requestUrl}`);
		};
	}

	const shims: Record<string, string> = {
		omp: "#!/bin/sh\nnode omp.js\n",
		"omp.cmd": "@node omp.js %*\n",
		"omp.ps1": "node omp.js @args\n",
	};

	async function writeShims(dir: string): Promise<void> {
		for (const name in shims) {
			await Bun.write(path.join(dir, name), shims[name]);
		}
	}

	function verifyDownloadedExe(dir: string, content: string, reportedVersion: string) {
		return async (binaryPath: string, expectedVersion: string) => {
			expect(binaryPath).toBe(path.join(dir, "omp.exe"));
			expect(await Bun.file(binaryPath).text()).toBe(content);
			return { ok: reportedVersion === expectedVersion, actual: reportedVersion, path: binaryPath };
		};
	}

	it("installs omp.exe beside the shims and retires them", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		// The verifier asserts the explicit exe path. Executing a POSIX fixture
		// named omp.exe is not portable to Windows test hosts.
		const exe = `#!/bin/sh\necho omp/${version}\n`;

		await updateViaShimTakeover(path.join(dir, "omp.cmd"), version, {
			binaryName,
			fetchImpl: makeFetch(exe),
			githubToken: "test-token",
			releaseTag: tag,
			verifyBinary: verifyDownloadedExe(dir, exe, version),
		});

		expect(await Bun.file(path.join(dir, "omp.exe")).text()).toBe(exe);
		for (const name in shims) {
			expect(await Bun.file(path.join(dir, name)).exists()).toBe(false);
		}
		const residue = (await fs.readdir(dir)).filter(name => name.endsWith(".bak") || name.endsWith(".new"));
		expect(residue).toEqual([]);
	});

	it("restores the shims and removes the exe when the exe reports the wrong version", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		// Executable runs but reports the previous version -> full rollback.
		const exe = "#!/bin/sh\necho omp/17.2.12\n";

		await expect(
			updateViaShimTakeover(path.join(dir, "omp.cmd"), version, {
				binaryName,
				fetchImpl: makeFetch(exe),
				githubToken: "test-token",
				releaseTag: tag,
				verifyBinary: verifyDownloadedExe(dir, exe, "17.2.12"),
			}),
		).rejects.toThrow(/still reports 17\.2\.12 \(expected 18\.0\.0\); restored previous omp launcher/);

		expect(await Bun.file(path.join(dir, "omp.exe")).exists()).toBe(false);
		for (const name in shims) {
			expect(await Bun.file(path.join(dir, name)).text()).toBe(shims[name]);
		}
		const residue = (await fs.readdir(dir)).filter(name => name.endsWith(".bak") || name.endsWith(".new"));
		expect(residue).toEqual([]);
	});

	function renameLockingPs1(): Mock<typeof nodeFs.promises.rename> {
		const realRename = nodeFs.promises.rename;
		return spyOn(nodeFs.promises, "rename").mockImplementation(async (from, to) => {
			if (path.basename(String(from)) === "omp.ps1") {
				throw Object.assign(new Error("EPERM: file is locked"), { code: "EPERM" });
			}
			return await realRename(from, to);
		});
	}

	it("rewrites an immovable precedence-winning shim as a forwarder to the exe", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		const exe = `#!/bin/sh\necho omp/${version}\n`;
		const renameSpy = renameLockingPs1();
		try {
			await updateViaShimTakeover(path.join(dir, "omp.cmd"), version, {
				binaryName,
				fetchImpl: makeFetch(exe),
				githubToken: "test-token",
				releaseTag: tag,
				verifyBinary: verifyDownloadedExe(dir, exe, version),
			});
		} finally {
			renameSpy.mockRestore();
		}

		expect(await Bun.file(path.join(dir, "omp.exe")).text()).toBe(exe);
		expect(await Bun.file(path.join(dir, "omp")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "omp.cmd")).exists()).toBe(false);
		// PowerShell resolves .ps1 before .exe: the locked shim must now exec
		// the new binary instead of keeping its old body.
		expect(await Bun.file(path.join(dir, "omp.ps1")).text()).toContain('& "$PSScriptRoot\\omp.exe" @args');
	});

	it("restores a forwarded shim's original body when verification fails", async () => {
		const dir = await makeTempDir();
		await writeShims(dir);
		const exe = "#!/bin/sh\necho omp/17.2.12\n";
		const renameSpy = renameLockingPs1();
		try {
			await expect(
				updateViaShimTakeover(path.join(dir, "omp.cmd"), version, {
					binaryName,
					fetchImpl: makeFetch(exe),
					githubToken: "test-token",
					releaseTag: tag,
					verifyBinary: verifyDownloadedExe(dir, exe, "17.2.12"),
				}),
			).rejects.toThrow("restored previous omp launcher");
		} finally {
			renameSpy.mockRestore();
		}

		expect(await Bun.file(path.join(dir, "omp.exe")).exists()).toBe(false);
		for (const name in shims) {
			expect(await Bun.file(path.join(dir, name)).text()).toBe(shims[name]);
		}
	});
});
