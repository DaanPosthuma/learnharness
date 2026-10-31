import { OfflineLibrary } from "@/components/offline-library";

export const dynamic = "force-static";

/**
 * The offline fallback (mobile wave): what the service worker serves when a
 * navigation has no network and no cached copy. Lists the sessions that ARE
 * saved so a commute can continue with reading.
 */
export default function OfflinePage() {
	return (
		<div className="flex h-dvh flex-col overflow-y-auto px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))]">
			<h1 className="font-title text-3xl tracking-tight">You&rsquo;re offline</h1>
			<p className="mt-2 max-w-prose text-sm text-muted-foreground">
				This page isn&rsquo;t saved on this device. The teacher needs a connection to continue a lesson, but every session
				below was saved the last time you were online and can be read now.
			</p>
			<OfflineLibrary />
		</div>
	);
}
