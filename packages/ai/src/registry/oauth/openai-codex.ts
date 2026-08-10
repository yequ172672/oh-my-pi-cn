/**
 * OpenAI Codex (ChatGPT OAuth) flow — browser and device-code flows.
 */

import { OPENAI_HEADER_VALUES } from "@oh-my-pi/pi-catalog/wire/codex";
import { $which, readJsonl } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { isRecord } from "../../utils";
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const DEVICE_POLL_INTERVAL_MS = 5_000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;
/** Upper bound on device-code polling to avoid infinite loops on server errors. */
const DEVICE_MAX_POLLS = 120;
const CODEX_APP_SERVER_TIMEOUT_MS = 20_000;
const CODEX_APP_SERVER_EXIT_TIMEOUT_MS = 2_000;
const CODEX_CLI_REFRESH_SKEW_MS = 5 * 60_000;

/** Marker stored in OMP instead of copying Codex's single-use refresh token. */
export const CODEX_CLI_MANAGED_REFRESH_SENTINEL = "__codex_cli_managed__";

type JwtPayload = {
	exp?: number;
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
		chatgpt_plan_type?: string;
	};
	[JWT_PROFILE_CLAIM]?: {
		email?: string;
	};
	[key: string]: unknown;
};

export function decodeJwt<T = Record<string, unknown>>(token: string): T | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = Buffer.from(payload, "base64").toString("utf-8");
		return JSON.parse(decoded) as T;
	} catch {
		return null;
	}
}

/**
 * Identity slice decoded from the token claims. The ChatGPT workspace
 * (`chatgpt_account_id`) is the subscription pool the token draws limits
 * from — one account email can hold several (e.g. a personal Pro plan plus a
 * Team seat). `chatgpt_plan_type` may only be present on the `id_token`.
 */
function getTokenProfile(
	accessToken: string,
	idToken?: string,
): { accountId?: string; email?: string; planType?: string } {
	const payload = decodeJwt<JwtPayload>(accessToken);
	const idPayload = idToken ? decodeJwt<JwtPayload>(idToken) : null;
	const auth = payload?.[JWT_CLAIM_PATH];
	const idAuth = idPayload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id;
	const email = payload?.[JWT_PROFILE_CLAIM]?.email?.trim().toLowerCase();
	const planType = (auth?.chatgpt_plan_type ?? idAuth?.chatgpt_plan_type)?.trim().toLowerCase();
	return {
		accountId: typeof accountId === "string" && accountId.length > 0 ? accountId : undefined,
		email: typeof email === "string" && email.length > 0 ? email : undefined,
		planType: typeof planType === "string" && planType.length > 0 ? planType : undefined,
	};
}

