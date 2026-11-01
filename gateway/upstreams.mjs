/**
 * The per-user process table of the accounts gateway (gateway/server.mjs):
 * one app process per signed-in user, started on first request, stopped
 * after idling, forgotten the moment it is told to stop.
 *
 * Pure lifecycle. Spawning is injected (`launch(name, port)` → { proc,
 * ready }), as are the clock and the timer, so tests drive it with fake
 * processes and no real time (tests/gateway-upstreams.test.ts). The rules
 * it encodes came from a live outage (2026-10-31): Next.js answers SIGTERM
 * by closing its listener and then waiting for open connections to drain
 * — a browser tab's EventSource never drains — so a "stopped" process can
 * linger for an hour. Hence:
 *
 *  - stop() DELETES the table entry at once: the next request starts a
 *    fresh process on a free port instead of hitting a closed one;
 *  - the old port stays reserved until the process really exits;
 *  - SIGTERM is followed by SIGKILL after `graceMs` if the process is
 *    still around.
 */

/**
 * @typedef {object} UpstreamProc  The slice of a ChildProcess the table needs.
 * @property {(signal: string) => unknown} kill
 * @property {(event: "exit", listener: (code: number | null, signal: string | null) => void) => unknown} on
 * @property {number | null} exitCode
 * @property {string | null} signalCode
 */

/**
 * @typedef {object} UpstreamEntry
 * @property {string} name
 * @property {number} port
 * @property {UpstreamProc} proc
 * @property {Promise<void>} ready   resolves once the port accepts connections
 * @property {number} lastSeen
 * @property {boolean} stopping
 */

/**
 * @param {{
 *   launch: (name: string, port: number) => { proc: UpstreamProc, ready: Promise<void> },
 *   basePort?: number,
 *   portSpan?: number,
 *   idleMs: number,
 *   graceMs?: number,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   timers?: { setTimeout: (fn: () => void, ms: number) => { unref?: () => unknown } | undefined },
 * }} options
 */
export function createUpstreamManager({
	launch,
	basePort = 4100,
	portSpan = 500,
	idleMs,
	graceMs = 15_000,
	log = () => {},
	now = Date.now,
	timers = { setTimeout },
}) {
	/** @type {Map<string, UpstreamEntry>} */
	const upstreams = new Map();
	/** @type {Set<number>} */
	const usedPorts = new Set();

	function allocPort() {
		for (let p = basePort; p < basePort + portSpan; p++) {
			if (!usedPorts.has(p)) { usedPorts.add(p); return p; }
		}
		throw new Error("no free upstream port");
	}

	/** The live entry for a user, started if there is none. Touches lastSeen.
	 *  @param {string} name @returns {UpstreamEntry} */
	function ensure(name) {
		const live = upstreams.get(name);
		if (live) { live.lastSeen = now(); return live; }
		const port = allocPort();
		const { proc, ready } = launch(name, port);
		/** @type {UpstreamEntry} */
		const entry = { name, port, proc, ready, lastSeen: now(), stopping: false };
		ready.catch((err) => stop(name, entry, err?.message ?? String(err)));
		proc.on("exit", (code, signal) => {
			log(`app for ${name} exited (${signal ?? code})`);
			if (upstreams.get(name) === entry) upstreams.delete(name);
			usedPorts.delete(port);
		});
		upstreams.set(name, entry);
		return entry;
	}

	/** Forget the entry now; SIGTERM; SIGKILL after the grace period. Idempotent.
	 *  @param {string} name @param {UpstreamEntry} entry @param {string} why */
	function stop(name, entry, why) {
		if (upstreams.get(name) === entry) upstreams.delete(name);
		if (entry.stopping) return;
		entry.stopping = true;
		log(`stopping app for ${name} (${why})`);
		entry.proc.kill("SIGTERM");
		const t = timers.setTimeout(() => {
			if (entry.proc.exitCode === null && entry.proc.signalCode === null) {
				log(`app for ${name} did not exit after SIGTERM; killing`);
				entry.proc.kill("SIGKILL");
			}
		}, graceMs);
		t?.unref?.();
	}

	/** Stop every entry idle for longer than idleMs. */
	function sweep() {
		const t = now();
		for (const [name, u] of [...upstreams]) {
			if (t - u.lastSeen > idleMs) stop(name, u, "idle");
		}
	}

	/** @param {string} why */
	function stopAll(why) {
		for (const [name, u] of [...upstreams]) stop(name, u, why);
	}

	return {
		ensure,
		stop,
		sweep,
		stopAll,
		/** @param {string} name */
		get: (name) => upstreams.get(name),
		get size() { return upstreams.size; },
		/** Ports currently reserved (live or still exiting) — for tests. */
		get reservedPorts() { return [...usedPorts]; },
	};
}
