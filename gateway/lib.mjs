/**
 * Accounts gateway — shared primitives (accounts wave, 2026-10-31).
 *
 * LearnHarness is a single-learner server by design: one process owns one
 * data directory, one key store, one knowledge graph. Family accounts are
 * therefore NOT threaded through the app. The gateway in front runs one
 * app process per signed-in user (its own LH_DATA_DIR + LH_AUTH_FILE) and
 * proxies each request to the owner's process. Nothing in the app changes;
 * no cross-user state can exist because no process ever sees two users.
 *
 * Zero dependencies: node:crypto scrypt for passwords, HMAC for cookies.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import path from "node:path";

export const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };

/** Usernames: short, lowercase, URL/dir safe — they name data directories. */
export const USERNAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;

export function hashPassword(password, params = SCRYPT) {
	const salt = randomBytes(16);
	const hash = scryptSync(password.normalize("NFKC"), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 });
	return { algo: "scrypt", N: params.N, r: params.r, p: params.p, salt: salt.toString("hex"), hash: hash.toString("hex") };
}

export function verifyPassword(password, rec) {
	if (!rec || rec.algo !== "scrypt") return false;
	const expected = Buffer.from(rec.hash, "hex");
	const actual = scryptSync(password.normalize("NFKC"), Buffer.from(rec.salt, "hex"), expected.length, { N: rec.N, r: rec.r, p: rec.p, maxmem: 128 * rec.N * rec.r * 2 });
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A temporary password a person can read over the shoulder and retype:
 *  three groups of four, no ambiguous glyphs (no 0/O, 1/l/I). */
export function generatePassword() {
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
	const bytes = randomBytes(12);
	let out = "";
	for (let i = 0; i < 12; i++) {
		if (i > 0 && i % 4 === 0) out += "-";
		out += alphabet[bytes[i] % alphabet.length];
	}
	return out;
}

// ------------------------------------------------------------------ users file

export function usersPath(home) { return path.join(home, "users.json"); }

export function loadUsers(home) {
	const file = usersPath(home);
	if (!existsSync(file)) return { users: [] };
	const parsed = JSON.parse(readFileSync(file, "utf8"));
	if (!parsed || !Array.isArray(parsed.users)) throw new Error(`${file}: expected {"users": [...]}`);
	return parsed;
}

/** Atomic write, owner-only: the file holds password hashes. */
export function saveUsers(home, data) {
	mkdirSync(home, { recursive: true });
	const file = usersPath(home);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, "\t") + "\n", { mode: 0o600 });
	renameSync(tmp, file);
	try { chmodSync(file, 0o600); } catch { /* non-POSIX fs */ }
}

export function findUser(data, name) {
	return data.users.find((u) => u.name === name) ?? null;
}

/** Create or replace a user's password. `pwVersion` bumps so sessions
 *  signed before a change stop verifying (see signSession). */
export function upsertUser(data, name, password, { mustChange = false } = {}) {
	if (!USERNAME_RE.test(name)) throw new Error(`invalid username "${name}": 2-32 chars, lowercase letters, digits, - or _, starting with a letter`);
	if (typeof password !== "string" || password.length < 8) throw new Error("password must be at least 8 characters");
	const existing = findUser(data, name);
	const now = new Date().toISOString();
	if (existing) {
		existing.password = hashPassword(password);
		existing.pwVersion = (existing.pwVersion ?? 0) + 1;
		existing.mustChangePassword = mustChange;
		existing.updatedAt = now;
		return existing;
	}
	const user = { name, createdAt: now, updatedAt: now, pwVersion: 1, mustChangePassword: mustChange, password: hashPassword(password) };
	data.users.push(user);
	return user;
}

export function removeUser(data, name) {
	const before = data.users.length;
	data.users = data.users.filter((u) => u.name !== name);
	return data.users.length !== before;
}

// ----------------------------------------------------------------- the secret

/** The cookie-signing secret, generated once per installation (owner-only file). */
export function loadOrCreateSecret(home) {
	mkdirSync(home, { recursive: true });
	const file = path.join(home, "gateway-secret");
	if (existsSync(file)) {
		const s = readFileSync(file, "utf8").trim();
		if (s.length >= 32) return s;
	}
	const secret = randomBytes(48).toString("base64url");
	writeFileSync(file, secret + "\n", { mode: 0o600 });
	return secret;
}

// ------------------------------------------------------------- session tokens

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }

/** token = base64url(json payload) . base64url(hmac-sha256(payload)) */
export function signSession(secret, payload) {
	const body = b64url(JSON.stringify(payload));
	const sig = createHmac("sha256", secret).update(body).digest("base64url");
	return `${body}.${sig}`;
}

export function verifySession(secret, token, now = Date.now()) {
	if (typeof token !== "string") return null;
	const dot = token.indexOf(".");
	if (dot <= 0) return null;
	const body = token.slice(0, dot), sig = token.slice(dot + 1);
	const expected = createHmac("sha256", secret).update(body).digest("base64url");
	const a = Buffer.from(sig), b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
	let payload;
	try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
	if (!payload || typeof payload.u !== "string" || typeof payload.exp !== "number" || typeof payload.v !== "number") return null;
	if (payload.exp <= now) return null;
	return payload;
}

/** The cookie's payload for a user: name, password version, expiry. */
export function sessionPayload(user, days, now = Date.now()) {
	return { u: user.name, v: user.pwVersion ?? 0, exp: now + days * 86_400_000 };
}

/** Resolves a verified payload to a live user, or null when the password
 *  changed since the cookie was signed (or the account is gone). */
export function sessionUser(data, payload) {
	if (!payload) return null;
	const user = findUser(data, payload.u);
	if (!user || (user.pwVersion ?? 0) !== payload.v) return null;
	return user;
}

// ------------------------------------------------------------------- helpers

export function parseCookies(header) {
	const out = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		const k = part.slice(0, i).trim();
		if (!k) continue;
		out[k] = decodeURIComponent(part.slice(i + 1).trim());
	}
	return out;
}

/** A redirect target is only honoured when it is a same-origin path. */
export function safeNext(value, fallback = "/") {
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
	if (value.startsWith("/login") || value.startsWith("/logout")) return fallback;
	return value;
}

export function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
