import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { executeList } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";
import { TempDir } from "@oh-my-pi/pi-utils";

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-13T17:14:48.125Z",
		cwd: "/tmp",
	});
}

describe("hub list", () => {
	it("restores persisted peers after the process registry is lost", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-persisted-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, `${sessionHeader("main")}\n`);
		// A settled subagent transcript: header + session_init. A header-only file
		// is a mid-spawn stub and stays unregistered by design.
		await Bun.write(
			workerSessionFile,
			`${[
				sessionHeader("worker"),
				JSON.stringify({
					type: "session_init",
					id: "si",
					parentId: null,
					timestamp: "2026-08-13T17:14:49.000Z",
					systemPrompt: "review",
					task: "review the diff",
					tools: ["read"],
				}),
			].join("\n")}\n`,
		);

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});

		const result = await executeList(registry, MAIN_AGENT_ID);
		if (!result.details) throw new Error("Expected coordination details");

		expect(result.details.peers).toEqual([
			expect.objectContaining({
				id: "Worker",
				kind: "sub",
				status: "parked",
				parentId: MAIN_AGENT_ID,
			}),
		]);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected text result");
		expect(content.text).toContain("Worker");
		expect(content.text).toContain("parked");
		expect(registry.get("Worker")?.sessionFile).toBe(workerSessionFile);
	});
});
