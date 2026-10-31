"use client";

/**
 * Who is signed in (accounts wave): the gateway answers /gateway/me with the
 * account name; without a gateway (desktop app, plain dev server) the route
 * does not exist and this renders nothing. Sits in the sidebar footer next
 * to Settings — the one place a family member can see which account a
 * shared phone is on, change their password, or sign out.
 */

import { useEffect, useState } from "react";
import { KeyRoundIcon, LogOutIcon, UserIcon } from "lucide-react";

export function AccountEntry() {
	const [user, setUser] = useState<string | null>(null);
	useEffect(() => {
		let alive = true;
		fetch("/gateway/me", { credentials: "same-origin" })
			.then((r) => (r.ok ? r.json() : null))
			.then((j: { user?: string } | null) => { if (alive && j?.user) setUser(j.user); })
			.catch(() => {});
		return () => { alive = false; };
	}, []);
	if (!user) return null;
	return (
		<div className="flex items-center gap-1 px-3 pt-1 text-xs text-muted-foreground" data-testid="account-entry">
			<span className="flex min-w-0 items-center gap-1.5 px-2 py-1.5">
				<UserIcon className="size-3 shrink-0" />
				<span className="truncate">{user}</span>
			</span>
			<a
				href="/account"
				title="Change password"
				aria-label="Change password"
				className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground"
			>
				<KeyRoundIcon className="size-3" />
			</a>
			<form method="post" action="/logout" className="contents">
				<button
					type="submit"
					title="Sign out"
					aria-label="Sign out"
					className="flex size-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground"
				>
					<LogOutIcon className="size-3" />
				</button>
			</form>
		</div>
	);
}
