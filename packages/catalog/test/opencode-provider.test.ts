import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const LIVE_FREE_MODEL_IDS = [
	"deepseek-v4-flash-free",
	"hy3-free",
	"mimo-v2.5-free",
	"nemotron-3-ultra-free",
	"north-mini-code-free",
] as const;

const LIVE_PAID_MODEL_IDS = ["claude-opus-4-8", "gpt-5.5"] as const;

function modelListResponse(ids: readonly string[]): Response {
	return Response.json({
		object: "list",
		data: ids.map(id => ({ id, object: "model", owned_by: "opencode" })),
	});
}

describe("OpenCode provider discovery", () => {
	test("treats the OpenCode model endpoints as authoritative catalogs", () => {
		for (const providerId of ["opencode-go", "opencode-zen"]) {
			const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === providerId);
			expect(descriptor?.dynamicModelsAuthoritative).toBe(true);
		}
		expect(opencodeGoModelManagerOptions().dynamicModelsAuthoritative).toBe(true);
		expect(opencodeZenModelManagerOptions().dynamicModelsAuthoritative).toBe(true);
	});

	test("routes opencode-go deepseek-v4-flash to the responses API", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(item => item.providerId === "opencode-go");
		// stencil.so lists deepseek-v4-flash without provider.npm, so it would
		// fall through to openai-completions — but the Go gateway does not serve
		// this model at /zen/go/v1/chat/completions while /zen/go/v1/responses
		// works (user-verified against the live gateway, 2026-08-08).
		expect(descriptor?.resolveApi?.("deepseek-v4-flash", { tool_call: true })).toEqual({
			api: "openai-responses",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
		// Flash only: deepseek-v4-pro serves fine on chat completions.
		expect(descriptor?.resolveApi?.("deepseek-v4-pro", { tool_call: true })).toEqual({
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
	});

	test("routes opencode-go muse-spark-1.2 to the responses API (#8957)", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(item => item.providerId === "opencode-go");
		// The Go /zen/go/v1/models discovery drops the provider.npm hint for the
		// muse-spark ids, so without an override they fall through to
		// openai-completions even though the gateway only serves them at
		// /zen/go/v1/responses. Sending completions requests closes the stream
		// with no finish_reason on every tool-call turn.
		for (const id of ["muse-spark-1.2", "muse-spark-1.2-contributor"]) {
			expect(descriptor?.resolveApi?.(id, { tool_call: true })).toEqual({
				api: "openai-responses",
				baseUrl: "https://opencode.ai/zen/go/v1",
			});
		}
	});

	test("pins gateway-only muse-spark ids to responses in live discovery (#8957)", async () => {
		// models.dev omits muse-spark-1.2[-contributor] under opencode-go, so
		// there is no bundled reference row. Without the discovery-side pin the
		// mapper defaults them to openai-completions and every tool-call turn
		// fails with "stream closed before a finish_reason was received".
		const options = opencodeGoModelManagerOptions({
			apiKey: "test-key",
			fetch: async () => modelListResponse(["muse-spark-1.2", "muse-spark-1.2-contributor", "kimi-k3"]),
		});
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const byId = new Map((models ?? []).map(model => [model.id, model]));
		for (const id of ["muse-spark-1.2", "muse-spark-1.2-contributor"]) {
			expect(byId.get(id)).toMatchObject({
				api: "openai-responses",
				baseUrl: "https://opencode.ai/zen/go/v1",
			});
		}
		// Contrast: an unpinned id with a bundled reference keeps its route.
		expect(byId.get("kimi-k3")).toMatchObject({ api: "openai-completions" });
		// Upgrade path: pinned ids invalidate caches written before the pin,
		// otherwise 17.3.7-era rows keep the completions route until TTL.
		expect(options.dropCachedModelIdsOnStaticMismatch).toContain("muse-spark-1.2-contributor");
	});

	test("routes gateway-first ids via sibling catalog and variant-base hints", async () => {
		// The Go gateway ships models before models.dev lists them under
		// opencode-go (muse-spark-1.2[-contributor] did exactly this, #8957).
		// With no same-provider metadata, the mapper borrows the
		// openai-responses route from the sibling Zen catalog or the
		// billing-variant base id — responses only, never anthropic-messages
		// (cross-gateway transports genuinely diverge there).
		const options = opencodeGoModelManagerOptions({
			apiKey: "test-key",
			fetch: async () =>
				modelListResponse([
					"gpt-5.5", // zen bundles it as openai-responses; absent from the go bundle
					"deepseek-v4-flash-free", // base id is pinned to responses on go
					"minimax-m2.5-free", // anthropic hints only -> must keep the completions default
					"brand-new-model", // no hint anywhere -> completions default
				]),
		});
		const models = await options.fetchDynamicModels?.();
		const apiById = new Map((models ?? []).map(model => [model.id, model.api]));
		expect(apiById.get("gpt-5.5")).toBe("openai-responses");
		expect(apiById.get("deepseek-v4-flash-free")).toBe("openai-responses");
		expect(apiById.get("minimax-m2.5-free")).toBe("openai-completions");
		expect(apiById.get("brand-new-model")).toBe("openai-completions");
	});

	test("recovers muse-spark thinking levels from live OpenCode Go discovery", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-opencode-go-muse-"));
		try {
			const options = opencodeGoModelManagerOptions({
				apiKey: "go-account-key",
				fetch: async () => modelListResponse(["muse-spark-1.2", "muse-spark-1.2-contributor"]),
			});
			const result = await resolveProviderModels(
				{ ...options, cacheDbPath: path.join(tempDir, "models.db") },
				"online-if-uncached",
			);
			const expected = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];
			for (const id of ["muse-spark-1.2", "muse-spark-1.2-contributor"]) {
				const model = result.models.find(item => item.id === id);
				expect(model?.api).toBe("openai-responses");
				expect(model?.reasoning).toBe(true);
				expect(model?.thinking?.efforts).toEqual(expected);
				expect(model?.thinking?.requiresEffort).toBeUndefined();
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("replaces stale bundled Zen models with each credential's live endpoint list", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-opencode-zen-"));
		try {
			let freeFetches = 0;
			const freeOptions = opencodeZenModelManagerOptions({
				apiKey: "free-account-key",
				fetch: async () => {
					freeFetches++;
					return modelListResponse(LIVE_FREE_MODEL_IDS);
				},
			});
			const freeResult = await resolveProviderModels(
				{ ...freeOptions, cacheDbPath: path.join(tempDir, "models.db") },
				"online-if-uncached",
			);

			let paidFetches = 0;
			const paidOptions = opencodeZenModelManagerOptions({
				apiKey: "paid-account-key",
				fetch: async () => {
					paidFetches++;
					return modelListResponse(LIVE_PAID_MODEL_IDS);
				},
			});
			const paidResult = await resolveProviderModels(
				{ ...paidOptions, cacheDbPath: path.join(tempDir, "models.db") },
				"online-if-uncached",
			);

			expect(freeOptions.cacheProviderId).not.toBe(paidOptions.cacheProviderId);
			expect(freeResult.stale).toBe(false);
			expect(freeResult.models.map(model => model.id).sort()).toEqual([...LIVE_FREE_MODEL_IDS].sort());
			expect(paidResult.stale).toBe(false);
			expect(paidResult.models.map(model => model.id).sort()).toEqual([...LIVE_PAID_MODEL_IDS].sort());
			expect([freeFetches, paidFetches]).toEqual([1, 1]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
