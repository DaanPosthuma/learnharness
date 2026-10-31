"use client";

/**
 * The saved-sessions list for the offline page (mobile wave). Reads the
 * service worker's API cache directly: a session is "saved" when both its
 * record (/api/chats/:id) and its page (/chat/:id) are cached, which is
 * exactly what the warmer (components/pwa.tsx) stores.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { useOnline, warmOfflineCache } from "@/components/pwa";

type Saved = { id: string; title: string; updatedAt: string; kind: "teach" | "practice" };

async function readSaved(): Promise<Saved[] | null> {
	if (typeof caches === "undefined") return null;
	const names = await caches.keys();
	const apiName = names.find((n) => n.startsWith("lh-api-"));
	const pagesName = names.find((n) => n.startsWith("lh-pages-"));
	if (!apiName || !pagesName) return [];
	const api = await caches.open(apiName);
	const pages = await caches.open(pagesName);
	const list = await api.match("/api/chats", { ignoreVary: true });
	if (!list) return [];
	let chats: Saved[] = [];
	try { chats = ((await list.json()) as { chats?: Saved[] }).chats ?? []; } catch { return []; }
	const saved: Saved[] = [];
	for (const chat of chats) {
		const id = encodeURIComponent(chat.id);
		const [record, page] = await Promise.all([
			api.match(`/api/chats/${id}`, { ignoreVary: true }),
			pages.match(`/chat/${id}`, { ignoreVary: true }),
		]);
		if (record && page) saved.push(chat);
	}
	return saved;
}

export function OfflineLibrary() {
	const online = useOnline();
	const [saved, setSaved] = useState<Saved[] | null>(null);
	const [warming, setWarming] = useState(false);
	useEffect(() => { void readSaved().then(setSaved); }, []);

	const warm = async () => {
		setWarming(true);
		try { await warmOfflineCache(true); setSaved(await readSaved()); } finally { setWarming(false); }
	};

	return (
		<div className="mt-6 flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={() => location.assign("/")}
					className="h-9 rounded-md border border-border bg-card px-3 font-mono text-xs uppercase tracking-wide transition-colors hover:bg-accent"
				>
					Try again
				</button>
				{online && (
					<button
						type="button"
						disabled={warming}
						onClick={() => void warm()}
						className="h-9 rounded-md border border-border px-3 font-mono text-xs uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
					>
						{warming ? "Saving…" : "Save recent sessions for offline"}
					</button>
				)}
			</div>
			<div>
				<h2 className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">Saved on this device</h2>
				{saved === null ? (
					<p className="mt-2 text-sm text-muted-foreground">Checking…</p>
				) : saved.length === 0 ? (
					<p className="mt-2 text-sm text-muted-foreground">
						Nothing saved yet. Open the app while online and recent sessions are saved automatically.
					</p>
				) : (
					<ul className="mt-2 divide-y divide-border rounded-md border border-border">
						{saved.map((chat) => (
							<li key={chat.id}>
								<Link href={`/chat/${encodeURIComponent(chat.id)}`} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-accent">
									<span className="min-w-0 truncate">{chat.title}</span>
									<span className="shrink-0 font-mono text-[11px] uppercase text-muted-foreground">{chat.kind === "practice" ? "practice" : "teaching"}</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
