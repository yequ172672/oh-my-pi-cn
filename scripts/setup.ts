#!/usr/bin/env bun
/**
 * `bun setup` entrypoint. Chains the four setup steps (install → native
 * addon build → coding-agent link → omp link) and forwards a single UX flag:
 *
 *   --cargo   Build the host native addon via the local Cargo/N-API path
 *             instead of bazel. Equivalent to
 *             `OMP_NATIVE_BUILD_BACKEND=cargo` — surfaced as a flag because
 *             bun/npm can't forward extra args past `&&`-chained scripts.
 *
 * Any other flags after `--` are appended to the native build invocation.
 */
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

const argv = process.argv.slice(2);
let cargo = false;
const passthrough: string[] = [];
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === "--") {
		passthrough.push(...argv.slice(i + 1));
		break;
	}
	if (arg === "--cargo") {
		cargo = true;
		continue;
	}
	passthrough.push(arg);
}

const nativeBackendEnv = cargo ? { OMP_NATIVE_BUILD_BACKEND: "cargo" } : {};

interface Step {
	label: string;
	cmd: string[];
	env?: Record<string, string>;
	cwd?: string;
}

const steps: Step[] = [
	{ label: "bun install", cmd: ["bun", "install"] },
	{ label: "build:native", cmd: ["bun", "run", "build:native", ...passthrough], env: nativeBackendEnv },
	{ label: "coding-agent link", cmd: ["bun", "--cwd=packages/coding-agent", "link"] },
	{ label: "link omp", cmd: ["sh", "scripts/link-omp.sh"] },
];

for (const step of steps) {
	console.log(`\n▶ ${step.label}`);
	const proc = Bun.spawn(step.cmd, {
		cwd: step.cwd ?? repoRoot,
		env: { ...process.env, ...(step.env ?? {}) },
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		console.error(`\nsetup step "${step.label}" failed (exit ${exitCode})`);
		process.exit(exitCode || 1);
	}
}
