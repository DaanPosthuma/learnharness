/* LearnHarness service worker (mobile wave).
 *
 * The job: keep the app usable on a commute with no signal. The teacher is
 * an LLM behind the network, so a lesson cannot ADVANCE offline — but
 * everything already learned can be read, and anything typed is kept until
 * the signal returns (the client-side outbox in components/session-core.ts).
 *
 * Strategy by request class (GET only; every mutation goes straight to the
 * network, and the live SSE channels are never touched):
 *   - /_next/static, /fonts, /icons  → cache-first (content-hashed / immutable)
 *   - navigations + RSC payloads      → network-first, cached copy when offline,
 *                                       /offline as the last resort
 *   - /api/* reads                    → network-first, cached copy when offline,
 *                                       stamped x-lh-from-cache: 1 so the UI can
 *                                       say "saved copy"
 *   - /login, /logout, /gateway/*     → untouched (the accounts gateway)
 *
 * Bump VERSION whenever the caching rules change: activate() drops every
 * cache from an older version.
 */
const VERSION = "v1";
const BUILD = "2026-10-31"; // bump to force a worker update on devices
const STATIC = `lh-static-${VERSION}`;
const PAGES = `lh-pages-${VERSION}`;
const API = `lh-api-${VERSION}`;
const KEEP = new Set([STATIC, PAGES, API]);

const PRECACHE = ["/", "/offline", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
const NETWORK_TIMEOUT_MS = 8000;

self.addEventListener("install", (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(PAGES);
		// Precache individually: one missing asset must not fail the install.
		await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})));
		await self.skipWaiting();
	})());
});

self.addEventListener("activate", (event) => {
	event.waitUntil((async () => {
		const names = await caches.keys();
		await Promise.all(names.filter((n) => n.startsWith("lh-") && !KEEP.has(n)).map((n) => caches.delete(n)));
		await self.clients.claim();
	})());
});

self.addEventListener("message", (event) => {
	if (event.data && event.data.type === "lh:skip-waiting") void self.skipWaiting();
});

/** Never intercept: auth surfaces, live streams, anything that is not a read. */
function passThrough(request, url) {
	if (request.method !== "GET") return true;
	if (url.origin !== self.location.origin) return true;
	const p = url.pathname;
	if (p === "/login" || p === "/logout" || p.startsWith("/gateway/")) return true;
	if (p === "/api/events" || p.endsWith("/stream")) return true; // SSE
	if (p === "/sw.js") return true;
	return false;
}

function isStatic(url) {
	const p = url.pathname;
	return p.startsWith("/_next/static/") || p.startsWith("/fonts/") || p.startsWith("/icons/") || p.startsWith("/worklets/") || /\.(woff2?|ttf|otf|png|svg|ico|webp)$/.test(p);
}

function isNavigation(request, url) {
	return request.mode === "navigate" || url.searchParams.has("_rsc") || request.headers.get("RSC") === "1";
}

async function cacheFirst(request) {
	const cache = await caches.open(STATIC);
	const hit = await cache.match(request);
	if (hit) return hit;
	const res = await fetch(request);
	if (res.ok) void cache.put(request, res.clone());
	return res;
}

function withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout")), ms);
		promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
	});
}

/** Re-wraps a cached response for delivery: marks it as a saved copy and
 *  drops the transport-encoding headers. The Cache API stores the DECODED
 *  body but keeps the server's Content-Encoding/Content-Length; handing a
 *  cached Response object straight to a navigation makes Chrome try to
 *  decode plain bytes as gzip and show "This page couldn't load". A
 *  synthetic Response with clean headers renders. */
function stamped(res) {
	const headers = new Headers(res.headers);
	headers.set("x-lh-from-cache", "1");
	headers.delete("content-encoding");
	headers.delete("content-length");
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function notifyUnauthorized() {
	const clients = await self.clients.matchAll({ type: "window" });
	for (const c of clients) c.postMessage({ type: "lh:unauthorized" });
}

async function networkFirst(request, cacheName, { navigate } = {}) {
	const cache = await caches.open(cacheName);
	try {
		const res = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
		// Only the GATEWAY's 401 means "sign in again"; the app's own routes
		// use 401 too (e.g. a missing dictation key) and must not bounce.
		if (res.status === 401 && !navigate && res.headers.get("x-lh-gateway") === "unauthorized") void notifyUnauthorized();
		// Cache only clean successes. Redirected responses (the gateway's
		// login bounce) must never shadow a real page.
		if (res.ok && !res.redirected && res.type === "basic") void cache.put(request, res.clone());
		return res;
	} catch (err) {
		const hit = await cache.match(request);
		if (hit) return stamped(hit);
		if (navigate && request.mode === "navigate") {
			const offline = await cache.match("/offline", { ignoreVary: true });
			if (offline) return stamped(offline);
		}
		throw err;
	}
}

/** The minimal offline page when even the cached /offline is unavailable. */
function inlineOffline(detail) {
	const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline · LearnHarness</title><body style="margin:0;min-height:100dvh;display:grid;place-items:center;background:#141414;color:#e6e6e6;font:14px/1.5 ui-monospace,monospace;padding:24px"><main style="max-width:360px"><h1 style="font:400 28px/1.2 Georgia,serif;margin:0 0 8px">You’re offline</h1><p style="color:#8d8d8d">This page isn’t saved on this device. <a style="color:#e6e6e6" href="/">Open the saved home page</a> or try again when you have a connection.</p><p style="color:#434343;font-size:11px">${detail ? String(detail).replace(/[<>&]/g, "") : ""}</p></main>`;
	return new Response(body, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function route(request, url) {
	if (isStatic(url)) return cacheFirst(request);
	if (url.pathname.startsWith("/api/")) return networkFirst(request, API);
	if (isNavigation(request, url)) return networkFirst(request, PAGES, { navigate: true });
	return networkFirst(request, PAGES);
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	const url = new URL(request.url);
	if (passThrough(request, url)) return;
	event.respondWith(route(request, url).catch(async (err) => {
		// Never let a navigation surface the browser's own error page: the
		// cached /offline first, an inline fallback last.
		if (request.mode === "navigate") {
			const cache = await caches.open(PAGES);
			const offline = await cache.match("/offline", { ignoreVary: true });
			return offline ? stamped(offline) : inlineOffline(err && err.message);
		}
		throw err;
	}));
});
