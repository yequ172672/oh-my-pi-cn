import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const tempDirs: string[] = [];
const shell = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : (Bun.which("sh") ?? undefined);
const pwsh = Bun.which("pwsh") ?? undefined;

setDefaultTimeout(20_000);

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(directory);
	return directory;
}

async function writeExecutable(directory: string, name: string, content: string): Promise<void> {
	const file = path.join(directory, name);
	await Bun.write(file, content);
	await fs.chmod(file, 0o755);
}

function shellPath(file: string): string {
	if (process.platform !== "win32") return file;
	const normalized = file.replaceAll("\\", "/");
	return normalized.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

async function runShellInstaller(
	root: string,
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	if (!shell) throw new Error("No POSIX shell available");
	const binDir = shellPath(path.join(root, "bin"));
	const homeDir = shellPath(path.join(root, "home"));
	const installDir = shellPath(path.join(root, "install"));
	const sourceDir = shellPath(path.join(root, "source"));
	await fs.mkdir(path.join(root, "home"), { recursive: true });
	const proc = Bun.spawn(
		[
			shell,
			"-c",
			'export PATH="$1:/usr/bin:/bin" HOME="$2" PI_INSTALL_DIR="$3" OMP_SOURCE_DIR="$4"; shift 4; sh scripts/install.sh "$@"',
			"install-fork-test",
			binDir,
			homeDir,
			installDir,
			sourceDir,
			...args,
		],
		{ cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

const shellTest = shell ? test : test.skip;

describe("fork installer", () => {
	shellTest("explicit binary failure preserves an existing installation", async () => {
		const root = await makeTempDir("omp-install-binary-fail-");
		const binDir = path.join(root, "bin");
		const installDir = path.join(root, "install");
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(installDir, { recursive: true });
		await Bun.write(path.join(installDir, "omp"), "known-good");
		await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
		await writeExecutable(
			binDir,
			"curl",
			`#!/bin/sh
case "$*" in
  *api.github.com*) echo '{"tag_name":"omp-cn-v1.0.0"}' ;;
  *)
    while [ "$#" -gt 0 ]; do
      [ "$1" = "-o" ] && { printf partial > "$2"; exit 22; }
      shift
    done
    exit 22 ;;
esac
`,
		);

		const result = await runShellInstaller(root, ["--binary"]);

		expect(result.exitCode).not.toBe(0);
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe("known-good");
	});

	shellTest("auto mode falls back from a missing binary to the npm package", async () => {
		const root = await makeTempDir("omp-install-auto-fallback-");
		const binDir = path.join(root, "bin");
		const installDir = path.join(root, "install");
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(installDir, { recursive: true });
		await Bun.write(path.join(installDir, "omp"), "known-good");
		await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
		await writeExecutable(
			binDir,
			"curl",
			`#!/bin/sh
case "$*" in
  *api.github.com*) echo '{"tag_name":"omp-cn-v1.0.0"}' ;;
  *bun.sh/install*)
    cat <<'INSTALL'
mkdir -p "$HOME/.bun/bin"
cat > "$HOME/.bun/bin/bun" <<'BUN'
#!/bin/sh
case "$1" in
  --version) echo 1.3.14 ;;
  -e) echo -n x64 ;;
  install) echo npm > "$HOME/npm-install-marker" ;;
  *) exit 64 ;;
esac
BUN
chmod +x "$HOME/.bun/bin/bun"
INSTALL
    ;;
  *)
    while [ "$#" -gt 0 ]; do
      [ "$1" = "-o" ] && { printf partial > "$2"; exit 22; }
      shift
    done
    exit 22 ;;
esac
`,
		);

		const result = await runShellInstaller(root, []);

		expect(result.exitCode, result.stderr).toBe(0);
		expect(await Bun.file(path.join(root, "home", "npm-install-marker")).text()).toBe("npm\n");
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe("known-good");
		expect(result.stdout).toContain("falling back to the omp-cn npm package");
	});

	shellTest("a checksummed binary with the wrong release version preserves the installed command", async () => {
		const root = await makeTempDir("omp-install-version-mismatch-");
		const binDir = path.join(root, "bin");
		const installDir = path.join(root, "install");
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(installDir, { recursive: true });
		await Bun.write(path.join(installDir, "omp"), "known-good");
		await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
		await writeExecutable(
			binDir,
			"curl",
			`#!/bin/sh
out=""
for arg do
  if [ "$previous" = "-o" ]; then out="$arg"; fi
  previous="$arg"
done
case "$*" in
  *api.github.com*) echo '{"tag_name":"omp-cn-v1.0.0"}' ;;
  *SHA256SUMS.txt*)
    binary_file="$(find "$PI_INSTALL_DIR" -name '.omp-download.*' -print -quit)"
    digest="$(sha256sum "$binary_file" | awk '{print $1}')"
    printf '%s  omp-linux-x64\n' "$digest" > "$out"
    ;;
  *)
    printf '%s\n' '#!/bin/sh' 'echo omp/9.9.9' > "$out"
    ;;
esac
`,
		);

		const result = await runShellInstaller(root, ["--binary"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain("expected 'omp/1.0.0'");
		expect(await Bun.file(path.join(installDir, "omp")).text()).toBe("known-good");
	});

	shellTest("npm failure is surfaced without an implicit source fallback", async () => {
		const root = await makeTempDir("omp-install-npm-fail-");
		const binDir = path.join(root, "bin");
		await fs.mkdir(binDir, { recursive: true });
		await writeExecutable(
			binDir,
			"bun",
			`#!/bin/sh
case "$1" in
  --version) echo 1.3.14 ;;
  -e) echo -n x64 ;;
  install) exit 9 ;;
  *) exit 64 ;;
esac
`,
		);
		await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
		await writeExecutable(binDir, "git", `#!/bin/sh\necho called > "$HOME/git-marker"\nexit 1\n`);

		const result = await runShellInstaller(root, []);

		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain("Failed to install omp-cn from npm");
		expect(await Bun.file(path.join(root, "home", "git-marker")).exists()).toBe(false);
	});

	shellTest("explicit source mode keeps the linked checkout in persistent storage", async () => {
		const root = await makeTempDir("omp-install-source-");
		const binDir = path.join(root, "bin");
		await fs.mkdir(binDir, { recursive: true });
		await writeExecutable(binDir, "uname", '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
		await writeExecutable(
			binDir,
			"git",
			`#!/bin/sh
case "$1" in
  clone)
    for last do :; done
	mkdir -p "$last/packages/coding-agent" "$last/scripts"
    printf '{}' > "$last/package.json"
	printf '%s\n' '#!/bin/sh' 'echo wrapper >> "$HOME/bun-marker"' > "$last/scripts/link-omp.sh"
    ;;
  rev-parse) echo 0123456789abcdef ;;
  lfs) ;;
  *) exit 64 ;;
esac
`,
		);
		await writeExecutable(
			binDir,
			"bun",
			`#!/bin/sh
case "$1" in
  --version) echo 1.3.14 ;;
  -e) echo -n x64 ;;
  install) echo workspace-install >> "$HOME/bun-marker" ;;
  --cwd=*)
	[ "$2" = "link" ] || exit 65
	echo "\${1#--cwd=}" > "$HOME/link-target"
    ;;
  *) exit 64 ;;
esac
`,
		);

		const result = await runShellInstaller(root, ["--source"]);

		expect(result.exitCode, result.stderr).toBe(0);
		const target = (await Bun.file(path.join(root, "home", "link-target")).text()).trim();
		expect(target).toContain("0123456789abcdef/packages/coding-agent");
		expect(await Bun.file(path.join(root, "source", "0123456789abcdef", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(root, "home", "bun-marker")).text()).toContain("wrapper");
	});

	(pwsh ? test : test.skip)("PowerShell binary failure preserves an existing installation", async () => {
		if (!pwsh) return;
		const root = await makeTempDir("omp-install-powershell-fail-");
		const installDir = path.join(root, "install");
		const wrapper = path.join(root, "invoke.ps1");
		await fs.mkdir(installDir, { recursive: true });
		await Bun.write(path.join(installDir, "omp.exe"), "known-good");
		const installer = path.join(repoRoot, "scripts", "install.ps1").replaceAll("'", "''");
		await Bun.write(
			wrapper,
			`$env:PI_INSTALL_DIR = '${installDir.replaceAll("'", "''")}'
function Invoke-RestMethod {
    [pscustomobject]@{
        tag_name = 'omp-cn-v1.0.0'
        assets = @([pscustomobject]@{ name = 'omp-windows-x64.exe'; browser_download_url = 'https://example.invalid/omp.exe' })
    }
}
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [int]$TimeoutSec)
    [IO.File]::WriteAllText($OutFile, 'partial')
    throw 'simulated download failure'
}
try {
    & ([scriptblock]::Create((Get-Content -LiteralPath '${installer}' -Raw))) -Binary
    exit 0
} catch {
    Write-Error $_
    exit 1
}
`,
		);

		const proc = Bun.spawn([pwsh, "-NoProfile", "-File", wrapper], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, `${stdout}\n${stderr}`).not.toBe(0);
		expect(await Bun.file(path.join(installDir, "omp.exe")).text()).toBe("known-good");
	});

	(pwsh ? test : test.skip)("PowerShell rejects a checksummed asset with the wrong version", async () => {
		if (!pwsh) return;
		const root = await makeTempDir("omp-install-powershell-version-");
		const installDir = path.join(root, "install");
		const wrapper = path.join(root, "invoke.ps1");
		await fs.mkdir(installDir, { recursive: true });
		await Bun.write(path.join(installDir, "omp.exe"), "known-good");
		const installer = path.join(repoRoot, "scripts", "install.ps1").replaceAll("'", "''");
		await Bun.write(
			wrapper,
			`$env:PI_INSTALL_DIR = '${installDir.replaceAll("'", "''")}'
function Invoke-RestMethod {
    [pscustomobject]@{
        tag_name = 'omp-cn-v1.0.0'
        assets = @(
            [pscustomobject]@{ name = 'omp-windows-x64.exe'; browser_download_url = 'https://example.invalid/omp.exe' },
            [pscustomobject]@{ name = 'SHA256SUMS.txt'; browser_download_url = 'https://example.invalid/SHA256SUMS.txt' }
        )
    }
}
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [int]$TimeoutSec)
    if ($Uri -like '*SHA256SUMS.txt') {
        $digest = (Get-FileHash -LiteralPath $script:DownloadedFixture -Algorithm SHA256).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText($OutFile, "$digest  omp-windows-x64.exe\`n")
    } else {
        $script:DownloadedFixture = $OutFile
        if ($IsWindows) {
            Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\\cmd.exe') -Destination $OutFile
        } else {
            [IO.File]::WriteAllText($OutFile, "#!/bin/sh\`necho omp/0.0.0\`n")
            & chmod +x -- $OutFile
            if ($LASTEXITCODE -ne 0) { throw 'failed to mark fixture executable' }
        }
    }
}
try {
    & ([scriptblock]::Create((Get-Content -LiteralPath '${installer}' -Raw))) -Binary
    exit 0
} catch {
    Write-Error $_
    exit 1
}
`,
		);

		const proc = Bun.spawn([pwsh, "-NoProfile", "-File", wrapper], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, `${stdout}\n${stderr}`).not.toBe(0);
		expect(`${stdout}\n${stderr}`).toContain("expected 'omp/1.0.0'");
		expect(await Bun.file(path.join(installDir, "omp.exe")).text()).toBe("known-good");
	});

	(pwsh ? test : test.skip)("PowerShell atomically replaces an existing verified binary", async () => {
		if (!pwsh) return;
		const root = await makeTempDir("omp-install-powershell-replace-");
		const installDir = path.join(root, "install");
		const wrapper = path.join(root, "invoke.ps1");
		const fixture = path.join(root, "fixture.exe");
		const fixtureSource = path.join(root, "fixture.ts");
		await fs.mkdir(installDir, { recursive: true });
		await Bun.write(path.join(installDir, "omp.exe"), "known-good");
		await Bun.write(fixtureSource, 'process.stdout.write("omp/1.0.0\\n");\n');
		const compile = Bun.spawn([process.execPath, "build", "--compile", fixtureSource, "--outfile", fixture], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [compileExitCode, compileStdout, compileStderr] = await Promise.all([
			compile.exited,
			new Response(compile.stdout).text(),
			new Response(compile.stderr).text(),
		]);
		expect(compileExitCode, `${compileStdout}\n${compileStderr}`).toBe(0);
		const installer = path.join(repoRoot, "scripts", "install.ps1").replaceAll("'", "''");
		await Bun.write(
			wrapper,
			`$env:PI_INSTALL_DIR = '${installDir.replaceAll("'", "''")}'
$fixture = '${fixture.replaceAll("'", "''")}'
function Invoke-RestMethod {
    [pscustomobject]@{
        tag_name = 'omp-cn-v1.0.0'
        assets = @(
            [pscustomobject]@{ name = 'omp-windows-x64.exe'; browser_download_url = 'https://example.invalid/omp.exe' },
            [pscustomobject]@{ name = 'SHA256SUMS.txt'; browser_download_url = 'https://example.invalid/SHA256SUMS.txt' }
        )
    }
}
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [int]$TimeoutSec)
    if ($Uri -like '*SHA256SUMS.txt') {
        $digest = (Get-FileHash -LiteralPath $script:DownloadedFixture -Algorithm SHA256).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText($OutFile, "$digest  omp-windows-x64.exe\`n")
    } else {
        Copy-Item -LiteralPath $fixture -Destination $OutFile
        $script:DownloadedFixture = $OutFile
    }
}
& ([scriptblock]::Create((Get-Content -LiteralPath '${installer}' -Raw))) -Binary
`,
		);

		const proc = Bun.spawn([pwsh, "-NoProfile", "-File", wrapper], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
		expect(await Bun.file(path.join(installDir, "omp.exe")).bytes()).toEqual(await Bun.file(fixture).bytes());
	});
});