export interface CodexCliRefreshOptions {
	readManagedCredentials?: (refreshToken: boolean, signal?: AbortSignal) => Promise<OAuthCredentials>;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse the short-lived access token returned by Codex app-server. OMP never
 * reads Codex's refresh token or depends on whether Codex stores it in a file
 * or the OS keyring.
 */
export function parseOpenAICodexCliAuthStatus(value: unknown): OAuthCredentials {
	if (!isRecord(value) || value.authMethod !== "chatgpt") {
		throw new AIError.OAuthError("Codex CLI is not logged in with ChatGPT", { kind: "validation" });
	}
	const accessToken = nonEmptyString(value.authToken);
	if (!accessToken) {
		throw new AIError.OAuthError("Codex CLI did not provide a usable ChatGPT access token", {
			kind: "validation",
		});
	}

	const payload = decodeJwt<JwtPayload>(accessToken);
	const expires = typeof payload?.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
	if (!expires) {
		throw new AIError.OAuthError("Codex CLI access token has no usable expiry claim", { kind: "validation" });
	}

	const profile = getTokenProfile(accessToken);
	const accountId = profile.accountId;
	if (!accountId) {
		throw new AIError.OAuthError("Codex CLI access token has no ChatGPT account id", { kind: "validation" });
	}

	return {
		access: accessToken,
		refresh: CODEX_CLI_MANAGED_REFRESH_SENTINEL,
		expires,
		credentialSource: "codex-cli",
		accountId,
		email: profile.email,
		orgId: accountId,
		orgName: profile.planType,
	};
}

interface CodexAppServerMessage {
	id?: unknown;
	result?: unknown;
	error?: unknown;
}

async function nextCodexAppServerResponse(
	messages: AsyncIterator<unknown>,
	id: number,
): Promise<CodexAppServerMessage> {
	for (;;) {
		const next = await messages.next();
		if (next.done) {
			throw new AIError.OAuthError("Codex app-server closed before returning authentication status", {
				kind: "token-refresh",
			});
		}
		if (!isRecord(next.value) || next.value.id !== id) continue;
		return next.value;
	}
}

/** Read a short-lived bearer while Codex remains the sole refresh-token owner. */
export async function readOpenAICodexCliCredentials(
	refreshToken: boolean,
	callerSignal?: AbortSignal,
): Promise<OAuthCredentials> {
	const executable = $which("codex");
	if (!executable) {
		throw new AIError.OAuthError("Codex CLI executable was not found in PATH", { kind: "token-refresh" });
	}

	const timeoutSignal = AbortSignal.timeout(CODEX_APP_SERVER_TIMEOUT_MS);
	const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
	const processHandle = Bun.spawn([executable, "app-server", "--listen", "stdio://"], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
		env: { ...process.env, RUST_LOG: "off" },
	});
	const input = processHandle.stdin;
	const messages = readJsonl<unknown>(processHandle.stdout as ReadableStream<Uint8Array>, signal)[
		Symbol.asyncIterator
	]();
	try {
		input.write(
			`${JSON.stringify({
				method: "initialize",
				id: 1,
				params: { clientInfo: { name: "omp", title: "Oh My Pi", version: "1" } },
			})}\n`,
		);
		await input.flush();
		const initialize = await nextCodexAppServerResponse(messages, 1);
		if (initialize.error !== undefined) {
			throw new AIError.OAuthError("Codex app-server rejected auth bridge initialization", {
				kind: "token-refresh",
			});
		}

		input.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
		input.write(
			`${JSON.stringify({
				method: "getAuthStatus",
				id: 2,
				params: { includeToken: true, refreshToken },
			})}\n`,
		);
		await input.flush();
		const status = await nextCodexAppServerResponse(messages, 2);
		if (status.error !== undefined) {
			throw new AIError.OAuthError("Installed Codex does not support sharing its current ChatGPT access token", {
				kind: "token-refresh",
			});
		}
		return parseOpenAICodexCliAuthStatus(status.result);
	} catch (error) {
		if (callerSignal?.aborted) {
			throw new AIError.AbortError("Codex app-server authentication request aborted by caller");
		}
		if (timeoutSignal.aborted) {
			throw new AIError.OAuthError("Codex app-server authentication request timed out", {
				kind: "token-refresh",
			});
		}
		throw error;
	} finally {
		try {
			input.end();
		} catch {
			// Process may already have closed its stdin after an initialization error.
		}
		try {
			processHandle.kill();
		} catch {
			// Process may already have exited after returning the response.
		}
		const exited = processHandle.exited.then(
			() => true,
			() => true,
		);
		const exitedGracefully = await Promise.race([
			exited,
			Bun.sleep(CODEX_APP_SERVER_EXIT_TIMEOUT_MS).then(() => false),
		]);
		if (!exitedGracefully) {
			try {
				processHandle.kill(9);
			} catch {
				// Process may have exited between the bounded wait and forced termination.
			}
			await Promise.race([exited, Bun.sleep(CODEX_APP_SERVER_EXIT_TIMEOUT_MS)]);
		}
	}
}

/**
 * Refresh an OMP credential linked to Codex CLI. A fresh bearer already held
 * by Codex wins; only an expired/near-expiry bearer requests rotation.
 */
export async function refreshOpenAICodexCliToken(
	_credentials: OAuthCredentials,
	options: CodexCliRefreshOptions = {},
): Promise<OAuthCredentials> {
	const readManagedCredentials = options.readManagedCredentials ?? readOpenAICodexCliCredentials;
	let current = await readManagedCredentials(false);
	if (_credentials.accountId && current.accountId !== _credentials.accountId) {
		throw new AIError.OAuthError(
			"Codex CLI is now logged in to a different ChatGPT account; run the existing Codex CLI login again in OMP to confirm the new binding",
			{ kind: "token-refresh" },
		);
	}
	if (current.expires > Date.now() + CODEX_CLI_REFRESH_SKEW_MS) return current;

	current = await readManagedCredentials(true);
	if (_credentials.accountId && current.accountId !== _credentials.accountId) {
		throw new AIError.OAuthError(
			"Codex CLI switched ChatGPT accounts during refresh; run the existing Codex CLI login again in OMP to confirm the new binding",
			{ kind: "token-refresh" },
		);
	}
	if (current.expires <= Date.now() + CODEX_CLI_REFRESH_SKEW_MS) {
		throw new AIError.OAuthError("Codex CLI did not provide a fresh access token", { kind: "token-refresh" });
	}
	return current;
}

