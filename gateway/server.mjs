#!/usr/bin/env node
/**
 * Accounts gateway (accounts wave, 2026-10-31).
 *
 *   node gateway/server.mjs
 *
 * One public HTTP port. Sign-in with a username + password (gateway/cli.mjs
 * creates accounts), then every request is proxied to THAT user's own
 * LearnHarness process — started on demand on a loopback port with its own
 * LH_DATA_DIR and LH_AUTH_FILE, stopped again after LH_IDLE_MINUTES without
 * traffic. Users never share a process, so the app's single-learner design
 * holds (see gateway/lib.mjs).
 *
 * Environment:
 *   LH_HOME            data root (default /var/lib/learnharness):
 *                        users.json, gateway-secret, users/<name>/{data,auth.json}
 *   GATEWAY_PORT       public port (default 8080)
 *   GATEWAY_HOST       bind address (default 0.0.0.0)
 *   LH_BASE_PORT       first loopback port for user processes (default 4100)
 *   LH_IDLE_MINUTES    stop a user's process after this idle time (default 60)
 *   LH_APP_DIR         the built app (default: the repo this file lives in)
 *   LH_SESSION_DAYS    sign-in cookie lifetime (default 30)
 *   LH_COOKIE_SECURE   "1" always, "0" never, default auto (Secure when the
 *                      request arrived over https per x-forwarded-proto)
 *
 * Put a TLS terminator in front (Caddy in the provided compose file): the
 * PWA's service worker and installability require https.
 */
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	escapeHtml, loadOrCreateSecret, loadUsers, parseCookies, safeNext, saveUsers, sessionPayload, sessionUser,
	signSession, upsertUser, verifyPassword, verifySession,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(process.env.LH_APP_DIR ?? path.join(HERE, ".."));
const HOME = path.resolve(process.env.LH_HOME ?? "/var/lib/learnharness");
const PORT = Number(process.env.GATEWAY_PORT ?? 8080);
const HOST = process.env.GATEWAY_HOST ?? "0.0.0.0";
const BASE_PORT = Number(process.env.LH_BASE_PORT ?? 4100);
const IDLE_MS = Number(process.env.LH_IDLE_MINUTES ?? 60) * 60_000;
const SESSION_DAYS = Number(process.env.LH_SESSION_DAYS ?? 30);
const COOKIE = "lh_session";
const COOKIE_SECURE = process.env.LH_COOKIE_SECURE ?? "auto";
const NEXT_BIN = path.join(APP_DIR, "node_modules", "next", "dist", "bin", "next");
const START_TIMEOUT_MS = 90_000;

mkdirSync(HOME, { recursive: true });
const SECRET = loadOrCreateSecret(HOME);
const log = (...a) => console.log(new Date().toISOString(), "[gateway]", ...a);

// ------------------------------------------------------------ user processes

/** name → { port, proc, ready: Promise<void>, lastSeen } */
const upstreams = new Map();
const usedPorts = new Set();

function allocPort() {
	for (let p = BASE_PORT; p < BASE_PORT + 500; p++) if (!usedPorts.has(p)) { usedPorts.add(p); return p; }
	throw new Error("no free upstream port");
}

function waitForPort(port, deadline) {
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const s = net.connect({ host: "127.0.0.1", port });
			s.once("connect", () => { s.destroy(); resolve(); });
			s.once("error", () => {
				s.destroy();
				if (Date.now() > deadline) reject(new Error(`upstream on :${port} did not start`));
				else setTimeout(attempt, 250);
			});
		};
		attempt();
	});
}

