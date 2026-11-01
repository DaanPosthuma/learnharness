/**
 * The gateway's per-user process table (gateway/upstreams.mjs): the rules
 * learned from the 2026-10-31 outage, pinned with fake processes and a
 * fake clock — no spawning, no sockets, no real time.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createUpstreamManager } from "../gateway/upstreams.mjs";

class FakeProc extends EventEmitter {
	exitCode: number | null = null;
	signalCode: string | null = null;
	signals: string[] = [];
	kill(signal: string) { this.signals.push(signal); return true; }
	/** The process really goes away (what Next does promptly WITHOUT an open stream). */
	exit(signal = "SIGTERM") { this.signalCode = signal; this.emit("exit", null, signal); }
}

function harness({ idleMs = 60_000, graceMs = 15_000 } = {}) {
	let clock = 1_000_000;
	const scheduled: { fn: () => void; ms: number }[] = [];
	const procs = new Map<string, FakeProc[]>();
	const logs: string[] = [];
	const readies = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
	const manager = createUpstreamManager({
		launch: (name: string, port: number) => {
			const proc = new FakeProc();
			procs.set(name, [...(procs.get(name) ?? []), proc]);
			const ready = new Promise<void>((resolve, reject) => readies.set(`${name}:${port}`, { resolve, reject }));
			return { proc, ready };
		},
		basePort: 4100,
		idleMs,
		graceMs,
		log: (line: string) => logs.push(line),
		now: () => clock,
		timers: { setTimeout: (fn: () => void, ms: number) => { scheduled.push({ fn, ms }); return { unref() {} }; } },
	});
	return {
		manager, procs, logs, scheduled, readies,
		advance(ms: number) { clock += ms; },
		/** Run every timer whose delay has elapsed (all of them — grace timers only). */
		fireTimers() { for (const t of scheduled.splice(0)) t.fn(); },
		last(name: string) { const list = procs.get(name)!; return list[list.length - 1]!; },
	};
}

test("one process per user: ensure() reuses the live entry and touches lastSeen", () => {
	const h = harness();
	const a = h.manager.ensure("dean");
	h.advance(5_000);
	const again = h.manager.ensure("dean");
	assert.equal(again, a);
	assert.equal(again.lastSeen, 1_005_000);
	assert.equal(h.procs.get("dean")!.length, 1);
	const b = h.manager.ensure("emma");
	assert.deepEqual([a.port, b.port], [4100, 4101]);
	assert.equal(h.manager.size, 2);
});

test("stop() forgets the entry AT ONCE; the next request gets a fresh process on a new port while the old one lingers", () => {
	const h = harness();
	const first = h.manager.ensure("dean");
	h.manager.stop("dean", first, "idle");
	assert.equal(h.manager.get("dean"), undefined, "table entry gone immediately");
	assert.deepEqual(h.last("dean").signals, ["SIGTERM"]);
	// The lingering process still holds :4100 — a new one must not collide.
	const second = h.manager.ensure("dean");
	assert.notEqual(second, first);
	assert.equal(second.port, 4101);
	assert.deepEqual(h.manager.reservedPorts.sort(), [4100, 4101]);
	// Once the old process really exits, its port is free again — and its
	// exit must not evict the NEW entry.
	(h.procs.get("dean")![0] as FakeProc).exit("SIGKILL");
	assert.equal(h.manager.get("dean"), second, "the fresh entry survives the old exit");
	assert.deepEqual(h.manager.reservedPorts, [4101]);
	const third = h.manager.ensure("stein");
	assert.equal(third.port, 4100, "released port reused");
});

test("a process that ignores SIGTERM is SIGKILLed after the grace period; one that exited in time is not", () => {
	const h = harness({ graceMs: 15_000 });
	const stubborn = h.manager.ensure("dean");
	const prompt = h.manager.ensure("emma");
	h.manager.stop("dean", stubborn, "idle");
	h.manager.stop("emma", prompt, "idle");
	assert.deepEqual(h.scheduled.map((t) => t.ms), [15_000, 15_000]);
	h.last("emma").exit("SIGTERM"); // emma's app shut down cleanly
	h.fireTimers();
	assert.deepEqual(h.last("dean").signals, ["SIGTERM", "SIGKILL"]);
	assert.deepEqual(h.last("emma").signals, ["SIGTERM"]);
	assert.ok(h.logs.some((l) => l.includes("did not exit after SIGTERM")));
});

test("stop() is idempotent: a second stop for the same entry sends nothing more", () => {
	const h = harness();
	const e = h.manager.ensure("dean");
	h.manager.stop("dean", e, "idle");
	h.manager.stop("dean", e, "ECONNREFUSED");
	assert.deepEqual(h.last("dean").signals, ["SIGTERM"]);
	assert.equal(h.scheduled.length, 1);
});

test("sweep() stops only the entries idle for longer than idleMs", () => {
	const h = harness({ idleMs: 60_000 });
	const idle = h.manager.ensure("dean");
	h.advance(61_000);
	const active = h.manager.ensure("emma");
	h.manager.sweep();
	assert.equal(h.manager.get("dean"), undefined);
	assert.equal(h.manager.get("emma"), active);
	assert.deepEqual(h.last("dean").signals, ["SIGTERM"]);
	assert.deepEqual(h.last("emma").signals, []);
	assert.equal(idle.stopping, true);
});

test("a process that never starts listening is stopped and forgotten when ready rejects", async () => {
	const h = harness();
	const e = h.manager.ensure("dean");
	h.readies.get("dean:4100")!.reject(new Error("upstream on :4100 did not start"));
	await Promise.resolve(); await Promise.resolve();
	assert.equal(h.manager.get("dean"), undefined);
	assert.deepEqual(h.last("dean").signals, ["SIGTERM"]);
	assert.ok(h.logs.some((l) => l.includes("did not start")));
	assert.equal(e.stopping, true);
});

test("stopAll() stops every entry once", () => {
	const h = harness();
	h.manager.ensure("dean");
	h.manager.ensure("emma");
	h.manager.stopAll("shutdown");
	assert.equal(h.manager.size, 0);
	assert.deepEqual(h.last("dean").signals, ["SIGTERM"]);
	assert.deepEqual(h.last("emma").signals, ["SIGTERM"]);
});