/** Reuse the current Codex CLI ChatGPT login without browser OAuth. */
export async function loginOpenAICodexCli(
	options: OAuthController & CodexCliRefreshOptions,
): Promise<OAuthCredentials> {
	options.signal?.throwIfAborted();
	options.onProgress?.("Reusing the existing Codex CLI ChatGPT login…");
	const readManagedCredentials = options.readManagedCredentials ?? readOpenAICodexCliCredentials;
	const credentials = await readManagedCredentials(false, options.signal);
	if (credentials.expires > Date.now() + CODEX_CLI_REFRESH_SKEW_MS) return credentials;
	const refreshed = await readManagedCredentials(true, options.signal);
	if (refreshed.expires <= Date.now() + CODEX_CLI_REFRESH_SKEW_MS) {
		throw new AIError.OAuthError("Codex CLI did not provide a fresh access token", { kind: "token-refresh" });
	}
	return refreshed;
}

interface PKCE {
	verifier: string;
	challenge: string;
}
function describeTokenEndpointValue(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (!isRecord(value)) return undefined;

	const code = describeTokenEndpointValue(value.code ?? value.error);
	const message = describeTokenEndpointValue(value.message ?? value.error_description ?? value.description);
	if (code && message && code !== message) return `${code}: ${message}`;
	return code ?? message ?? JSON.stringify(value);
}

/** Formats OpenAI Codex OAuth token endpoint errors for login and refresh failures. */
export function formatOpenAICodexTokenEndpointError(status: number, bodyText: string): string {
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return `${status}`;

	try {
		const body: unknown = JSON.parse(trimmed);
		if (!isRecord(body)) return `${status} ${trimmed}`;

		const error = describeTokenEndpointValue(body.error);
		const description = describeTokenEndpointValue(body.error_description);
		if (error && description && error !== description) return `${status} ${error}: ${description}`;
		return `${status} ${error ?? description ?? describeTokenEndpointValue(body.message) ?? trimmed}`;
	} catch {
		return `${status} ${trimmed}`;
	}
}
/** Builds the Codex browser OAuth URL used by browser login; exported for auth regression tests. */
export function createOpenAICodexAuthorizationUrl(args: {
	state: string;
	redirectUri: string;
	challenge: string;
	originator?: string;
}): string {
	const originator = args.originator?.trim() || OPENAI_HEADER_VALUES.ORIGINATOR_CODEX;
	const searchParams = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: args.redirectUri,
		scope: SCOPE,
		code_challenge: args.challenge,
		code_challenge_method: "S256",
		state: args.state,
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		originator,
	});

	return `${AUTHORIZE_URL}?${searchParams.toString()}`;
}

class OpenAICodexOAuthFlow extends OAuthCallbackFlow {
	#pkce: PKCE;
	#originator: string;
	#fetch: FetchImpl;

	constructor(ctrl: OAuthController, pkce: PKCE, originator: string, fetchImpl: FetchImpl) {
		super(ctrl, {
			preferredPort: CALLBACK_PORT,
			callbackPath: CALLBACK_PATH,
			// Enforce the fixed port: OpenAI only allows http://localhost:1455/auth/callback.
			// Without this, a busy port 1455 falls back to a random port, and the token
			// exchange would fail with 403 because the redirect_uri no longer matches the
			// registered allowlist entry.
			redirectUri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,
		} satisfies OAuthCallbackFlowOptions);
		this.#pkce = pkce;
		this.#originator = originator;
		this.#fetch = fetchImpl;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const url = createOpenAICodexAuthorizationUrl({
			state,
			redirectUri,
			challenge: this.#pkce.challenge,
			originator: this.#originator,
		});
		return { url, instructions: "A browser window should open. Complete login to finish." };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		return exchangeCodeForToken(code, this.#pkce.verifier, redirectUri, this.#fetch);
	}
}

async function exchangeCodeForToken(
	code: string,
	verifier: string,
	redirectUri: string,
	fetchImpl: FetchImpl = fetch,
): Promise<OAuthCredentials> {
	const tokenResponse = await fetchImpl(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!tokenResponse.ok) {
		const bodyText = await tokenResponse.text();
		throw new AIError.OAuthError(
			`Token exchange failed: ${formatOpenAICodexTokenEndpointError(tokenResponse.status, bodyText)}`,
			{ kind: "token-exchange", status: tokenResponse.status },
		);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token?: string;
		refresh_token?: string;
		id_token?: string;
		expires_in?: number;
	};

	if (!tokenData.access_token || !tokenData.refresh_token || typeof tokenData.expires_in !== "number") {
		throw new AIError.OAuthError("Token response missing required fields", { kind: "validation" });
	}

	const { accountId, email, planType } = getTokenProfile(tokenData.access_token, tokenData.id_token);
	if (!accountId) {
		throw new AIError.OAuthError("Failed to extract accountId from token", { kind: "validation" });
	}

	return {
		access: tokenData.access_token,
		refresh: tokenData.refresh_token,
		expires: Date.now() + tokenData.expires_in * 1000,
		accountId,
		email,
		orgId: accountId,
		orgName: planType,
	};
}

