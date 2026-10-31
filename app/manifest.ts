import type { MetadataRoute } from "next";

/**
 * Web app manifest (mobile wave): makes the web build installable on a
 * phone home screen — standalone display, the app's own dark chrome, the
 * desktop icon artwork rendered by scripts/pwa-icons.mjs. Served by Next
 * at /manifest.webmanifest and linked from the root layout's metadata.
 */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "LearnHarness",
		short_name: "LearnHarness",
		description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
		id: "/",
		start_url: "/",
		scope: "/",
		display: "standalone",
		orientation: "portrait",
		background_color: "#141414",
		theme_color: "#141414",
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
			{ src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
