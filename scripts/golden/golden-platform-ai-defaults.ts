/**
 * Golden test — N-AI-2: a fresh install must run on the operator's real key.
 *
 * WHERE THIS CAME FROM
 * --------------------
 * All six model slots defaulted to the `mock` provider, and nothing anywhere
 * ever pointed a new workspace at the platform key. An operator could install
 * the product with a correct, paid DeepSeek key in the environment, open it,
 * and have every customer reply written by `MockLLMProvider` — with no error,
 * no banner, and no way to tell from the reply itself. It looks like the AI is
 * working. That is the whole problem.
 *
 * WHAT THIS PINS
 * --------------
 *   CASE A — no key configured: everything stays on mock. That is the honest
 *     answer, not a defect — there is nothing else to run on.
 *   CASE B — a key IS configured: the slots that have a real model resolve to
 *     the real provider, and mock fallback is OFF for those slots. A live
 *     workspace must never answer a customer with generated placeholder text
 *     because the model call failed.
 *   CASE C — catalog integrity. Every model name in the platform table must
 *     exist in DEFAULT_MODEL_CATALOG at exactly the declared tier. This is what
 *     stops a typo in the table from shipping as a 404 at the customer.
 *   CASE D — provider choice is deterministic: preference order, an explicit
 *     PLATFORM_DEFAULT_PROVIDER pin, and a pin with no key behind it.
 *   CASE E — a blank or whitespace-only key counts as NO key. A half-filled
 *     .env line must not turn "no AI configured" into a runtime 401.
 *   CASE F — a saved slot row still wins over the platform default. The six-slot
 *     AI Settings screen stays authoritative (this is the UA-7 contract: what
 *     you see there is what runs).
 *
 * This golden owns process.env for its duration and restores it at the end.
 * Test isolation (Gate #8): no repository writes at all — pure resolution logic.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import {
  platformApiKey,
  platformSlotDefaults,
  platformSlotModelTable,
  resolvePlatformDefaultProvider,
  availablePlatformProviders,
  PLATFORM_KEY_ENV,
  PLATFORM_KEY_ENV_FALLBACK,
} from "@/llm/platform-defaults";
import { routeModelSelection, defaultSlotRoutes } from "@/llm/ModelRouter";
import { findModel } from "@/llm/model-catalog";
import type { LLMModelRouting } from "@/lib/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

// 2026-09-08 — the unprefixed names belong in here too. platformApiKey() reads
// them now, so a developer with DEEPSEEK_API_KEY in their .env would fail CASE A
// ("nothing configured") through no fault of the code under test.
const OWNED_ENV = [
  ...Object.values(PLATFORM_KEY_ENV),
  ...Object.values(PLATFORM_KEY_ENV_FALLBACK),
  "PLATFORM_DEFAULT_PROVIDER",
];
const SAVED: Record<string, string | undefined> = {};

function clearEnv() {
  for (const name of OWNED_ENV) delete process.env[name];
}

/** Never print a key. Length only — enough to prove one was set, useless if leaked. */
function keyShape(name: string): string {
  const v = process.env[name];
  return v ? `set (${v.length} chars)` : "unset";
}

