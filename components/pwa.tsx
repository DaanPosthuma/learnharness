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

import { useEffect, useState, useSyncExternalStore } from "react";

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

// ------------------------------------------------------ standalone scroll pin

/** iOS 26 home-screen apps (black-translucent status bar) can come up with
 *  the whole page offset upwards by about the status-bar height: the top bar
 *  sits under the clock, a strip shows below the composer, and a pull-down
 *  only shows the top until it springs back. Every route is an h-dvh shell,
 *  so the document itself never needs to scroll; CSS locks it (globals.css,
 *  display-mode: standalone) and this snaps any leftover page/visual-viewport
 *  offset back to 0. Never while a text field has focus: the keyboard
 *  legitimately pans the viewport to keep the caret visible. */
export function StandaloneScrollPin() {
	useEffect(() => {
		const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
		if (!standalone) return;
		const typing = () => {
			const el = document.activeElement as HTMLElement | null;
			return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
		};
		let frame = 0;
		const pin = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (typing()) return;
				const vv = window.visualViewport;
				if (window.scrollY !== 0 || window.scrollX !== 0 || (vv && (vv.offsetTop > 0.5 || vv.pageTop > 0.5))) window.scrollTo(0, 0);
			});
		};
		pin();
		const later = window.setTimeout(pin, 400);
		const onVisible = () => { if (document.visibilityState === "visible") pin(); };
		const vv = window.visualViewport;
		window.addEventListener("scroll", pin, { passive: true });
		window.addEventListener("resize", pin);
		window.addEventListener("pageshow", pin);
		window.addEventListener("orientationchange", pin);
		document.addEventListener("visibilitychange", onVisible);
		document.addEventListener("focusout", pin);
		vv?.addEventListener("resize", pin);
		vv?.addEventListener("scroll", pin);
		return () => {
			cancelAnimationFrame(frame);
			window.clearTimeout(later);
			window.removeEventListener("scroll", pin);
			window.removeEventListener("resize", pin);
			window.removeEventListener("pageshow", pin);
			window.removeEventListener("orientationchange", pin);
			document.removeEventListener("visibilitychange", onVisible);
			document.removeEventListener("focusout", pin);
			vv?.removeEventListener("resize", pin);
			vv?.removeEventListener("scroll", pin);
		};
	}, []);
	return null;
}

// ------------------------------------------- TEMPORARY standalone viewport diag

/** TEMPORARY (2026-11-22): the iOS home-screen layout still sits under the
 *  status bar; this prints the viewport numbers so a phone screenshot tells
 *  which iOS bug it is. Standalone only; tap to hide. Remove after. */
export function StandaloneViewportDiag() {
	const [lines, setLines] = useState<string[] | null>(null);
	const [hidden, setHidden] = useState(false);
	useEffect(() => {
		const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
		if (!standalone) return;
		const probe = (css: string) => {
			const d = document.createElement("div");
			d.style.cssText = "position:fixed;left:0;top:0;width:1px;visibility:hidden;pointer-events:none;" + css;
			document.body.appendChild(d);
			const r = d.getBoundingClientRect();
			const cs = getComputedStyle(d);
			d.remove();
			return { h: Math.round(r.height), pt: cs.paddingTop, pb: cs.paddingBottom };
		};
		const read = () => {
			const vv = window.visualViewport;
			const env = probe("padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);height:0");
			const fixed = (() => {
				const d = document.createElement("div");
				d.style.cssText = "position:fixed;inset:0;visibility:hidden;pointer-events:none";
				document.body.appendChild(d);
				const r = d.getBoundingClientRect();
				d.remove();
				return `${Math.round(r.top)}..${Math.round(r.bottom)}`;
			})();
			const shell = document.querySelector(".h-dvh")?.getBoundingClientRect();
			const bar = document.querySelector(".lh-top-bar, .lh-safe-top, .lh-safe-top-2")?.getBoundingClientRect();
			setLines([
				`screen ${screen.width}x${screen.height}  dpr ${devicePixelRatio}`,
				`inner ${innerWidth}x${innerHeight}  docEl ${document.documentElement.clientHeight}`,
				`vv h ${vv ? Math.round(vv.height) : "-"} offTop ${vv?.offsetTop ?? "-"} pageTop ${vv?.pageTop ?? "-"}`,
				`scrollY ${scrollY}  fixed-inset0 ${fixed}`,
				`safe top ${env.pt} bottom ${env.pb}`,
				`vh ${probe("height:100vh").h} dvh ${probe("height:100dvh").h} svh ${probe("height:100svh").h} lvh ${probe("height:100lvh").h}`,
				`shell ${shell ? `${Math.round(shell.top)}..${Math.round(shell.bottom)}` : "-"}  chrome ${bar ? `${Math.round(bar.top)}..${Math.round(bar.bottom)}` : "-"}`,
				navigator.userAgent.replace(/^.*?\(([^)]*)\).*$/, "$1"),
			]);
		};
		read();
		const t = window.setTimeout(read, 1500);
		window.addEventListener("resize", read);
		return () => { window.clearTimeout(t); window.removeEventListener("resize", read); };
	}, []);
	if (!lines || hidden) return null;
	return (
		<button
			type="button"
			onClick={() => setHidden(true)}
			className="fixed left-1/2 top-1/3 z-[90] -translate-x-1/2 rounded-md border border-border bg-card/95 px-3 py-2 text-left font-mono text-[11px] leading-snug text-foreground shadow-xl"
		>
			{lines.map((l, i) => <div key={i}>{l}</div>)}
			<div className="mt-1 text-muted-foreground">viewport check, tap to hide</div>
		</button>
	);
}
