/**
 * golden-ollama-provider.ts — pins the OllamaProvider pure logic (Stage 6 /
 * 2026-07-31 full coverage sweep).
 *
 * WHY THIS TEST EXISTS:
 *   OllamaProvider was the ONE LLM provider with no coverage (the others are
 *   pinned by golden:llm-adapters). Ollama is unique — local runtime, no API
 *   key, base-URL-driven, and its own capability set. The pure-logic pieces
 *   (capability advertising, the "no model selected" guard, JSON extraction)
 *   are pinned here. The network `runJsonTask` body stays covered by the
 *   shared fetch-stub pattern; this golden covers the DECISION logic.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *   CASE A — supportsCapability: advertises text_generation + local_runtime +
 *     embeddings; does NOT advertise structured_output / vision (Ollama's
 *     capability set is local-runtime-only).
 *   CASE B — runJsonTask "no model selected" guard: when no model is supplied
 *     (and the default ollama-custom is used), it throws the documented
 *     "fetch and select an installed Ollama model" error — never silently
 *     calls the local server with a bogus model.
 *   CASE C — extractJson: pulls the first {...} block out of a response;
 *     returns the text unchanged when no JSON object is present.
 *
 * Run: npx tsx scripts/golden/golden-ollama-provider.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { OllamaProvider, extractJson } from "@/llm/providers/OllamaProvider";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

// ─── CASE A: supportsCapability ─────────────────────────────────────────────
// 2026-08-02 audit fix: GAP-9 (2026-07-31) deliberately REMOVED "embeddings"
// from Ollama's advertised capabilities — runJsonTask only calls /api/chat and
// there is no /api/embeddings path here, so claiming embeddings misled users
// (selecting an Ollama embedding model produced nothing). The capability set
// is now honestly text_generation + local_runtime only. The assertion below
// was stale (still expected embeddings=true); updated to match the honest code.
test("CASE A — OllamaProvider.supportsCapability: local-runtime capability set only", async () => {
  const p = new OllamaProvider();
  assert.strictEqual(p.supportsCapability("text_generation"), true, "Ollama supports text_generation");
  assert.strictEqual(p.supportsCapability("local_runtime"), true, "Ollama supports local_runtime");
  assert.strictEqual(p.supportsCapability("embeddings"), false, "Ollama does NOT advertise embeddings (GAP-9: no /api/embeddings path — runJsonTask only calls /api/chat)");
  assert.strictEqual(p.supportsCapability("structured_output"), false, "Ollama does NOT advertise structured_output");
  assert.strictEqual(p.supportsCapability("vision"), false, "Ollama does NOT advertise vision");
});

// ─── CASE B: runJsonTask "no model selected" guard ──────────────────────────
test("CASE B — runJsonTask throws when no model is selected (never calls server with bogus model)", async () => {
  const p = new OllamaProvider();
  // No modelName + default ollama-custom → throws the documented guard error.
  await assert.rejects(
    () => p.runJsonTask({ modelName: undefined, prompt: "p", input: {} } as never),
    /fetch and select an installed Ollama model/i,
    "missing model throws the documented guard (no silent bogus call)",
  );
  // Explicit "ollama-custom" also triggers the guard.
  await assert.rejects(
    () => p.runJsonTask({ modelName: "ollama-custom", prompt: "p", input: {} } as never),
    /fetch and select an installed Ollama model/i,
  );
});

// ─── CASE C: extractJson ────────────────────────────────────────────────────
test("CASE C — extractJson pulls the first {...} block; returns text unchanged if no JSON", async () => {
  assert.strictEqual(extractJson('Here is the answer: {"a":1,"b":2} thanks'), '{"a":1,"b":2}', "extracts the JSON object from surrounding text");
  assert.strictEqual(extractJson('{"x":10}'), '{"x":10}', "pure JSON passes through");
  assert.strictEqual(extractJson("no json here at all"), "no json here at all", "no JSON → text unchanged");
});

// ─── Runner ─────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("❌ golden-ollama-provider FAILED.");
    process.exit(1);
  }
  console.log("✅ golden-ollama-provider ALL GREEN ✅");
  process.exit(0);
})();
