import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	USERNAME_RE, generatePassword, hashPassword, loadOrCreateSecret, loadUsers, parseCookies, removeUser, safeNext, saveUsers,
	sessionPayload, sessionUser, signSession, upsertUser, verifyPassword, verifySession,
} from "../gateway/lib.mjs";

const FAST = { N: 2 ** 10, r: 8, p: 1, keylen: 64 }; // test-speed scrypt

test("passwords: scrypt hash verifies the same password and rejects another", () => {
	const rec = hashPassword("correct horse battery", FAST);
	assert.equal(rec.algo, "scrypt");
	assert.ok(verifyPassword("correct horse battery", rec));
	assert.ok(!verifyPassword("correct horse batterx", rec));
	assert.ok(!verifyPassword("anything", null));
	// Unicode normalization: composed and decomposed forms are one password.
	const uni = hashPassword("café au lait", FAST);
	assert.ok(verifyPassword("café au lait", uni));
});

test("generated temporary passwords are readable groups from the unambiguous alphabet", () => {
	const pw = generatePassword();
	assert.match(pw, /^[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{4}$/);
	assert.notEqual(pw, generatePassword());
});

test("usernames: lowercase, dir-safe, 2-32 chars", () => {
	for (const ok of ["dean", "a1", "family_member-2", "x".repeat(32)]) assert.ok(USERNAME_RE.test(ok), ok);
	for (const bad of ["D", "Dean", "1abc", "has space", "a/b", "x".repeat(33), ""]) assert.ok(!USERNAME_RE.test(bad), bad);
});

test("users file: upsert, password version bump, remove, owner-only mode", () => {
	const home = mkdtempSync(path.join(tmpdir(), "lh-gw-"));
	assert.deepEqual(loadUsers(home), { users: [] });
	const data = loadUsers(home);
	const u = upsertUser(data, "dean", "first-password", { mustChange: true });
	assert.equal(u.pwVersion, 1);
	assert.equal(u.mustChangePassword, true);
	assert.throws(() => upsertUser(data, "dean", "short"), /at least 8/);
	assert.throws(() => upsertUser(data, "Bad Name", "long enough"), /invalid username/);
	upsertUser(data, "dean", "second-password");
	assert.equal(u.pwVersion, 2);
	assert.equal(u.mustChangePassword, false);
	saveUsers(home, data);
	const reread = loadUsers(home);
	assert.equal(reread.users.length, 1);
	assert.ok(verifyPassword("second-password", reread.users[0].password));
	assert.ok(!verifyPassword("first-password", reread.users[0].password));
	if (process.platform !== "win32") assert.equal(statSync(path.join(home, "users.json")).mode & 0o777, 0o600);
	assert.ok(removeUser(reread, "dean"));
	assert.ok(!removeUser(reread, "dean"));
	assert.ok(!readFileSync(path.join(home, "users.json"), "utf8").includes("second-password"));
});

test("sessions: signed cookie round-trips, expires, and dies with a password change", () => {
	const home = mkdtempSync(path.join(tmpdir(), "lh-gw-"));
	const secret = loadOrCreateSecret(home);
	assert.equal(loadOrCreateSecret(home), secret, "stable across restarts");
	const data = { users: [] as ReturnType<typeof upsertUser>[] };
	const user = upsertUser(data, "dean", "first-password");
	const now = 1_700_000_000_000;
	const token = signSession(secret, sessionPayload(user, 30, now));
	const payload = verifySession(secret, token, now + 1000);
	assert.ok(payload);
	assert.equal(sessionUser(data, payload)?.name, "dean");
	assert.equal(verifySession(secret, token, now + 31 * 86_400_000), null, "expired");
	assert.equal(verifySession(secret, token + "x", now), null, "tampered signature");
	assert.equal(verifySession("other-secret-other-secret-other-secret", token, now), null, "wrong secret");
	const [body = "", sig = ""] = token.split(".");
	const forged = `${Buffer.from(JSON.stringify({ u: "admin", v: 1, exp: now + 9e9 })).toString("base64url")}.${sig}`;
	assert.equal(verifySession(secret, forged, now), null, "forged payload");
	assert.ok(body.length > 0 && sig.length > 0);
	upsertUser(data, "dean", "second-password");
	assert.equal(sessionUser(data, payload), null, "old sessions stop verifying after a password change");
});

test("cookies and redirect targets are parsed defensively", () => {
	assert.deepEqual(parseCookies("a=1; lh_session=abc.def; b=%20x"), { a: "1", lh_session: "abc.def", b: " x" });
	assert.deepEqual(parseCookies(undefined), {});
	assert.equal(safeNext("/chat/abc?x=1"), "/chat/abc?x=1");
	assert.equal(safeNext("//evil.example"), "/");
	assert.equal(safeNext("https://evil.example"), "/");
	assert.equal(safeNext("/login?next=/"), "/");
	assert.equal(safeNext(null), "/");
});
