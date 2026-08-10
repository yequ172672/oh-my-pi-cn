import {
	loginOpenAICodex,
	loginOpenAICodexCli,
	refreshOpenAICodexCliToken,
	refreshOpenAICodexToken,
} from "./oauth/openai-codex";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const openaiCodexProvider = {
	id: "openai-codex",
	name: "ChatGPT Plus/Pro (Codex Subscription)",
	login: (cb: OAuthLoginCallbacks) => loginOpenAICodex(cb),
	refreshToken: async (credentials: OAuthCredentials) => {
		if (credentials.credentialSource === "codex-cli") {
			return refreshOpenAICodexCliToken(credentials);
		}
		return refreshOpenAICodexToken(credentials.refresh);
	},
	callbackPort: 1455,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;

export const openaiCodexCliProvider = {
	id: "openai-codex-cli",
	name: "Existing Codex CLI login (ChatGPT Plus/Pro)",
	login: (cb: OAuthLoginCallbacks) => loginOpenAICodexCli(cb),
	storeCredentialsAs: "openai-codex",
	loginLocalOnly: true,
} as const satisfies ProviderDefinition;
