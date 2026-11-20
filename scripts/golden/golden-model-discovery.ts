/**
 * golden-model-discovery.ts — pins the LLM ModelDiscoveryService PURE LOGIC
 * (Stage 6 / 2026-07-31).
 *
 * WHY THIS TEST EXISTS (closing a long-deferred DARK corner):
 *   ModelDiscoveryService (src/llm/ModelDiscoveryService.ts) was the 2nd of 2
 *   external-I/O units with NO golden test (deferred since Session 7 — "the
 *   main fn needs heavier mocking infra"). The MAIN fn (fetchProviderModels)
 *   does network calls, but the service is built from PURE helpers that decide:
 *     - which models to offer (mergeStaticAndFetchedModels, normalizeProviderModel)
 *     - whether a chosen model fits a slot (validateModelCapability)
 *     - how a routing config maps to a provider selection (routingToSelection)
 *     - the provider catalog surface (listStaticCatalog, listProviders)
 *   A regression in any of these silently breaks the AI settings UX (wrong
 *   models shown, wrong warnings, a model that can't do structured output
 *   assigned to a slot that needs it). These pure helpers are perfect golden
 *   candidates; the network fn is covered indirectly by golden:llm-adapters
 *   (which stubs fetch for the real provider calls).
 *
 * HAND-COMPUTED CONTRACT (anti-cheat — written before running):
 *
 *   CASE A — listProviders: returns the LLM_PROVIDERS set, each with honest
 *     requiresApiKey (false only for mock + ollama) + requiresBaseUrl (true for
 *     ollama + the 3 _compatible).
 *   CASE B — listStaticCatalog: no-arg returns DEFAULT_MODEL_CATALOG; a known
 *     provider returns that provider's catalog subset.
 *   CASE C — mergeStaticAndFetchedModels: fetched models OVERRIDE static ones
 *     with the same id (the user's live endpoint wins); novel fetched models
 *     are appended; static-only models survive. Hand-computed for a 2+2 set
 *     with 1 overlap.
 *   CASE D — normalizeProviderModel: an unknown model from openai_compatible
 *     gets a deterministic catalog entry (id `provider:model`, capabilities
 *     include structured_output, requiresApiKey=true, requiresBaseUrl=true).
 *     A KNOWN model name matches the static catalog (returns the static entry,
 *     not a synthesized one). An ollama model is tier=local + local_runtime.
 *   CASE E — validateModelCapability: a model MISSING a slot's required
 *     capability yields a warning (ok=false); a model WITH it + not deprecated
 *     + not mock/ollama yields ok=true (no warnings). A mock model always warns.
 *   CASE F — routingToSelection: a valid provider passes through; an INVALID
 *     provider falls back to "mock"; baseUrl is pulled from config when present.
 *
 * Run: npx tsx scripts/golden/golden-model-discovery.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  listProviders,
  listStaticCatalog,
  mergeStaticAndFetchedModels,
  normalizeProviderModel,
  validateModelCapability,
  routingToSelection,
} from "@/llm/ModelDiscoveryService";
import { SLOT_REQUIRED_CAPABILITIES } from "@/llm/model-capabilities";
import { DEFAULT_MODEL_CATALOG, listCatalog } from "@/llm/model-catalog";
import type { ModelCatalogEntry } from "@/llm/types";
import type { LLMModelRouting } from "@/lib/types";

/** Build a minimal-but-typed LLMModelRouting for routingToSelection tests. */
function routing(overrides: Partial<LLMModelRouting>): LLMModelRouting {
  return {
    id: "r1",
    workspaceId: "ws1",
    taskName: "message_generation",
    provider: "openai",
    modelTier: "daily_workhorse",
    isEnabled: true,
    config: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

// ─── CASE A: listProviders ──────────────────────────────────────────────────
test("CASE A — listProviders: honest requiresApiKey + requiresBaseUrl per provider", async () => {
  const providers = listProviders();
  const byId = new Map(providers.map((p) => [p.id, p]));
  // mock + ollama do NOT require an API key; everything else does.
  assert.strictEqual(byId.get("mock")!.requiresApiKey, false, "mock requires no key");
  assert.strictEqual(byId.get("ollama")!.requiresApiKey, false, "ollama requires no key");
  assert.strictEqual(byId.get("openai")!.requiresApiKey, true, "openai requires a key");
  // requiresBaseUrl true for ollama + the 3 _compatible providers.
  assert.strictEqual(byId.get("ollama")!.requiresBaseUrl, true, "ollama requires a base URL");
  assert.strictEqual(byId.get("openai_compatible")!.requiresBaseUrl, true, "openai_compatible requires a base URL");
  assert.strictEqual(byId.get("openai")!.requiresBaseUrl, false, "openai does NOT require a base URL");
});

// ─── CASE B: listStaticCatalog ──────────────────────────────────────────────
test("CASE B — listStaticCatalog: no-arg returns the default catalog; provider arg returns that subset", async () => {
  const all = listStaticCatalog();
  assert.strictEqual(all, DEFAULT_MODEL_CATALOG, "no-arg returns the DEFAULT_MODEL_CATALOG reference");
  assert.ok(all.length > 0, "default catalog is non-empty");
  // A known provider returns only that provider's catalog entries.
  const openaiModels = listStaticCatalog("openai");
  assert.ok(openaiModels.length > 0, "openai has static catalog entries");
  assert.ok(openaiModels.every((m) => m.provider === "openai"), "all returned entries are openai");
  // Matches the catalog helper directly.
  assert.deepEqual(openaiModels, listCatalog("openai"), "listStaticCatalog('openai') === listCatalog('openai')");
  // An unknown provider falls back to the default catalog (not an error).
  assert.strictEqual(listStaticCatalog("nonsense"), DEFAULT_MODEL_CATALOG, "unknown provider falls back to default");
});

// ─── CASE C: mergeStaticAndFetchedModels ────────────────────────────────────
test("CASE C — mergeStaticAndFetchedModels: fetched overrides static on id-collision; novel appended; static survives", async () => {
  const staticModels: ModelCatalogEntry[] = [
    { ...DEFAULT_MODEL_CATALOG[0], id: "a", displayName: "Static A" },
    { ...DEFAULT_MODEL_CATALOG[0], id: "b", displayName: "Static B" },
  ];
  const fetched: ModelCatalogEntry[] = [
    { ...DEFAULT_MODEL_CATALOG[0], id: "b", displayName: "Fetched B (override)" }, // overrides Static B
    { ...DEFAULT_MODEL_CATALOG[0], id: "c", displayName: "Fetched C (novel)" }, // appended
  ];
  const merged = mergeStaticAndFetchedModels(staticModels, fetched);
  const byId = new Map(merged.map((m) => [m.id, m]));
  assert.strictEqual(merged.length, 3, "2 static + 1 novel fetched = 3 unique ids");
  assert.strictEqual(byId.get("b")!.displayName, "Fetched B (override)", "fetched overrides static on id collision");
  assert.strictEqual(byId.get("a")!.displayName, "Static A", "static-only model survives");
  assert.strictEqual(byId.get("c")!.displayName, "Fetched C (novel)", "novel fetched model appended");
});

// ─── CASE D: normalizeProviderModel ─────────────────────────────────────────
test("CASE D — normalizeProviderModel: unknown model synthesized deterministically; known model matches static; ollama=local", async () => {
  // Unknown openai_compatible model → synthesized entry.
  const synth = normalizeProviderModel("openai_compatible", { id: "my-custom-model" });
  assert.strictEqual(synth.id, "openai_compatible:my-custom-model", "synthesized id is provider:modelName");
  assert.strictEqual(synth.modelName, "my-custom-model");
  assert.ok(synth.capabilities.includes("structured_output"), "non-ollama synthesized model supports structured_output");
  assert.strictEqual(synth.requiresApiKey, true, "openai_compatible requires a key");
  assert.strictEqual(synth.requiresBaseUrl, true, "openai_compatible requires a base URL");
  assert.strictEqual(synth.tier, "balanced", "non-ollama synthesized model is tier=balanced");

  // Ollama unknown model → tier=local + local_runtime capability.
  const local = normalizeProviderModel("ollama", { id: "llama3" });
  assert.strictEqual(local.tier, "local", "ollama model is tier=local");
  assert.ok(local.capabilities.includes("local_runtime"), "ollama model has local_runtime");
  assert.strictEqual(local.requiresApiKey, false, "ollama requires no key");

  // A KNOWN model name (one in the openai static catalog) returns the STATIC
  // entry, not a synthesized one (verified by checking it matches the catalog).
  const openaiCatalog = listCatalog("openai");
  if (openaiCatalog.length > 0) {
    const knownName = openaiCatalog[0].modelName;
    const viaNormalize = normalizeProviderModel("openai", { id: knownName });
    assert.strictEqual(viaNormalize.id, openaiCatalog[0].id, "known model returns the static catalog entry id");
  }
});

// ─── CASE E: validateModelCapability ────────────────────────────────────────
test("CASE E — validateModelCapability: missing-capability warns; complete+non-mock ok; mock always warns", async () => {
  // Pick a slot + its required capabilities (hand-computed from the source).
  const slotId = "daily_workhorse" as const;
  const required = SLOT_REQUIRED_CAPABILITIES[slotId];
  assert.ok(required.length > 0, "daily_workhorse has at least one required capability");

  // A model MISSING the required capability → warning, ok=false.
  const missing: ModelCatalogEntry = {
    ...DEFAULT_MODEL_CATALOG[0],
    id: "missing", provider: "openai", displayName: "Missing",
    capabilities: [], deprecated: false,
  };
  const rMissing = validateModelCapability(missing, slotId);
  assert.strictEqual(rMissing.ok, false, "missing-capability model is not ok");
  assert.ok(rMissing.warnings.length > 0, "missing-capability model yields warnings");

  // A model WITH the required capability + not deprecated/mock/ollama → ok.
  const complete: ModelCatalogEntry = {
    ...DEFAULT_MODEL_CATALOG[0],
    id: "complete", provider: "openai", displayName: "Complete",
    capabilities: [...required], deprecated: false,
  };
  const rComplete = validateModelCapability(complete, slotId);
  assert.strictEqual(rComplete.ok, true, "complete non-mock model is ok (no warnings)");
  assert.strictEqual(rComplete.warnings.length, 0, "no warnings for a complete non-mock model");

  // A mock model ALWAYS warns (even if it has the capability).
  const mockModel: ModelCatalogEntry = {
    ...DEFAULT_MODEL_CATALOG[0],
    id: "mock", provider: "mock", displayName: "Mock",
    capabilities: [...required], deprecated: false,
  };
  const rMock = validateModelCapability(mockModel, slotId);
  assert.strictEqual(rMock.ok, false, "mock model is never ok");
  assert.ok(rMock.warnings.some((w) => w.toLowerCase().includes("mock")), "mock model yields a mock-specific warning");

  // No model selected → not ok with a clear message.
  const rNone = validateModelCapability(undefined, slotId);
  assert.strictEqual(rNone.ok, false, "no model selected is not ok");
  assert.ok(rNone.warnings[0].toLowerCase().includes("mock fallback"), "no-model message mentions mock fallback");
});

// ─── CASE F: routingToSelection ─────────────────────────────────────────────
test("CASE F — routingToSelection: valid provider passes; invalid falls back to mock; baseUrl from config", async () => {
  const valid = routingToSelection(routing({ provider: "openai", modelName: "gpt-4o", config: { baseUrl: "https://x.com" } }));
  assert.strictEqual(valid.provider, "openai", "valid provider passes through");
  assert.strictEqual(valid.modelName, "gpt-4o");
  assert.strictEqual(valid.baseUrl, "https://x.com", "baseUrl pulled from config");

  const invalid = routingToSelection(routing({ provider: "bogus-provider", modelName: "x" }));
  assert.strictEqual(invalid.provider, "mock", "invalid provider falls back to mock");
  assert.strictEqual(invalid.baseUrl, undefined, "no config → no baseUrl");
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
    console.error("❌ golden-model-discovery FAILED.");
    process.exit(1);
  }
  console.log("✅ golden-model-discovery ALL GREEN ✅");
  process.exit(0);
})();