/**
 * Login with OpenAI Codex OAuth
 */
export type OpenAICodexLoginOptions = OAuthController & {
	/** Optional originator value for OpenAI Codex OAuth. Default matches OMP Codex request headers. */
	originator?: string;
};

export async function loginOpenAICodex(options: OpenAICodexLoginOptions): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const originator = options.originator?.trim() || OPENAI_HEADER_VALUES.ORIGINATOR_CODEX;
	const flow = new OpenAICodexOAuthFlow(options, pkce, originator, options.fetch ?? fetch);

	return flow.login();
}

/**
 * Login with OpenAI Codex using the device-code (headless) flow.
 *
 * Avoids a local callback server entirely — useful when port 1455 is unavailable
 * or when the browser callback flow fails with 403 (e.g. network/proxy issues).
 */
export async function loginOpenAICodexDevice(ctrl: OAuthController): Promise<OAuthCredentials> {
	ctrl.onProgress?.("Initiating device authorization…");

	const initResponse = await fetch(DEVICE_USERCODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!initResponse.ok) {
		throw new AIError.OAuthError(`Device authorization initiation failed: ${initResponse.status}`, {
			kind: "device-auth",
			status: initResponse.status,
		});
	}

	const initData = (await initResponse.json()) as {
		device_auth_id?: string;
		user_code?: string;
		interval?: string | number;
	};

	if (!initData.device_auth_id || !initData.user_code) {
		throw new AIError.OAuthError("Device authorization response missing required fields", { kind: "validation" });
	}

	const userCode = initData.user_code;
	const pollIntervalMs =
		(typeof initData.interval === "number"
			? initData.interval
			: parseInt(String(initData.interval ?? "5"), 10) || 5) *
			1000 +
		DEVICE_POLL_SAFETY_MARGIN_MS;

	ctrl.onAuth?.({
		url: DEVICE_AUTH_URL,
		instructions: `Enter code: ${userCode}`,
	});

	ctrl.onProgress?.(`Waiting for browser authorization (code: ${userCode})…`);

	for (let poll = 0; poll < DEVICE_MAX_POLLS; poll++) {
		await Bun.sleep(poll === 0 ? Math.min(pollIntervalMs, DEVICE_POLL_INTERVAL_MS) : pollIntervalMs);

		if (ctrl.signal?.aborted) {
			throw new AIError.LoginCancelledError("Device authorization cancelled");
		}

		const pollResponse = await fetch(DEVICE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				device_auth_id: initData.device_auth_id,
				user_code: userCode,
			}),
			signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
		});

		// 403/404 = authorization pending, keep polling
		if (pollResponse.status === 403 || pollResponse.status === 404) {
			continue;
		}

		if (!pollResponse.ok) {
			throw new AIError.OAuthError(`Device token polling failed: ${pollResponse.status}`, {
				kind: "polling",
				status: pollResponse.status,
			});
		}

		const pollData = (await pollResponse.json()) as {
			authorization_code?: string;
			code_verifier?: string;
		};

		if (!pollData.authorization_code || !pollData.code_verifier) {
			throw new AIError.OAuthError("Device token response missing authorization_code or code_verifier", {
				kind: "validation",
			});
		}

		ctrl.onProgress?.("Exchanging authorization code for tokens…");
		return exchangeCodeForToken(pollData.authorization_code, pollData.code_verifier, DEVICE_REDIRECT_URI);
	}

	throw new AIError.OAuthError("Device authorization timed out — user did not complete login in time", {
		kind: "timeout",
	});
}

/**
 * Refresh OpenAI Codex OAuth token
 */
export async function refreshOpenAICodexToken(refreshToken: string): Promise<OAuthCredentials> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) {
		const bodyText = await response.text();
		throw new AIError.OAuthError(
			`OpenAI Codex token refresh failed: ${formatOpenAICodexTokenEndpointError(response.status, bodyText)}`,
			{ kind: "token-refresh", status: response.status },
		);
	}

	const tokenData = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!tokenData.access_token || !tokenData.refresh_token || typeof tokenData.expires_in !== "number") {
		throw new AIError.OAuthError("Token response missing required fields", { kind: "validation" });
	}

	const { accountId, email } = getTokenProfile(tokenData.access_token);

	// Deliberately no org fields on the result: the workspace a credential is
	// scoped to is fixed at login. Callers merge refresh results over the
	// stored credential, so omitting org here preserves it verbatim.
	return {
		access: tokenData.access_token,
		refresh: tokenData.refresh_token || refreshToken,
		expires: Date.now() + tokenData.expires_in * 1000,
		accountId: accountId ?? undefined,
		email,
	};
}
