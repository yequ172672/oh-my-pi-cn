import { afterEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TextDeltaUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

// #8345: a server-side per-conversation rejection (bare resource_exhausted,
// zero tokens) poisons the wire conversationId; the next attempt must rotate
// to a fresh id and succeed, instead of failing forever until /fork.

let server: http2.Http2Server | undefined;
const sessions = new Set<http2.Http2Session>();

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function textDeltaFrame(text: string): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

function turnEndedFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	});
	return frameConnectMessage(toBinary(AgentServerMessageSchema, message));
}

/** Decode the wire conversationId from the first client frame of a request. */
function decodeConversationId(chunk: Buffer): string | undefined {
	const msg = fromBinary(AgentClientMessageSchema, chunk.subarray(5));
	if (msg.message.case !== "runRequest") return undefined;
	return msg.message.value.conversationId;
}

/** First request ends with a bare resource_exhausted; later ones turn normally. */
async function startServer(seenConversationIds: string[]): Promise<string> {
	server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	let requestCount = 0;
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.on("data", (chunk: Buffer) => {
			const conversationId = decodeConversationId(chunk);
			if (conversationId !== undefined) seenConversationIds.push(conversationId);
			requestCount++;
			if (requestCount === 1) {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
				stream.once("wantTrailers", () => {
					stream.sendTrailers({ "grpc-status": "8", "grpc-message": "resource_exhausted" });
				});
				stream.end();
			} else {
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
				stream.write(textDeltaFrame("recovered"));
				stream.write(turnEndedFrame());
				stream.end();
			}
		});
	});

	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected the fixture server to bind a tcp port");
	return `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
	for (const session of sessions) session.destroy();
	sessions.clear();
	if (!server) return;
	const closing = server;
	server = undefined;
	const closed = Promise.withResolvers<void>();
	closing.close(error => (error ? closed.reject(error) : closed.resolve()));
	await closed.promise;
}

function makeModel(baseUrl: string): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-rotation-fixture",
		name: "Cursor rotation fixture",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };

/** Drain a stream and return its terminal event (done / error). */
async function runToEnd(baseUrl: string, sessionId: string): Promise<{ type: "done" | "error"; message?: string }> {
	const stream = streamCursor(makeModel(baseUrl), context, { apiKey: "test-token", sessionId });
	let terminal: { type: "done" | "error"; message?: string } = { type: "done" };
	for await (const event of stream) {
		if (event.type === "error") {
			terminal = { type: "error", message: event.error.errorMessage };
		}
	}
	await stream.result().catch(() => {});
	return terminal;
}

afterEach(async () => {
	await stopServer();
});

describe("Cursor conversationId rotation (issue #8345)", () => {
	it("rotates the poisoned conversationId and recovers on the next attempt", async () => {
		const seenConversationIds: string[] = [];
		const baseUrl = await startServer(seenConversationIds);

		const first = await runToEnd(baseUrl, "sess-poisoned");
		expect(first.type).toBe("error");
		expect(first.message).toMatch(/resource.?exhausted/i);

		const second = await runToEnd(baseUrl, "sess-poisoned");
		expect(second.type).toBe("done");

		expect(seenConversationIds).toHaveLength(2);
		expect(seenConversationIds[0]).toBe("sess-poisoned");
		expect(seenConversationIds[1]).not.toBe(seenConversationIds[0]);
	});

	it("keeps the rotated id when the new conversation is also rejected", async () => {
		const seenConversationIds: string[] = [];
		// Fail every request: rotation must happen exactly once.
		server = http2.createServer();
		server.on("session", session => {
			sessions.add(session);
			session.on("close", () => sessions.delete(session));
		});
		server.on("stream", (stream: http2.ServerHttp2Stream) => {
			stream.on("data", (chunk: Buffer) => {
				const conversationId = decodeConversationId(chunk);
				if (conversationId !== undefined) seenConversationIds.push(conversationId);
				stream.respond({ ":status": 200, "content-type": "application/connect+proto" }, { waitForTrailers: true });
				stream.once("wantTrailers", () => {
					stream.sendTrailers({ "grpc-status": "8", "grpc-message": "resource_exhausted" });
				});
				stream.end();
			});
		});
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected the fixture server to bind a tcp port");
		const baseUrl = `http://127.0.0.1:${address.port}`;

		const r1 = await runToEnd(baseUrl, "sess-sticky");
		const r2 = await runToEnd(baseUrl, "sess-sticky");
		const r3 = await runToEnd(baseUrl, "sess-sticky");
		console.log(
			"[test] results:",
			JSON.stringify([r1.type, r1.message, r2.type, r2.message, r3.type, r3.message]),
			"seen:",
			JSON.stringify(seenConversationIds),
		);

		expect(seenConversationIds).toHaveLength(3);
		expect(seenConversationIds[0]).toBe("sess-sticky");
		expect(seenConversationIds[1]).toBe(seenConversationIds[2]);
		expect(seenConversationIds[1]).not.toBe("sess-sticky");
	});
});
