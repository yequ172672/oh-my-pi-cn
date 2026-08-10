import { afterEach, describe, expect, test, vi } from "bun:test";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("auth-broker login provider boundary", () => {
	test("does not advertise machine-local login providers", async () => {
		let output = "";
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		}) as typeof process.stdout.write);

		await runAuthBrokerCommand({ action: "list", flags: { json: true } });

		const providers = JSON.parse(output) as Array<{ id: string }>;
		expect(providers.some(provider => provider.id === "openai-codex")).toBe(true);
		expect(providers.some(provider => provider.id === "openai-codex-cli")).toBe(false);
	});

	test("rejects local and SSH broker login attempts before starting authentication", async () => {
		await expect(runAuthBrokerCommand({ action: "login", flags: { provider: "openai-codex-cli" } })).rejects.toThrow(
			/local-only.*auth-broker cannot transfer/i,
		);
		await expect(
			runAuthBrokerCommand({
				action: "login",
				flags: { provider: "openai-codex-cli", via: "user@example.invalid" },
			}),
		).rejects.toThrow(/local-only.*auth-broker cannot transfer/i);
	});
});
