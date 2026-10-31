#!/usr/bin/env node
/**
 * PWA icon generation (mobile wave): renders build/icon-flat.svg — the
 * same artwork the desktop icon is cut from — into the PNG sizes the
 * web manifest and iOS home screen need. Run once and commit the output
 * (public/icons/); re-run only when the artwork changes.
 *
 *   node scripts/pwa-icons.mjs
 *
 * Uses @resvg/resvg-js, already a runtime dependency (visual-maker
 * rasterization), so this adds no toolchain. The maskable variant pads
 * the artwork to Android's 80% safe zone by widening the viewBox and
 * painting the app background behind it.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "build", "icon-flat.svg");
const OUT = path.join(ROOT, "public", "icons");
const BACKGROUND = "#141414"; // --background in app/globals.css

const svg = readFileSync(SRC, "utf8");
if (!svg.includes('viewBox="0 0 1024 1024"')) throw new Error("icon-flat.svg: expected a 0 0 1024 1024 viewBox");

/** Pads the artwork: a wider viewBox keeps the shape centered inside the safe zone. */
function padded(pad) {
	const size = 1024 + pad * 2;
	return svg
		.replace('viewBox="0 0 1024 1024"', `viewBox="${-pad} ${-pad} ${size} ${size}"`)
		.replace(/(<svg[^>]*>)/, `$1<rect x="${-pad}" y="${-pad}" width="${size}" height="${size}" fill="${BACKGROUND}"/>`);
}

function render(source, px) {
	return new Resvg(source, { fitTo: { mode: "width", value: px } }).render().asPng();
}

mkdirSync(OUT, { recursive: true });
const plan = [
	["icon-192.png", svg, 192],
	["icon-512.png", svg, 512],
	["apple-touch-icon.png", padded(96), 180],
	["icon-maskable-512.png", padded(205), 512],
];
for (const [name, source, px] of plan) {
	writeFileSync(path.join(OUT, name), render(source, px));
	console.log(`wrote public/icons/${name} (${px}px)`);
}
