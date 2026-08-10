import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai/registry";
import {
	getOAuthProviders,
	refreshOAuthToken,
	registerOAuthProvider,
	resolveOAuthCredentialProvider,
	unregisterOAuthProviders,
} from "@oh-my-pi/pi-ai/registry/oauth";
import * as anthropicOauth from "@oh-my-pi/pi-ai/registry/oauth/anthropic";
import type { OAuthCredentials, OAuthProvider } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { UsageProvider } from "@oh-my-pi/pi-ai/usage";

const FIXTURE_SOURCE = "provider-registry-test";
const ENV_KEYS = [
	"COREWEAVE_API_KEY",
	"ZENMUX_API_KEY",
	"EXA_API_KEY",
	"XAI_OAUTH_TOKEN",
	"UMANS_AI_CODING_PLAN_API_KEY",
	"LLAMA_CPP_API_KEY",
	"WANDB_API_KEY",
] as const;
const originalEnv = new Map(ENV_KEYS.map(key => [key, Bun.env[key]]));

afterEach(() => {
	unregisterOAuthProviders(FIXTURE_SOURCE);
	for (const key of ENV_KEYS) {
		const original = originalEnv.get(key);
		if (original === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = original;
		}
	}
	vi.restoreAllMocks();
});

describe("provider registry auth surface", () => {
	test("env-key map merges catalog names, registry defs, and legacy keys", () => {
		Bun.env.ZENMUX_API_KEY = "zenmux-env";
		Bun.env.EXA_API_KEY = "exa-env";
		// Plain name derived from the catalog table's `envVars`.
		expect(getEnvApiKey("zenmux")).toBe("zenmux-env");
		Bun.env.UMANS_AI_CODING_PLAN_API_KEY = "umans-env";
		expect(getEnvApiKey("umans")).toBe("umans-env");
		Bun.env.LLAMA_CPP_API_KEY = "llama-env";
		expect(getEnvApiKey("llama.cpp")).toBe("llama-env");
		// Exa is derived from the provider registry's `envKeys` definition.
		expect(getEnvApiKey("exa")).toBe("exa-env");
	});

	test("multi-var catalog env fallback picks names in order", () => {
		Bun.env.XAI_OAUTH_TOKEN = "xai-oauth-env";
		expect(getEnvApiKey("xai-oauth")).toBe("xai-oauth-env");

		Bun.env.WANDB_API_KEY = "wandb-env";
		expect(getEnvApiKey("coreweave")).toBe("wandb-env");
		Bun.env.COREWEAVE_API_KEY = "coreweave-env";
		expect(getEnvApiKey("coreweave")).toBe("coreweave-env");
	});

	test("login list contains loginable providers and excludes env-only model providers", () => {
		const ids = getOAuthProviders().map(provider => provider.id);
		expect(ids).toContain("openai-codex-cli");
		expect(ids).toContain("zenmux");
		expect(ids).toContain("kagi");
		expect(ids).toContain("exa");
		expect(ids).toContain("umans");
		expect(ids).toContain("llama.cpp");
		// openai has no interactive login flow.
		expect(ids).not.toContain("openai");
	});

	test("Codex CLI login alias authenticates the existing Codex model provider", () => {
		expect(resolveOAuthCredentialProvider("openai-codex-cli")).toBe("openai-codex");
		expect(resolveOAuthCredentialProvider("openai-codex")).toBe("openai-codex");
		expect(getOAuthProviders().find(provider => provider.id === "openai-codex-cli")?.loginLocalOnly).toBe(true);
	});

	test("paste-code login set is derived from pasteCodeFlow", () => {
		expect([...PASTE_CODE_LOGIN_PROVIDERS].sort()).toEqual(
			[
				"anthropic",
				"devin",
				"gitlab-duo",
				"gitlab-duo-agent",
				"google-antigravity",
				"google-gemini-cli",
				"openai-codex",
				"zai-coding-plan",
			].sort(),
		);
		expect(PASTE_CODE_LOGIN_PROVIDERS.has("zenmux")).toBe(false);
	});

	test("refresh dispatch returns api-key providers unchanged and routes real refreshers", async () => {
		const creds: OAuthCredentials = { refresh: "r", access: "a", expires: Date.now() + 60_000 };
		// zenmux has no refresher → returned as-is.
		expect(await refreshOAuthToken("zenmux", creds)).toBe(creds);

		const refreshed: OAuthCredentials = { refresh: "r2", access: "a2", expires: Date.now() + 120_000 };
		const spy = vi.spyOn(anthropicOauth, "refreshAnthropicToken").mockResolvedValue(refreshed);
		expect(await refreshOAuthToken("anthropic", creds)).toBe(refreshed);
		expect(spy).toHaveBeenCalledWith("r");

		await expect(refreshOAuthToken("nonexistent-provider" as OAuthProvider, creds)).rejects.toThrow(
			"Unknown OAuth provider",
		);
	});

	test("login dispatcher handles runtime-registered extension providers", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		registerOAuthProvider({
			id: "fixture-x",
			name: "Fixture X",
			sourceId: FIXTURE_SOURCE,
			login: async () => "fixture-key",
		});

		await storage.login("fixture-x", { onAuth: () => {}, onPrompt: async () => "" });

		expect(store.getApiKey("fixture-x")).toBe("fixture-key");
	});

	test("explicit CLI relinking replaces the old account link without removing other Codex credentials", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		let accountId = "codex-account-a";
		registerOAuthProvider({
			id: "fixture-codex-cli",
			name: "Fixture Codex CLI",
			sourceId: FIXTURE_SOURCE,
			storeCredentialsAs: "fixture-codex-models",
			login: async () => ({
				access: `access-${accountId}`,
				refresh: "__codex_cli_managed__",
				expires: Date.now() + 60_000,
				credentialSource: "codex-cli",
				accountId,
			}),
		});
		await storage.set("fixture-codex-models", {
			type: "oauth",
			access: "independent-browser-login",
			refresh: "independent-refresh",
			expires: Date.now() + 60_000,
			accountId: "browser-account",
		});

		await storage.login("fixture-codex-cli", { onAuth: () => {}, onPrompt: async () => "" });
		accountId = "codex-account-b";
		await storage.login("fixture-codex-cli", { onAuth: () => {}, onPrompt: async () => "" });

		const credentials = store.listAuthCredentials("fixture-codex-models").map(entry => entry.credential);
		expect(
			credentials.some(credential => credential.type === "oauth" && credential.accountId === "browser-account"),
		).toBe(true);
		const cliLinks = credentials.filter(
			credential => credential.type === "oauth" && credential.credentialSource === "codex-cli",
		);
		expect(cliLinks).toHaveLength(1);
		expect(cliLinks[0]).toMatchObject({ accountId: "codex-account-b" });
	});

	test("refresh persistence retains the external refresh-owner marker", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		registerOAuthProvider({
			id: "fixture-cli-refresh",
			name: "Fixture CLI Refresh",
			sourceId: FIXTURE_SOURCE,
			login: async () => ({ access: "unused", refresh: "unused", expires: 0 }),
			refreshToken: async credentials => ({
				access: "fresh-access",
				refresh: credentials.refresh,
				expires: Date.now() + 60 * 60_000,
				accountId: credentials.accountId,
			}),
		});
		await storage.set("fixture-cli-refresh", {
			type: "oauth",
			access: "expired-access",
			refresh: "__codex_cli_managed__",
			expires: Date.now() - 60_000,
			credentialSource: "codex-cli",
			accountId: "account-123",
		});

		expect(await storage.getApiKey("fixture-cli-refresh", "session-a")).toBe("fresh-access");
		expect(store.getOAuth("fixture-cli-refresh")).toMatchObject({ credentialSource: "codex-cli" });
	});

	test("usage refresh preserves the external refresh owner through its credential projection", async () => {
		const provider = "fixture-cli-usage-refresh";
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		let usageCredentialSource: string | undefined;
		registerOAuthProvider({
			id: provider,
			name: "Fixture CLI Usage Refresh",
			sourceId: FIXTURE_SOURCE,
			login: async () => ({ access: "unused", refresh: "unused", expires: 0 }),
			refreshToken: async credentials => {
				expect(credentials.credentialSource).toBe("codex-cli");
				return {
					access: "fresh-usage-access",
					refresh: credentials.refresh,
					expires: Date.now() + 60 * 60_000,
					accountId: credentials.accountId,
				};
			},
		});
		const usageProvider: UsageProvider = {
			id: provider,
			async fetchUsage({ credential }) {
				usageCredentialSource = credential.credentialSource;
				return { provider, fetchedAt: Date.now(), limits: [] };
			},
		};
		const storage = new AuthStorage(store, {
			usageProviderResolver: candidate => (candidate === provider ? usageProvider : undefined),
		});
		await storage.reload();
		await storage.set(provider, {
			type: "oauth",
			access: "expired-usage-access",
			refresh: "__codex_cli_managed__",
			expires: Date.now() - 60_000,
			credentialSource: "codex-cli",
			accountId: "account-123",
		});

		await storage.fetchUsageReports();

		expect(usageCredentialSource).toBe("codex-cli");
		expect(store.getOAuth(provider)).toMatchObject({
			access: "fresh-usage-access",
			credentialSource: "codex-cli",
		});
	});

	test("force refresh by id preserves a local Codex refresh owner", async () => {
		const provider = "fixture-cli-force-refresh";
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();
		registerOAuthProvider({
			id: provider,
			name: "Fixture CLI Force Refresh",
			sourceId: FIXTURE_SOURCE,
			login: async () => ({ access: "unused", refresh: "unused", expires: 0 }),
			refreshToken: async credentials => ({
				access: "force-refreshed-access",
				refresh: credentials.refresh,
				expires: Date.now() + 60 * 60_000,
				accountId: credentials.accountId,
			}),
		});
		await storage.set(provider, {
			type: "oauth",
			access: "old-access",
			refresh: "__codex_cli_managed__",
			expires: Date.now() + 60 * 60_000,
			credentialSource: "codex-cli",
			accountId: "account-123",
		});
		const row = store.listAuthCredentials(provider)[0];
		if (!row) throw new Error("expected stored credential");

		const refreshed = await storage.forceRefreshCredentialById(row.id);

		expect(refreshed.credential).toMatchObject({
			access: "force-refreshed-access",
			credentialSource: "codex-cli",
		});
		expect(store.getOAuth(provider)).toMatchObject({ credentialSource: "codex-cli" });
	});

	test("machine-local Codex credentials never use an injected refresh override", async () => {
		const provider = "fixture-cli-no-refresh-override";
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		let overrideCalled = false;
		const storage = new AuthStorage(store, {
			refreshOAuthCredential: async (_provider, _credentialId, credentials) => {
				overrideCalled = true;
				return credentials;
			},
		});
		await storage.reload();
		registerOAuthProvider({
			id: provider,
			name: "Fixture CLI No Override",
			sourceId: FIXTURE_SOURCE,
			login: async () => ({ access: "unused", refresh: "unused", expires: 0 }),
			refreshToken: async credentials => credentials,
		});
		await storage.set(provider, {
			type: "oauth",
			access: "expired-access",
			refresh: "__codex_cli_managed__",
			expires: Date.now() - 60_000,
			credentialSource: "codex-cli",
			accountId: "account-123",
		});

		expect(await storage.getApiKey(provider)).toBeUndefined();
		expect(overrideCalled).toBe(false);
		expect(store.getOAuth(provider)).toMatchObject({ credentialSource: "codex-cli" });
	});

	test("llama.cpp login stores a local no-auth token when no key is entered", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		await storage.reload();

		await storage.login("llama.cpp", { onAuth: () => {}, onPrompt: async () => "" });

		expect(store.getApiKey("llama.cpp")).toBe("llama-cpp-local");
	});
});