function ensureUpstream(name) {
	const live = upstreams.get(name);
	if (live) { live.lastSeen = Date.now(); return live; }
	const port = allocPort();
	const userDir = path.join(HOME, "users", name);
	const dataDir = path.join(userDir, "data");
	mkdirSync(dataDir, { recursive: true });
	log(`starting app for ${name} on :${port}`);
	const proc = spawn(process.execPath, [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", String(port)], {
		cwd: APP_DIR,
		env: {
			...process.env,
			NODE_ENV: "production",
			PORT: String(port),
			HOSTNAME: "127.0.0.1",
			LH_DATA_DIR: dataDir,
			LH_AUTH_FILE: path.join(userDir, "auth.json"),
			LH_USER: name,
			// Never inherit the gateway's own port/host into the child.
			GATEWAY_PORT: undefined,
			GATEWAY_HOST: undefined,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const prefix = (chunk) => chunk.toString().split("\n").filter(Boolean).map((l) => `[${name}] ${l}`).join("\n");
	proc.stdout.on("data", (c) => console.log(prefix(c)));
	proc.stderr.on("data", (c) => console.error(prefix(c)));
	const entry = { port, proc, lastSeen: Date.now(), ready: waitForPort(port, Date.now() + START_TIMEOUT_MS) };
	entry.ready.catch((err) => { log(`${name}: ${err.message}`); proc.kill("SIGTERM"); });
	proc.on("exit", (code, signal) => {
		log(`app for ${name} exited (${signal ?? code})`);
		if (upstreams.get(name) === entry) upstreams.delete(name);
		usedPorts.delete(port);
	});
	upstreams.set(name, entry);
	return entry;
}

setInterval(() => {
	const now = Date.now();
	for (const [name, u] of upstreams) {
		if (now - u.lastSeen > IDLE_MS) { log(`stopping idle app for ${name}`); u.proc.kill("SIGTERM"); }
	}
}, 60_000).unref();

function shutdown() {
	log("shutting down");
	for (const u of upstreams.values()) u.proc.kill("SIGTERM");
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// -------------------------------------------------------------------- helpers

function isSecure(req) {
	if (COOKIE_SECURE === "1") return true;
	if (COOKIE_SECURE === "0") return false;
	return (req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
}

function setSessionCookie(req, res, token, maxAgeSeconds) {
	const parts = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
	if (isSecure(req)) parts.push("Secure");
	res.setHeader("Set-Cookie", parts.join("; "));
}

function wantsHtml(req) {
	const accept = req.headers.accept ?? "";
	const dest = req.headers["sec-fetch-dest"];
	if (dest) return dest === "document";
	return accept.includes("text/html");
}

function readBody(req, limit = 64 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0; const chunks = [];
		req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function send(res, status, body, type = "text/html; charset=utf-8", extra = {}) {
	res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Frame-Options": "DENY", ...extra });
	res.end(body);
}

function redirect(res, location, extra = {}) {
	res.writeHead(303, { Location: location, "Cache-Control": "no-store", ...extra });
	res.end();
}

function clientIp(req) {
	return (req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "?";
}

// Login attempts: 10 per 15 minutes per client IP.
const attempts = new Map();
function throttled(ip) {
	const now = Date.now();
	const rec = attempts.get(ip);
	if (!rec || rec.resetAt < now) { attempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 }); return false; }
	rec.count++;
	return rec.count > 10;
}

// ---------------------------------------------------------------------- pages

const PAGE_CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#141414;color:#e6e6e6;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:24px max(16px,env(safe-area-inset-left)) max(24px,env(safe-area-inset-bottom))}
main{width:100%;max-width:360px}
h1{font:400 28px/1.2 "CMU Serif",Georgia,serif;letter-spacing:-.01em;margin:0 0 4px}
p{margin:0 0 20px;color:#8d8d8d}
label{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8d8d8d;margin:14px 0 6px}
input{width:100%;height:44px;padding:0 12px;border:1px solid #434343;border-radius:8px;background:#1c1c1c;color:#e6e6e6;font:16px inherit}
input:focus{outline:none;border-color:#8d8d8d}
button{width:100%;height:44px;margin-top:20px;border:1px solid #434343;border-radius:8px;background:#e6e6e6;color:#141414;font:600 13px/1 inherit;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}
button:hover{background:#fff}
.err{border:1px solid #7a3b3b;background:#2a1717;color:#f0b4b4;border-radius:8px;padding:10px 12px;margin-top:16px}
.ok{border:1px solid #3b6a3b;background:#172a17;color:#b4f0b4;border-radius:8px;padding:10px 12px;margin-top:16px}
a{color:#8d8d8d}
.row{display:flex;justify-content:space-between;align-items:center;margin-top:18px;font-size:12px}
`;

function page(title, body) {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#141414"><title>${escapeHtml(title)} · LearnHarness</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`;
}

function loginPage({ next = "/", error = "", user = "" } = {}) {
	return page("Sign in", `
<h1>LearnHarness</h1>
<p>Sign in to your own sessions and knowledge graph.</p>
<form method="post" action="/login" autocomplete="on">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="u">Username</label>
<input id="u" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus value="${escapeHtml(user)}">
<label for="p">Password</label>
<input id="p" name="password" type="password" autocomplete="current-password" required>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<button type="submit">Sign in</button>
</form>`);
}

function accountPage(user, { error = "", ok = "", first = false } = {}) {
	return page("Account", `
<h1>${escapeHtml(user.name)}</h1>
<p>${first ? "Choose your own password before continuing." : "Change your password. Other devices will need to sign in again."}</p>
<form method="post" action="/account" autocomplete="on">
<input type="hidden" name="username" value="${escapeHtml(user.name)}" autocomplete="username">
<label for="c">Current password</label>
<input id="c" name="current" type="password" autocomplete="current-password" required>
<label for="n">New password</label>
<input id="n" name="password" type="password" autocomplete="new-password" minlength="8" required>
<label for="n2">New password again</label>
<input id="n2" name="confirm" type="password" autocomplete="new-password" minlength="8" required>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
${ok ? `<div class="ok">${escapeHtml(ok)}</div>` : ""}
<button type="submit">Save password</button>
</form>
<div class="row"><a href="/">← Back to the app</a><form method="post" action="/logout" style="margin:0"><button type="submit" style="width:auto;height:32px;margin:0;padding:0 12px;background:transparent;color:#8d8d8d">Sign out</button></form></div>`);
}

// ------------------------------------------------------------- public assets

/** Files served to anyone, straight from disk: the browser fetches the web
 *  manifest WITHOUT cookies (credentials: omit), and the service worker and
 *  icons must load before sign-in for the install prompt to work. None of
 *  these carry user data. Everything else needs a session and a process. */
const PUBLIC_DIR = path.join(APP_DIR, "public");
const PUBLIC_EXACT = new Set(["/manifest.webmanifest", "/sw.js", "/favicon.ico"]);
const PUBLIC_TYPES = { ".webmanifest": "application/manifest+json", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml" };

function publicFile(p) {
	if (!(PUBLIC_EXACT.has(p) || p.startsWith("/icons/"))) return null;
	const file = path.resolve(PUBLIC_DIR, "." + p);
	if (!file.startsWith(PUBLIC_DIR + path.sep)) return null; // no traversal
	return existsSync(file) ? file : null;
}

async function servePublic(res, file) {
	const { readFile } = await import("node:fs/promises");
	const body = await readFile(file);
	const type = PUBLIC_TYPES[path.extname(file)] ?? "application/octet-stream";
	// The worker script must never be cached by the browser's HTTP cache.
	const cache = file.endsWith("sw.js") ? "no-cache" : "public, max-age=3600";
	res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": cache });
	res.end(body);
}

// -------------------------------------------------------------------- routing

function currentUser(req) {
	const payload = verifySession(SECRET, parseCookies(req.headers.cookie)[COOKIE]);
	return sessionUser(loadUsers(HOME), payload);
}

async function handle(req, res) {
	const url = new URL(req.url, "http://gateway");
	const p = url.pathname;

	if (p === "/gateway/health") return send(res, 200, JSON.stringify({ ok: true, users: upstreams.size }), "application/json");

	if (req.method === "GET" || req.method === "HEAD") {
		const file = publicFile(p);
		if (file) return servePublic(res, file);
	}

	if (p === "/login") {
		if (req.method === "GET" || req.method === "HEAD") {
			if (currentUser(req)) return redirect(res, safeNext(url.searchParams.get("next")));
			return send(res, 200, loginPage({ next: safeNext(url.searchParams.get("next")) }));
		}
		if (req.method === "POST") {
			const ip = clientIp(req);
			const form = new URLSearchParams(await readBody(req));
			const next = safeNext(form.get("next"));
			const username = (form.get("username") ?? "").trim().toLowerCase();
			const password = form.get("password") ?? "";
			if (throttled(ip)) return send(res, 429, loginPage({ next, user: username, error: "Too many attempts. Try again in a few minutes." }));
			const data = loadUsers(HOME);
			const user = data.users.find((u) => u.name === username);
			if (!user || !verifyPassword(password, user.password)) {
				log(`failed sign-in for "${username}" from ${ip}`);
				return send(res, 401, loginPage({ next, user: username, error: "Wrong username or password." }));
			}
			setSessionCookie(req, res, signSession(SECRET, sessionPayload(user, SESSION_DAYS)), SESSION_DAYS * 86_400);
			log(`${username} signed in from ${ip}`);
			return redirect(res, user.mustChangePassword ? `/account?first=1&next=${encodeURIComponent(next)}` : next);
		}
		return send(res, 405, "Method not allowed", "text/plain");
	}

	if (p === "/logout" && req.method === "POST") {
		setSessionCookie(req, res, "", 0);
		return redirect(res, "/login");
	}

	const user = currentUser(req);
	if (!user) {
		if (p.startsWith("/api/") || p.startsWith("/gateway/") || !wantsHtml(req)) {
			// The header is what the service worker keys on: the app's own
			// routes also answer 401 (a missing Deepgram key, say) and those
			// must not bounce the page to the sign-in screen.
			return send(res, 401, JSON.stringify({ error: "Sign in required", login: "/login" }), "application/json", { "x-lh-gateway": "unauthorized" });
		}
		return redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	}

	if (p === "/gateway/me") return send(res, 200, JSON.stringify({ user: user.name }), "application/json");

	if (p === "/account") {
		const first = url.searchParams.get("first") === "1" || user.mustChangePassword;
		if (req.method === "GET") return send(res, 200, accountPage(user, { first }));
		if (req.method === "POST") {
			const form = new URLSearchParams(await readBody(req));
			const current = form.get("current") ?? "", password = form.get("password") ?? "", confirm = form.get("confirm") ?? "";
			if (!verifyPassword(current, user.password)) return send(res, 400, accountPage(user, { first, error: "The current password is wrong." }));
			if (password.length < 8) return send(res, 400, accountPage(user, { first, error: "Use at least 8 characters." }));
			if (password !== confirm) return send(res, 400, accountPage(user, { first, error: "The two new passwords differ." }));
			const data = loadUsers(HOME);
			const updated = upsertUser(data, user.name, password, { mustChange: false });
			saveUsers(HOME, data);
			// Re-sign this device so the version bump does not log it out.
			setSessionCookie(req, res, signSession(SECRET, sessionPayload(updated, SESSION_DAYS)), SESSION_DAYS * 86_400);
			log(`${user.name} changed password`);
			if (first) return redirect(res, safeNext(url.searchParams.get("next")));
			return send(res, 200, accountPage(updated, { ok: "Password changed." }));
		}
		return send(res, 405, "Method not allowed", "text/plain");
	}

	// Everyone else goes to the user's own app process. A first-login user
	// finishes choosing a password before the app loads.
	if (user.mustChangePassword && wantsHtml(req)) return redirect(res, `/account?first=1&next=${encodeURIComponent(url.pathname + url.search)}`);

	const up = ensureUpstream(user.name);
	try { await up.ready; } catch { return send(res, 503, "The app did not start. Try again in a moment.", "text/plain"); }
	proxy(req, res, up, user);
}

function proxy(req, res, up, user) {
	const headers = { ...req.headers };
	delete headers.cookie; // the app never needs the gateway session
	headers["x-lh-user"] = user.name;
	headers["x-forwarded-for"] = clientIp(req);
	headers["x-forwarded-proto"] = isSecure(req) ? "https" : "http";
	headers["x-forwarded-host"] = req.headers.host ?? "";
	const out = http.request({ host: "127.0.0.1", port: up.port, method: req.method, path: req.url, headers }, (inc) => {
		res.writeHead(inc.statusCode ?? 502, inc.headers);
		// SSE and streams: pipe as it comes, nothing buffered.
		inc.pipe(res);
	});
	out.on("error", (err) => {
		log(`proxy error for ${user.name}: ${err.message}`);
		if (!res.headersSent) send(res, 502, "The app is not reachable right now.", "text/plain");
		else res.destroy();
	});
	req.on("aborted", () => out.destroy());
	res.on("close", () => { up.lastSeen = Date.now(); });
	req.pipe(out);
}

const server = http.createServer((req, res) => {
	handle(req, res).catch((err) => {
		log(`error: ${err.stack ?? err}`);
		if (!res.headersSent) send(res, 500, "Something went wrong.", "text/plain");
		else res.destroy();
	});
});
server.on("upgrade", (_req, socket) => socket.destroy()); // no WebSockets pass through
server.keepAliveTimeout = 65_000;
server.listen(PORT, HOST, () => {
	if (!existsSync(NEXT_BIN)) log(`WARNING: ${NEXT_BIN} not found — is LH_APP_DIR a built checkout with node_modules?`);
	log(`listening on http://${HOST}:${PORT} — data in ${HOME}, app in ${APP_DIR}`);
});
