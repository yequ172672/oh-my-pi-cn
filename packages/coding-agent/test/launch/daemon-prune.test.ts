import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { pruneDeadDaemonRuntimeDirs } from "../../src/launch/presence";

const STALE = new Date(Date.now() - 30 * 60_000);
let deadPid = 0;

async function scope(
	root: string,
	name: string,
	init: { pid?: number | "dead"; clients?: number[]; stale?: boolean },
): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(path.join(dir, "clients"), { recursive: true });
	if (init.pid !== undefined) {
		const pid = init.pid === "dead" ? deadPid : init.pid;
		await Bun.write(path.join(dir, "broker.pid"), JSON.stringify({ pid, instanceId: name }));
	}
	for (const clientPid of init.clients ?? []) {
		await Bun.write(
			path.join(dir, "clients", `${clientPid}-x.json`),
			JSON.stringify({ pid: clientPid, id: `${clientPid}-x`, projectDir: dir }),
		);
	}
	if (init.stale) await fs.utimes(dir, STALE, STALE);
	return dir;
}

describe("pruneDeadDaemonRuntimeDirs", () => {
	beforeAll(async () => {
		// A definitely-dead PID: spawn a process and reap it.
		const proc = Bun.spawn(["true"]);
		await proc.exited;
		deadPid = proc.pid;
	});

	it("removes only scopes with a dead broker, no live clients, and past the stale grace", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });

		const current = await scope(daemons, "current000000000", { pid: "dead", stale: true });
		await scope(daemons, "deadstale0000000", { pid: "dead", stale: true });
		await scope(daemons, "livebroker000000", { pid: process.pid, stale: true });
		await scope(daemons, "liveclient000000", { clients: [process.pid], stale: true });
		await scope(daemons, "deadfresh0000000", { pid: "dead" });
		// Machine-global daemon container must never be swept as a project scope.
		await fs.mkdir(path.join(daemons, "global", "some-service"), { recursive: true });
		await fs.utimes(path.join(daemons, "global"), STALE, STALE);

		await pruneDeadDaemonRuntimeDirs(current);

		const remaining = new Set(await fs.readdir(daemons));
		expect(remaining.has("deadstale0000000")).toBe(false); // pruned
		expect(remaining.has("current000000000")).toBe(true); // never prunes itself
		expect(remaining.has("livebroker000000")).toBe(true); // live broker
		expect(remaining.has("liveclient000000")).toBe(true); // live client presence
		expect(remaining.has("deadfresh0000000")).toBe(true); // within stale grace
		expect(remaining.has("global")).toBe(true); // global container skipped
	});

	it("does not sweep sibling machine-global service runtimes", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-global-");
		const globalRoot = path.join(tempDir.path(), "run", "daemons", "global");
		const current = await scope(globalRoot, "current-service", { pid: "dead", stale: true });
		const sibling = await scope(globalRoot, "persistent-service", { pid: "dead", stale: true });

		await pruneDeadDaemonRuntimeDirs(current);

		expect(await fs.exists(sibling)).toBe(true);
	});

	it("does nothing when the runtime root does not exist", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-missing-");
		const current = path.join(tempDir.path(), "run", "daemons", "hash0000000000000");
		await expect(pruneDeadDaemonRuntimeDirs(current)).resolves.toBeUndefined();
	});
});
