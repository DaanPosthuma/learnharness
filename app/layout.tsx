import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { OfflineBanner, PwaRegister } from "@/components/pwa";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	applicationName: "LearnHarness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
	// Installable web app (mobile wave): manifest + home-screen icons; iOS
	// reads the apple-* tags, Android/desktop Chrome the manifest.
	manifest: "/manifest.webmanifest",
	icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
	appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "LearnHarness" },
};

export const viewport: Viewport = {
	themeColor: "#141414",
	width: "device-width",
	initialScale: 1,
	// Edge-to-edge on notched phones; safe-area insets are applied where the
	// chrome touches the edges (globals.css, mobile section).
	viewportFit: "cover",
	// The on-screen keyboard shrinks the layout viewport instead of
	// overlaying it, so the composer dock stays above the keys.
	interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" className={`dark ${ui.variable} ${prose.variable}`}>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
			{/* Offline support (mobile wave): service worker + the offline strip. */}
			<PwaRegister />
			<OfflineBanner />
		</body>
		</html>
	);
}
