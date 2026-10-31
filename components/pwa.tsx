"use client";

/**
 * PWA plumbing (mobile wave): service-worker registration, the shared
 * online/offline truth, the offline banner, and the cache warmer that
 * saves recent sessions for reading with no signal.
 *
 * The service worker (public/sw.js) only activates in production builds —
 * or in dev with NEXT_PUBLIC_LH_PWA=1 — because its caching fights HMR.
 * Everything here is a no-op when it is not registered.
 */

import { useEffect, useSyncExternalStore } from "react";

export const PWA_ENABLED = process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_LH_PWA === "1";

// ---------------------------------------------------------------- online truth

const listeners = new Set<() => void>();
let wired = false;
function wire() {
	if (wired || typeof window === "undefined") return;
	wired = true;
	const notify = () => listeners.forEach((l) => l());
	window.addEventListener("online", notify);
	window.addEventListener("offline", notify);
}
function subscribe(cb: () => void) {
	wire();
	listeners.add(cb);
	return () => { listeners.delete(cb); };
}
const readOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine);

/** The browser's connectivity flag, as React state. Server render says online. */
export function useOnline(): boolean {
	return useSyncExternalStore(subscribe, readOnline, () => true);
}

// ------------------------------------------------------------- cache warming

const WARM_KEY = "lh:offline-warmed-at";
const WARM_EVERY_MS = 10 * 60 * 1000;
const WARM_CHATS = 25;
const ALWAYS = ["/api/graph", "/api/settings", "/api/models", "/api/activity", "/offline"];

/**
 * Pulls the home data and the most recent sessions through the service
 * worker so they are cached for offline reading. Idempotent and throttled
 * (once per 10 minutes per tab); `force` bypasses the throttle.
 */
export async function warmOfflineCache(force = false): Promise<number> {
	if (!PWA_ENABLED || typeof navigator === "undefined" || !navigator.onLine || !("serviceWorker" in navigator)) return 0;
	try {
		const last = Number(sessionStorage.getItem(WARM_KEY) ?? 0);
		if (!force && Date.now() - last < WARM_EVERY_MS) return 0;
		sessionStorage.setItem(WARM_KEY, String(Date.now()));
	} catch { /* storage unavailable: warm anyway */ }
	const reg = await navigator.serviceWorker.ready;
	if (!reg.active) return 0;
	const get = (url: string) => fetch(url, { credentials: "same-origin" }).then((r) => r.ok ? r : undefined).catch(() => undefined);
	await Promise.all(ALWAYS.map(get));
	const list = await get("/api/chats");
	if (!list) return 0;
	let chats: { id: string }[] = [];
	try { chats = ((await list.json()) as { chats?: { id: string }[] }).chats ?? []; } catch { return 0; }
	let saved = 0;
	for (const chat of chats.slice(0, WARM_CHATS)) {
		const id = encodeURIComponent(chat.id);
		const [record, page] = await Promise.all([get(`/api/chats/${id}`), get(`/chat/${id}`)]);
		if (record && page) saved++;
	}
	return saved;
}

// --------------------------------------------------------------- registration

/** Mount once (root layout). Registers the worker, redirects on an expired
 *  gateway session, and warms the offline cache after load and on reconnect. */
export function PwaRegister() {
	useEffect(() => {
		if (!PWA_ENABLED || !("serviceWorker" in navigator)) return;
		void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
		const onMessage = (event: MessageEvent) => {
			if (event.data?.type !== "lh:unauthorized") return;
			if (location.pathname === "/login") return;
			location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
		};
		navigator.serviceWorker.addEventListener("message", onMessage);
		const warm = () => { void warmOfflineCache(); };
		const initial = window.setTimeout(warm, 3000);
		window.addEventListener("online", warm);
		return () => {
			navigator.serviceWorker.removeEventListener("message", onMessage);
			window.clearTimeout(initial);
			window.removeEventListener("online", warm);
		};
	}, []);
	return null;
}

// -------------------------------------------------------------------- banner

/** A quiet strip at the top while the device is offline. */
export function OfflineBanner() {
	const online = useOnline();
	if (online) return null;
	return (
		<div
			role="status"
			className="fixed inset-x-0 top-0 z-[70] border-b border-border bg-card/95 pt-[env(safe-area-inset-top)] text-center font-mono text-[11px] uppercase tracking-wide text-muted-foreground backdrop-blur"
		>
			<div className="px-3 py-1.5">Offline — showing saved copies. Messages you send go out when you reconnect.</div>
		</div>
	);
}
