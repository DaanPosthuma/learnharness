#!/usr/bin/env node
/**
 * Accounts CLI (accounts wave, 2026-10-31) — manages users.json for the
 * gateway. Run on the server, as the user that owns LH_HOME.
 *
 *   node gateway/cli.mjs add <name> [--password <pw>]   create (or reset) an
 *                                                       account; without
 *                                                       --password a temporary
 *                                                       one is generated and the
 *                                                       person must change it at
 *                                                       first sign-in
 *   node gateway/cli.mjs passwd <name> [--password <pw>]
 *   node gateway/cli.mjs remove <name> [--purge]        --purge also deletes the
 *                                                       user's data directory
 *   node gateway/cli.mjs list
 *
 * LH_HOME selects the data root (default /var/lib/learnharness).
 */
import path from "node:path";
import { rmSync, existsSync } from "node:fs";
import { USERNAME_RE, findUser, generatePassword, loadUsers, removeUser, saveUsers, upsertUser } from "./lib.mjs";

const HOME = path.resolve(process.env.LH_HOME ?? "/var/lib/learnharness");
const [cmd, name, ...rest] = process.argv.slice(2);

function flag(key) {
	const i = rest.indexOf(key);
	return i >= 0 ? rest[i + 1] : undefined;
}
function has(key) { return rest.includes(key); }
function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }

const data = loadUsers(HOME);

switch (cmd) {
	case "add":
	case "passwd": {
		if (!name) fail(`usage: ${cmd} <name> [--password <pw>]`);
		const lower = name.toLowerCase();
		if (!USERNAME_RE.test(lower)) fail(`invalid username "${name}": 2-32 chars, lowercase letters, digits, - or _, starting with a letter`);
		if (cmd === "passwd" && !findUser(data, lower)) fail(`no such user "${lower}"`);
		const given = flag("--password");
		const password = given ?? generatePassword();
		const existed = !!findUser(data, lower);
		upsertUser(data, lower, password, { mustChange: given === undefined });
		saveUsers(HOME, data);
		console.log(`${existed ? "updated" : "created"} user ${lower}`);
		if (given === undefined) {
			console.log(`temporary password: ${password}`);
			console.log("they will be asked to choose their own password at first sign-in");
		}
		break;
	}
	case "remove": {
		if (!name) fail("usage: remove <name> [--purge]");
		const lower = name.toLowerCase();
		if (!removeUser(data, lower)) fail(`no such user "${lower}"`);
		saveUsers(HOME, data);
		console.log(`removed user ${lower}`);
		if (has("--purge")) {
			const dir = path.join(HOME, "users", lower);
			if (existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); console.log(`deleted ${dir}`); }
		} else {
			console.log(`data kept at ${path.join(HOME, "users", lower)} (pass --purge to delete it)`);
		}
		break;
	}
	case "list": {
		if (data.users.length === 0) { console.log("no users"); break; }
		for (const u of data.users) {
			console.log(`${u.name.padEnd(20)} created ${u.createdAt.slice(0, 10)}${u.mustChangePassword ? "  (temporary password)" : ""}`);
		}
		break;
	}
	default:
		console.log("usage: node gateway/cli.mjs <add|passwd|remove|list> ...");
		process.exit(cmd ? 1 : 0);
}
