/**
 * Provider endpoints (2026-11-01): a built-in provider routed through the
 * user's gateway. The engine's model carries the spec's base URL (pi-ai
 * builds its HTTP client from model.baseUrl), the catalog's address applies
 * without one, and resolution projects only set entries. Isolated: no
 * ambient auth, data or network.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-provider-endpoints-"));
const originalEnv = process.env, originalFetch = globalThis.fetch;
process.env = { PATH: originalEnv.PATH, HOME: directory, NODE_ENV: "test", NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT, LH_DATA_DIR: directory, LH_AUTH_FILE: path.join(directory, "auth.json"), ANTHROPIC_API_KEY: "fixture" };
fs.writeFileSync(process.env.LH_AUTH_FILE!, "{}");
globalThis.fetch = async () => { throw new Error("CLOSED: unexpected network request"); };
const { piEngineForSpec } = await import("../src/agent/models.ts");
const { resolveSettings } = await import("../src/core/settings-resolution.ts");
after(() => { process.env = originalEnv; globalThis.fetch = originalFetch; fs.rmSync(directory, { recursive: true, force: true }); });

test("without a baseUrl the engine streams against the catalog's address", () => {
	const engine = piEngineForSpec({ provider: "anthropic", id: "claude-sonnet-4-6" });
	assert.equal(engine.model.baseUrl, "https://api.anthropic.com");
});

test("a spec's baseUrl replaces the catalog's on the engine's model, nothing else changes", () => {
	const plain = piEngineForSpec({ provider: "anthropic", id: "claude-sonnet-4-6" });
	const routed = piEngineForSpec({ provider: "anthropic", id: "claude-sonnet-4-6", baseUrl: "https://gateway.example.test/anthropic" });
	assert.equal(routed.model.baseUrl, "https://gateway.example.test/anthropic");
	assert.deepEqual({ ...routed.model, baseUrl: plain.model.baseUrl }, plain.model);
	assert.equal(routed.level, plain.level);
});

test("resolveSettings projects only the providers with a URL set", () => {
	const effective = resolveSettings({ version: 1, providers: { anthropic: { baseUrl: "https://gateway.example.test" }, openai: {} } });
	assert.deepEqual(effective.providers, { anthropic: "https://gateway.example.test" });
	assert.deepEqual(resolveSettings(null).providers, {});
});
