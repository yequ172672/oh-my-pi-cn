import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { expandEnvVarsDeep } from "../discovery/helpers";
import type { AuthStorage } from "../session/auth-storage";
import {
	isManagedMCPOAuthCredentialId,
	type MCPStoredOAuthCredential,
	mcpOAuthCredentialId,
	mcpOAuthCredentialProfile,
	refreshMCPOAuthToken,
} from "./oauth-flow";
import type { MCPAuthConfig, MCPServerConfig } from "./types";

export interface MCPOAuthCredentialLookup {
	credentialId: string;
	credential: MCPStoredOAuthCredential;
}

export type MCPOAuthRefreshMaterial = MCPStoredOAuthCredential | MCPAuthConfig | undefined;

export function mcpOAuthCredentialIdsForServerUrl(serverUrl: string | undefined): string[] {
	if (!serverUrl) return [];
	const ids: string[] = [];
	for (const url of [expandEnvVarsDeep(serverUrl), serverUrl]) {
		const id = mcpOAuthCredentialId(url);
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

export function hasMcpAuthorizationHeader(config: MCPServerConfig): boolean {
	if (config.type !== "http" && config.type !== "sse") return false;
	return Object.keys(config.headers ?? {}).some(header => header.toLowerCase() === "authorization");
}

export function lookupMcpOAuthCredentialForServer(
	authStorage: AuthStorage | null | undefined,
	auth: MCPAuthConfig | undefined,
	serverUrl: string | undefined,
	options: { allowUrlKeyedFallback?: boolean } = {},
): MCPOAuthCredentialLookup | undefined {
	if (!authStorage) return undefined;
	if (auth && auth.type !== "oauth") return undefined;
	const urlKeyedCredentialIds = mcpOAuthCredentialIdsForServerUrl(serverUrl);
	if (
		auth?.credentialId &&
		(!auth.credentialId.startsWith("mcp_oauth:profile:") || urlKeyedCredentialIds.includes(auth.credentialId))
	) {
		const credential = authStorage.get(auth.credentialId);
		if (credential?.type === "oauth") {
			return { credentialId: auth.credentialId, credential };
		}
	}
	if (options.allowUrlKeyedFallback === false) return undefined;
	for (const credentialId of urlKeyedCredentialIds) {
		const credential = authStorage.get(credentialId);
		if (credential?.type === "oauth") {
			return { credentialId, credential };
		}
	}
	return undefined;
}

export function lookupMcpOAuthCredential(
	authStorage: AuthStorage | null | undefined,
	config: MCPServerConfig,
): MCPOAuthCredentialLookup | undefined {
	const auth = config.auth;
	if (config.type !== "http" && config.type !== "sse") {
		return lookupMcpOAuthCredentialForServer(authStorage, auth, undefined);
	}
	if (hasMcpAuthorizationHeader(config)) {
		return lookupMcpOAuthCredentialForServer(authStorage, auth, config.url, { allowUrlKeyedFallback: false });
	}
	return lookupMcpOAuthCredentialForServer(authStorage, auth, config.url);
}

export function selectMcpOAuthRefreshMaterial(
	credential: MCPStoredOAuthCredential,
	auth: MCPAuthConfig | undefined,
): MCPOAuthRefreshMaterial {
	return credential.tokenUrl ? credential : auth;
}

/**
 * Refresh a stored MCP OAuth credential via the standard `refresh_token` grant.
 *
 * Refresh material is taken from the credential itself (self-contained modern
 * credentials embed `tokenUrl`/`clientId`/`clientSecret`/`resource`) or, for
 * legacy credentials that carry none, the server's `auth` block. Shared by the
 * local MCP manager and the `omp auth-broker serve` refresh path so a broker
 * with no access to the MCP config can still refresh `mcp_oauth:*` credentials
 * from the vault.
 *
 * `serverUrl` supplies the RFC 8707 fallback resource indicator when neither
 * the credential nor the auth block advertised one; the manager passes the
 * configured server URL, the broker recovers it from the credential id via
 * {@link mcpOAuthServerUrlFromCredentialId}.
 *
 * @throws when no usable refresh token or token endpoint is available.
 */
export function refreshManagedMcpOAuthCredential(
	credential: MCPStoredOAuthCredential,
	opts: { serverUrl?: string; auth?: MCPAuthConfig; signal?: AbortSignal } = {},
): Promise<OAuthCredentials> {
	const material = selectMcpOAuthRefreshMaterial(credential, opts.auth);
	const tokenUrl = material?.tokenUrl;
	if (!credential.refresh || !tokenUrl) {
		throw new Error("MCP OAuth credential is missing refresh material");
	}
	const authorizationUrl = material && "authorizationUrl" in material ? material.authorizationUrl : undefined;
	const resourceIsFallback = !material?.resource && Boolean(opts.serverUrl);
	const resource = material?.resource ?? (resourceIsFallback ? opts.serverUrl : undefined);
	return refreshMCPOAuthToken(tokenUrl, credential.refresh, material?.clientId, material?.clientSecret, resource, {
		authorizationUrl,
		stripSameOriginResource: resourceIsFallback,
		signal: opts.signal,
	});
}

export async function removeManagedMcpOAuthCredential(
	authStorage: AuthStorage,
	credentialId: string | undefined,
): Promise<boolean> {
	if (!isManagedMCPOAuthCredentialId(credentialId)) return false;
	const scopedProfile = mcpOAuthCredentialProfile(credentialId);
	if (scopedProfile !== undefined && scopedProfile !== (getActiveProfile() ?? "default")) return false;
	if (authStorage.get(credentialId)?.type !== "oauth") return false;
	await authStorage.remove(credentialId);
	return true;
}

export async function removeManagedMcpOAuthCredentials(
	authStorage: AuthStorage,
	credentialIds: readonly (string | undefined)[],
): Promise<boolean> {
	let removed = false;
	for (const credentialId of credentialIds) {
		removed = (await removeManagedMcpOAuthCredential(authStorage, credentialId)) || removed;
	}
	return removed;
}
