/**
 * golden-llm-cost-accuracy.ts — the bill reflects what the provider charges
 * (2026-09-18, session 57).
 *
 * ── THE DEFECT, FOUND BY MEASUREMENT ────────────────────────────────────────
 * Every token was priced at one flat rate per provider. Real providers charge
 * three: fresh input, input served from their own prompt cache, and output. On
 * deepseek-flash the cache rate is FIFTY times lower than fresh input
 * ($0.006 vs $0.30 per 1M, checked 2026-09-18).
 *
 * That gap became load-bearing when document extraction started sending the
 * whole document to all 25 question groups: nearly all of that input is a cache
 * hit. A measured extraction recorded $0.70 of spend against a real cost near
 * $0.10 — and the inflated number is what pushed the workspace over its daily
 * cap, so 7 of the 25 groups (including every pricing question) were refused.
 * An over-charge is not a safe error: it stops work that was affordable.
 *
 *   CASE A — cached input is charged at the cache rate, not the input rate.
 *   CASE B — output is charged at the output rate (4x input on deepseek).
 *   CASE C — cached tokens are part of promptTokens, never added on top.
 *   CASE D — an unknown provider keeps the flat rate: nothing becomes free by
 *            being unlisted, and the mock provider still costs nothing.
 *   CASE E — the provider's token COUNT is still recorded in full: the caps are
 *            about tokens as well as dollars, and cheap tokens are still tokens.
 *   CASE F — the OpenAI and DeepSeek spellings of "cached tokens" are both read.
 *
 * Run: npx tsx scripts/golden/golden-llm-cost-accuracy.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { resolveUsage } from "@/llm/LLMService";
import { DeepSeekProvider } from "@/llm/providers/OpenAICompatibleProvider";

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((error) => {
      fail += 1;
      console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
    });
}

// deepseek-flash, peak rates, per 1,000 tokens.
const INPUT = 0.0003;
const CACHED = 0.000006;
const OUTPUT = 0.0012;
const near = (actual: number, expected: number, what: string) =>
  assert.ok(Math.abs(actual - expected) < expected * 0.001 + 1e-9, `${what}: expected ~${expected}, got ${actual}`);

async function main() {
  console.log("\n=== GOLDEN: the bill matches the price list ===\n");

  await check("CASE A — cached input is charged at the cache rate", () => {
    const allFresh = resolveUsage("deepseek", { promptTokens: 100_000, completionTokens: 0, totalTokens: 100_000 }, "");
    near(allFresh.cost, 100 * INPUT, "100k fresh input tokens");

    const allCached = resolveUsage(
      "deepseek",
      { promptTokens: 100_000, cachedPromptTokens: 100_000, completionTokens: 0, totalTokens: 100_000 },
      "",
    );
    near(allCached.cost, 100 * CACHED, "100k cached input tokens");
    assert.ok(
      allCached.cost < allFresh.cost / 10,
      "THE POINT: re-sending the same document must cost a small fraction of sending it the first time. " +
        `Fresh ${allFresh.cost}, cached ${allCached.cost}`,
    );
  });

  await check("CASE B — output is charged at the output rate", () => {
    const out = resolveUsage("deepseek", { promptTokens: 0, completionTokens: 10_000, totalTokens: 10_000 }, "");
    near(out.cost, 10 * OUTPUT, "10k output tokens");
    const inp = resolveUsage("deepseek", { promptTokens: 10_000, completionTokens: 0, totalTokens: 10_000 }, "");
    assert.ok(out.cost > inp.cost, "output is dearer than input on this provider; pricing them alike under-bills long answers");
  });

  await check("CASE C — cached tokens are part of the prompt, not extra", () => {
    const mixed = resolveUsage(
      "deepseek",
      { promptTokens: 50_000, cachedPromptTokens: 40_000, completionTokens: 2_000, totalTokens: 52_000 },
      "",
    );
    near(mixed.cost, 10 * INPUT + 40 * CACHED + 2 * OUTPUT, "10k fresh + 40k cached + 2k output");

    // A provider that reports more cached than prompt tokens must not produce a
    // negative fresh count (which would make the call cost LESS than nothing).
    const absurd = resolveUsage(
      "deepseek",
      { promptTokens: 1_000, cachedPromptTokens: 9_000, completionTokens: 0, totalTokens: 1_000 },
      "",
    );
    assert.ok(absurd.cost >= 0, `cost must never go negative, got ${absurd.cost}`);
    near(absurd.cost, 1 * CACHED, "cached is clamped to the prompt size");
  });

  await check("CASE D — unknown providers keep the flat rate; mock stays free", () => {
    const unknown = resolveUsage("some_new_provider", { promptTokens: 1_000, completionTokens: 0, totalTokens: 1_000 }, "");
    assert.ok(unknown.cost > 0, "an unlisted provider must NOT become free — that is spend nobody sees");
    near(unknown.cost, 0.002, "the flat fallback rate");

    const mock = resolveUsage("mock", { promptTokens: 999_999, completionTokens: 999_999, totalTokens: 1_999_998 }, "");
    assert.deepStrictEqual(mock, { tokens: 0, cost: 0 }, "the mock provider bills nothing and consumes no quota");
  });

  await check("CASE E — the token count is still recorded in full", () => {
    const cheap = resolveUsage(
      "deepseek",
      { promptTokens: 100_000, cachedPromptTokens: 100_000, completionTokens: 0, totalTokens: 100_000 },
      "",
    );
    assert.strictEqual(
      cheap.tokens,
      100_000,
      "cheap tokens are still tokens: discounting the COUNT would let a workspace sail past a token cap " +
        "that exists to bound volume, not only money",
    );
  });

  await check("CASE F — both providers' spellings of 'cached' are read", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    const reply = (usage: Record<string, unknown>) =>
      Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage });
    try {
      // DeepSeek's spelling.
      globalThis.fetch = (async () =>
        reply({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_cache_hit_tokens: 900 })) as typeof fetch;
      const deepseek = new DeepSeekProvider({ apiKey: "golden-key-not-real" });
      const a = await deepseek.runJsonTask({ taskName: "document_extraction_mapping", modelTier: "balanced", prompt: "p", input: {} });
      seen.push({ ...a.usage });
      assert.strictEqual(a.usage?.cachedPromptTokens, 900, "DeepSeek reports prompt_cache_hit_tokens");

      // OpenAI's spelling, through the same compatible provider.
      globalThis.fetch = (async () =>
        reply({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 700 } })) as typeof fetch;
      const b = await deepseek.runJsonTask({ taskName: "document_extraction_mapping", modelTier: "balanced", prompt: "p", input: {} });
      assert.strictEqual(b.usage?.cachedPromptTokens, 700, "OpenAI reports prompt_tokens_details.cached_tokens");

      // No cache block at all: undefined, and everything prices as fresh input.
      globalThis.fetch = (async () => reply({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 })) as typeof fetch;
      const c = await deepseek.runJsonTask({ taskName: "document_extraction_mapping", modelTier: "balanced", prompt: "p", input: {} });
      assert.strictEqual(c.usage?.cachedPromptTokens, undefined, "a missing cache block must not be read as a cache hit");
      near(resolveUsage("deepseek", c.usage!, "").cost, 1 * INPUT + 0.01 * OUTPUT, "no cache reported → all input is fresh");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: llm-cost-accuracy");
    process.exit(1);
  }
}

main();
