/**
 * golden-model-catalog.ts — pins src/llm/model-capabilities.ts + model-catalog.ts
 * (Session 7 Coverage Map, 2026-07-28). These are the LLM routing DATA layer:
 * which models exist, which capabilities each slot requires, and the slot labels
 * shown in AI Settings. A regression silently breaks model routing (a slot asks
 * for a capability no model has) or shows wrong labels. Both DARK. This pins them.
 *
 * HAND-COMPUTED (anti-cheat):
 *   findModel: (provider, modelName) lookup — mock:mock-fast exists; anthropic:bogus → undefined.
 *   listCatalog: filter by provider returns ONLY that provider's models.
 *   assertNoDuplicateModelIds: every catalog entry has a unique id (provider:modelName).
 *   SLOT_REQUIRED_CAPABILITIES: daily_workhorse requires text_generation + structured_output;
 *     research_search requires web_search. SLOT_LABELS maps each slot to a human label.
 *
 * Run: `npm run golden:model-catalog`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { findModel, listCatalog, assertNoDuplicateModelIds, DEFAULT_MODEL_CATALOG } from "@/llm/model-catalog";
import { SLOT_IDS, SLOT_LABELS, SLOT_REQUIRED_CAPABILITIES } from "@/llm/model-capabilities";

async function main() {
  console.log("golden-model-catalog: pinning model catalog + slot capability requirements...\n");

  // === Catalog lookups =====================================================

  // M1 — findModel matches BOTH provider AND modelName.
  {
    const m = findModel("mock", "mock-fast");
    assert.ok(m, "M1: mock:mock-fast exists in the catalog");
    assert.strictEqual(m.provider, "mock", "M1: provider is mock");
    assert.strictEqual(m.modelName, "mock-fast", "M1: modelName is mock-fast");
    console.log("  M1 OK: findModel(provider, modelName) returns the right entry.");
  }

  // M2 — findModel returns undefined for a nonexistent model (no guess).
  {
    const m = findModel("anthropic", "totally-bogus-model-name");
    assert.strictEqual(m, undefined, "M2: nonexistent model → undefined (no fallback guess)");
    console.log("  M2 OK: nonexistent model → undefined.");
  }

  // M3 — listCatalog(provider) returns ONLY that provider's models.
  {
    const ollamaModels = listCatalog("ollama");
    assert.ok(ollamaModels.length > 0, "M3: ollama has catalog entries");
    assert.ok(ollamaModels.every((m) => m.provider === "ollama"), "M3: every returned model is ollama");
    console.log(`  M3 OK: listCatalog('ollama') returns ${ollamaModels.length} ollama-only models.`);
  }

  // M4 — listCatalog() with no arg returns the full catalog.
  {
    const all = listCatalog();
    assert.ok(all.length === DEFAULT_MODEL_CATALOG.length, "M4: listCatalog() returns the full default catalog");
    assert.ok(all.length > 20, `M4: catalog is non-trivial (${all.length} entries)`);
    console.log(`  M4 OK: listCatalog() returns the full catalog (${all.length} entries).`);
  }

  // M5 — assertNoDuplicateModelIds: every catalog entry has a unique id.
  {
    assert.strictEqual(assertNoDuplicateModelIds(), true, "M5: no duplicate model ids in the catalog");
    // Cross-check: the ids are actually unique.
    const ids = DEFAULT_MODEL_CATALOG.map((m) => m.id);
    assert.strictEqual(new Set(ids).size, ids.length, "M5: id set size === id count (no dupes)");
    console.log("  M5 OK: every catalog entry has a unique id (no routing collisions).");
  }

  // === Slot capability requirements (the routing contract) =================

  // S1 — daily_workhorse requires text_generation + structured_output.
  {
    const req = SLOT_REQUIRED_CAPABILITIES.daily_workhorse;
    assert.ok(Array.isArray(req), "S1: daily_workhorse requirements is an array");
    assert.ok(req.includes("text_generation"), "S1: daily_workhorse requires text_generation");
    assert.ok(req.includes("structured_output"), "S1: daily_workhorse requires structured_output");
    console.log(`  S1 OK: daily_workhorse requires [${req.join(", ")}].`);
  }

  // S2 — research_search requires web_search (the load-bearing routing rule).
  {
    const req = SLOT_REQUIRED_CAPABILITIES.research_search;
    assert.ok(req.includes("web_search"), `S2: research_search requires web_search, got [${req.join(", ")}]`);
    console.log(`  S2 OK: research_search requires web_search (load-bearing routing rule).`);
  }

  // S3 — every slot id has a human label (so AI Settings never shows an empty/undefined label).
  {
    assert.ok(SLOT_IDS.length >= 5, `S3: there are ≥5 slots, got ${SLOT_IDS.length}`);
    for (const slotId of SLOT_IDS) {
      const label = SLOT_LABELS[slotId];
      assert.ok(typeof label === "string" && label.length > 0, `S3: slot "${slotId}" has a non-empty label, got "${label}"`);
    }
    console.log(`  S3 OK: all ${SLOT_IDS.length} slots have non-empty human labels.`);
  }

  console.log("\nPASS golden-model-catalog: catalog lookups (5) + slot requirements (3).");
}

main().catch((err) => {
  console.error("\nFAIL golden-model-catalog:", err.message);
  process.exit(1);
});