function main() {
  for (const name of OWNED_ENV) SAVED[name] = process.env[name];

  // --- CASE A: nothing configured -------------------------------------------
  {
    clearEnv();
    assert(resolvePlatformDefaultProvider() === undefined, `CASE A: no key must resolve to no provider, got ${resolvePlatformDefaultProvider()}`);
    assert(availablePlatformProviders().length === 0, "CASE A: no providers available");
    const defaults = platformSlotDefaults();
    const slotIds = Object.keys(defaults);
    assert(slotIds.length === 6, `CASE A: six slots, got ${slotIds.length}`);
    for (const [slotId, slot] of Object.entries(defaults)) {
      assert(slot.provider === "mock", `CASE A: ${slotId} must be mock with no key, got ${slot.provider}`);
      assert(slot.enableMockFallback === true, `CASE A: ${slotId} keeps mock fallback with no key`);
    }
    const route = routeModelSelection("whatsapp_reply", []);
    assert(route.provider === "mock", `CASE A: whatsapp_reply on mock, got ${route.provider}`);
    assert(route.routeSource === "platform_default", `CASE A: routeSource platform_default, got ${route.routeSource}`);
    const seeded = defaultSlotRoutes("ws_pad_a");
    assert(seeded.length === 6 && seeded.every((r) => r.provider === "mock"), "CASE A: seeded routes are all mock");
    console.log("CASE A PASS - with no platform key every slot stays honestly on mock");
  }

  // --- CASE B: a real key IS configured -------------------------------------
  {
    clearEnv();
    process.env.PLATFORM_DEEPSEEK_API_KEY = "sk-golden-not-a-real-key";
    assert(resolvePlatformDefaultProvider() === "deepseek", `CASE B: deepseek expected, got ${resolvePlatformDefaultProvider()}`);

    const defaults = platformSlotDefaults();
    assert(defaults.fast_customer_reply.provider === "deepseek", `CASE B: customer replies must use the real provider, got ${defaults.fast_customer_reply.provider}`);
    assert(defaults.fast_customer_reply.modelName === "deepseek-chat", `CASE B: got ${defaults.fast_customer_reply.modelName}`);
    assert(defaults.fast_customer_reply.enableMockFallback === false,
      "CASE B: a REAL slot must not silently fall back to mock text — the operator would review invented sentences believing the model wrote them");
    assert(defaults.deep_reasoning.modelName === "deepseek-reasoner", `CASE B: got ${defaults.deep_reasoning.modelName}`);

    // The two deliberate exceptions.
    assert(defaults.creative_image.provider === "mock", "CASE B: image generation is not wired to any provider, so it stays mock");
    assert(defaults.embedding_advanced.provider === "mock", "CASE B: deepseek has no embedding model, so that slot stays mock");
    assert(defaults.creative_image.enableMockFallback === true, "CASE B: mock slots keep mock fallback");

    // The route the WhatsApp reply engine actually asks for.
    const route = routeModelSelection("whatsapp_reply", []);
    assert(route.provider === "deepseek" && route.modelName === "deepseek-chat",
      `CASE B: whatsapp_reply must route to the real model, got ${route.provider}/${route.modelName}`);
    assert(route.enableMockFallback === false, "CASE B: whatsapp_reply must not fall back to mock");
    assert(route.fallbackProvider === "deepseek", `CASE B: fallback stays on the real provider, got ${route.fallbackProvider}`);

    const seeded = defaultSlotRoutes("ws_pad_b");
    const fast = seeded.find((r) => r.taskName === "fast_customer_reply");
    assert(fast?.provider === "deepseek", `CASE B: seeded routes carry the real provider, got ${fast?.provider}`);
    assert((fast?.config as { enableMockFallback?: boolean } | undefined)?.enableMockFallback === false,
      "CASE B: seeded real route carries enableMockFallback:false");

    console.log(`CASE B PASS - with PLATFORM_DEEPSEEK_API_KEY ${keyShape("PLATFORM_DEEPSEEK_API_KEY")}, whatsapp_reply routes to deepseek/deepseek-chat and mock fallback is OFF`);
  }

  // --- CASE C: every declared model really exists in the catalog -------------
  {
    const table = platformSlotModelTable();
    let checked = 0;
    for (const [provider, slots] of Object.entries(table)) {
      for (const [slotId, model] of Object.entries(slots)) {
        const found = findModel(provider as never, model.modelName);
        assert(found, `CASE C: ${provider}/${slotId} names "${model.modelName}", which is NOT in DEFAULT_MODEL_CATALOG`);
        assert(found.tier === model.modelTier,
          `CASE C: ${provider}/${slotId} declares tier "${model.modelTier}" but the catalog says "${found.tier}"`);
        assert(found.provider === provider, `CASE C: ${model.modelName} belongs to ${found.provider}, not ${provider}`);
        checked += 1;
      }
    }
    assert(checked >= 24, `CASE C: expected at least 24 platform model entries to check, found ${checked}`);
    console.log(`CASE C PASS - all ${checked} platform default models exist in the catalog at the declared tier`);
  }

  // --- CASE D: provider choice is deterministic -----------------------------
  {
    clearEnv();
    process.env.PLATFORM_OPENAI_API_KEY = "sk-golden-openai";
    process.env.PLATFORM_DEEPSEEK_API_KEY = "sk-golden-deepseek";
    assert(resolvePlatformDefaultProvider() === "deepseek",
      `CASE D: with both keys, preference order picks deepseek (the only provider measured end to end), got ${resolvePlatformDefaultProvider()}`);

    process.env.PLATFORM_DEFAULT_PROVIDER = "openai";
    assert(resolvePlatformDefaultProvider() === "openai", `CASE D: an explicit pin wins, got ${resolvePlatformDefaultProvider()}`);
    assert(platformSlotDefaults().embedding_advanced.provider === "openai",
      "CASE D: openai HAS an embedding model, so that slot is real for openai");
    assert(platformSlotDefaults().embedding_advanced.modelName === "text-embedding-3-small",
      `CASE D: got ${platformSlotDefaults().embedding_advanced.modelName}`);

    delete process.env.PLATFORM_OPENAI_API_KEY;
    assert(resolvePlatformDefaultProvider() === "deepseek",
      "CASE D: a pin with no key behind it must be ignored, not honoured into a guaranteed 401");

    process.env.PLATFORM_DEFAULT_PROVIDER = "not_a_provider";
    assert(resolvePlatformDefaultProvider() === "deepseek", "CASE D: an unknown pin is ignored");
    console.log("CASE D PASS - preference order, explicit pin, keyless pin and unknown pin all resolve deterministically");
  }

  // --- CASE E: a blank key is not a key -------------------------------------
  {
    clearEnv();
    process.env.PLATFORM_DEEPSEEK_API_KEY = "   ";
    assert(platformApiKey("deepseek") === undefined, "CASE E: a whitespace-only key must read as absent");
    assert(resolvePlatformDefaultProvider() === undefined, "CASE E: a whitespace-only key must not become the default provider");
    process.env.PLATFORM_DEEPSEEK_API_KEY = "";
    assert(platformApiKey("deepseek") === undefined, "CASE E: an empty key must read as absent");
    assert(platformSlotDefaults().fast_customer_reply.provider === "mock", "CASE E: falls back to mock, not to a broken real provider");
    console.log("CASE E PASS - blank and whitespace-only keys read as no key at all");
  }

  // --- CASE F: a saved slot row still wins (UA-7 contract) -------------------
  {
    clearEnv();
    process.env.PLATFORM_DEEPSEEK_API_KEY = "sk-golden-deepseek";
    const savedRow = {
      id: "llm_slot_1",
      workspaceId: "ws_pad_f",
      taskName: "fast_customer_reply",
      provider: "openai",
      modelName: "gpt-4o",
      modelTier: "balanced",
      isEnabled: true,
      fallbackProvider: "mock",
      fallbackModelName: "mock-fast",
      config: { enableMockFallback: true },
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    } as unknown as LLMModelRouting;

    const route = routeModelSelection("whatsapp_reply", [savedRow]);
    assert(route.provider === "openai" && route.modelName === "gpt-4o",
      `CASE F: what the AI Settings screen shows must be what runs, got ${route.provider}/${route.modelName}`);
    assert(route.routeSource === "slot_setting", `CASE F: routeSource slot_setting, got ${route.routeSource}`);
    assert(route.enableMockFallback === true,
      "CASE F: an explicitly saved enableMockFallback:true is the operator's choice and must be honoured");

    // A disabled row falls through to the platform default, not to mock.
    const disabled = { ...savedRow, isEnabled: false } as LLMModelRouting;
    const fell = routeModelSelection("whatsapp_reply", [disabled]);
    assert(fell.provider === "deepseek", `CASE F: a disabled row falls through to the platform default, got ${fell.provider}`);
    console.log("CASE F PASS - a saved slot row overrides the platform default; a disabled row falls through to it");
  }

  // --- CASE G: the UNPREFIXED name is read too --------------------------------
  //
  // WHY. The demo deployment was given a DeepSeek key named `DEEPSEEK_API_KEY`
  // — the name DeepSeek's own documentation uses. Nothing read it. Every call
  // fell back to canned text and AI Settings said "No API key is set for this
  // model", which reads exactly like a revoked key: the operator had done the
  // work, paid for the key, and had no way to see that only the NAME was wrong.
  // The SerpApi lookup had accepted both spellings since it was written, so on
  // the same service, saved in the same sitting, the search key worked and the
  // model key did not.
  {
    clearEnv();
    process.env.DEEPSEEK_API_KEY = "sk-golden-unprefixed-not-a-real-key";
    assert(
      platformApiKey("deepseek") === "sk-golden-unprefixed-not-a-real-key",
      `CASE G: an unprefixed DEEPSEEK_API_KEY must be found, got ${keyShape("DEEPSEEK_API_KEY")}`,
    );
    assert(
      resolvePlatformDefaultProvider() === "deepseek",
      "CASE G: a workspace with only the unprefixed key must still run on the real provider",
    );

    // A blank PLATFORM_* must not shadow a real unprefixed key. An operator who
    // left the prefixed line empty in a file and put the key in the other one
    // has configured a working key.
    process.env.PLATFORM_DEEPSEEK_API_KEY = "   ";
    assert(
      platformApiKey("deepseek") === "sk-golden-unprefixed-not-a-real-key",
      "CASE G: a blank prefixed key must not hide the unprefixed one",
    );

    // When both are really set the prefixed one wins: it is the deliberate
    // platform-level choice, and it is the name this product documents.
    process.env.PLATFORM_DEEPSEEK_API_KEY = "sk-golden-prefixed-not-a-real-key";
    assert(
      platformApiKey("deepseek") === "sk-golden-prefixed-not-a-real-key",
      "CASE G: PLATFORM_DEEPSEEK_API_KEY must win when both names are set",
    );

    // And absence still means absence, on both names.
    clearEnv();
    assert(platformApiKey("deepseek") === undefined, "CASE G: neither name set means no key");
    console.log("CASE G PASS - the unprefixed provider key is read, the prefixed one wins, absence is still absence");
  }

  for (const name of OWNED_ENV) {
    if (SAVED[name] === undefined) delete process.env[name];
    else process.env[name] = SAVED[name];
  }
  console.log("\nAll platform-AI-default golden cases PASSED (A-G).");
}

try {
  main();
} catch (err) {
  for (const name of OWNED_ENV) {
    if (SAVED[name] === undefined) delete process.env[name];
    else process.env[name] = SAVED[name];
  }
  console.error("\nGOLDEN FAILED:", err);
  process.exit(1);
}
