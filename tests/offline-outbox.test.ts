import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { parseHTML } from "linkedom";
import { SessionModel, outboxKey, readOutbox, writeOutbox } from "../components/session-core.ts";

/* The offline outbox (mobile wave): a send made with no connection waits
 * for `online` instead of failing, keeps a durable copy, and a remount
 * replays it. Node's `navigator` has no onLine; the tests define it. */

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
const fakeStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => { store.set(k, v); },
	removeItem: (k: string) => { store.delete(k); },
};
let online = true;

beforeEach(() => {
	store.clear();
	online = true;
	Object.assign(globalThis, { window: dom.window, localStorage: fakeStorage });
	Object.defineProperty(globalThis.navigator, "onLine", { get: () => online, configurable: true });
});
afterEach(() => {
	Reflect.deleteProperty(globalThis.navigator, "onLine");
});

const tick = () => new Promise((r) => setTimeout(r, 5));
const goOnline = async () => { online = true; dom.window.dispatchEvent(new dom.window.Event("online")); await tick(); };

/** A fetch that acks the POST and answers the reattach reads minimally. */
function fakeFetch(calls: { url: string; body?: string }[]) {
	return async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
		if (url === "/api/chat") return new Response("ok", { status: 200 });
		if (url.endsWith("/stream")) return new Response("data: {\"type\":\"turn-settled\"}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
		return Response.json({ messages: [], turnInFlight: false });
	};
}

test("a send while offline waits, is flagged queued, persists, then posts on `online`", async () => {
	online = false;
	const calls: { url: string; body?: string }[] = [];
	const model = new SessionModel({ chatId: "c1", initialMessages: [], fetch: fakeFetch(calls) });
	const sending = model.send({ type: "text", text: "what is a kernel?" });
	await tick();
	assert.equal(calls.length, 0, "no POST without a network");
	assert.equal(model.getState().offlineQueued, true);
	assert.equal(model.getState().status, "submitted", "the optimistic card stays up");
	assert.deepEqual(readOutbox("c1"), { type: "text", text: "what is a kernel?" }, "durable copy written");
	await goOnline();
	assert.ok(await sending);
	assert.equal(calls[0]?.url, "/api/chat");
	assert.deepEqual(JSON.parse(calls[0]!.body!).input, { type: "text", text: "what is a kernel?" });
	assert.equal(model.getState().offlineQueued, false);
	assert.equal(readOutbox("c1"), null, "cleared on acceptance");
});

test("an online send never touches the outbox", async () => {
	const calls: { url: string; body?: string }[] = [];
	const model = new SessionModel({ chatId: "c2", initialMessages: [], fetch: fakeFetch(calls) });
	await model.send({ type: "text", text: "hi" });
	assert.equal(calls[0]?.url, "/api/chat");
	assert.equal(model.getState().offlineQueued, false);
	assert.equal(store.has(outboxKey("c2")), false);
});

test("a network failure while 'online' retries on the injected schedule instead of failing", async () => {
	const calls: string[] = [];
	let failures = 2;
	const model = new SessionModel({
		chatId: "c3", initialMessages: [], unreachableRetryMs: [20, 20, 20],
		fetch: async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);
			if (url === "/api/chat" && failures-- > 0) throw new TypeError("Failed to fetch");
			if (url === "/api/chat") return new Response("ok", { status: 200 });
			if (url.endsWith("/stream")) return new Response("data: {\"type\":\"turn-settled\"}\n\n", { status: 200 });
			return Response.json({ messages: [], turnInFlight: false });
		},
	});
	const sending = model.send({ type: "text", text: "retry me" });
	await tick();
	assert.equal(model.getState().offlineQueued, true, "flagged while unreachable");
	assert.ok(await sending);
	assert.equal(calls.filter((u) => u === "/api/chat").length, 3, "two failures, one success");
	assert.equal(model.getState().offlineQueued, false);
	assert.equal(model.getState().error, null);
});

test("with the default schedule a network failure while 'online' fails at once (the banner's contract)", async () => {
	const model = new SessionModel({
		chatId: "c3b", initialMessages: [],
		fetch: async () => { throw new TypeError("Failed to fetch"); },
	});
	assert.equal(await model.send({ type: "text", text: "no network" }), false);
	assert.equal(model.getState().status, "error");
	assert.equal(model.getState().offlineQueued, false);
	assert.equal(readOutbox("c3b"), null);
});

test("a remount replays a durable text input, and drops a stale answer", async () => {
	writeOutbox("c4", { type: "text", text: "queued before the reload" });
	const calls: { url: string; body?: string }[] = [];
	const model = new SessionModel({ chatId: "c4", initialMessages: [], fetch: fakeFetch(calls) });
	model.restoreOutbox();
	await tick();
	assert.equal(calls[0]?.url, "/api/chat");
	assert.deepEqual(JSON.parse(calls[0]!.body!).input, { type: "text", text: "queued before the reload" });

	writeOutbox("c5", { type: "answer", toolCallId: "call_gone", answer: { kind: "quiz", correct: true } as never });
	const stale: { url: string }[] = [];
	const other = new SessionModel({ chatId: "c5", initialMessages: [], fetch: fakeFetch(stale) });
	other.restoreOutbox();
	await tick();
	assert.equal(stale.length, 0, "an answer to a question that is no longer pending is not replayed");
	assert.equal(readOutbox("c5"), null);

	writeOutbox("c6", { type: "retry" });
	const retry = new SessionModel({ chatId: "c6", initialMessages: [], fetch: fakeFetch([]) });
	retry.restoreOutbox();
	assert.equal(readOutbox("c6"), null, "continue/retry describe a past moment and are dropped");
});
