/**
 * golden-ai-credential-cleanup.ts — removing a saved AI key is safe
 * (2026-09-24).
 *
 *   CASE A — the listing says which slots use each key, and never returns a key.
 *   CASE B — a key no slot uses is removed.
 *   CASE C — a key a slot uses is refused, and the refusal names the slot.
 *   CASE D — an integration key (web search, e-mail) is never touched here.
 *
 * Run: npx tsx scripts/golden/golden-ai-credential-cleanup.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { listAICredentials, removeUnusedAICredential } from "@/services/AICredentialCleanupService";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
let n = 0;
const freshWs = () => `ws_aicred_${Date.now()}_${(n += 1)}`;

async function setUp() {
  const ws = freshWs();
  const stale = await repos.llmProviderCredential.create(ws, { provider: "deepseek", status: "not_connected", encryptedApiKey: "enc:stale", config: { demoOnly: true } });
  const used = await repos.llmProviderCredential.create(ws, { provider: "openai", status: "connected", encryptedApiKey: "enc:used", config: {} });
  const search = await repos.llmProviderCredential.create(ws, { provider: "serpapi", status: "connected", encryptedApiKey: "enc:search", config: {} });
  await repos.llmModelRouting.replaceForWorkspace(ws, [
    { taskName: "daily_workhorse", provider: "openai", modelTier: "standard", isEnabled: true, config: { credentialId: used.id } },
    { taskName: "deep_reasoning", provider: "deepseek", modelTier: "reasoning", isEnabled: true, config: {} },
  ]);
  return { ws, stale, used, search };
}

test("CASE A — the listing shows use, never the key", async () => {
  const { ws, stale, used, search } = await setUp();
  const list = await listAICredentials(ws, repos);
  assert.deepStrictEqual(list.map((c) => c.id).sort(), [stale.id, used.id].sort(), "integration keys are not listed here");
  assert.deepStrictEqual(list.find((c) => c.id === used.id)?.usedBy, ["daily_workhorse"]);
  assert.deepStrictEqual(list.find((c) => c.id === stale.id)?.usedBy, []);
  assert.strictEqual(list.find((c) => c.id === stale.id)?.demoOnly, true);
  assert.ok(!JSON.stringify(list).includes("enc:"), "no key material in the listing");
  assert.ok(!list.some((c) => c.id === search.id));
});

test("CASE B — an unused key is removed", async () => {
  const { ws, stale } = await setUp();
  assert.deepStrictEqual(await removeUnusedAICredential(ws, stale.id, repos), { removed: true });
  assert.ok(!(await repos.llmProviderCredential.listByWorkspace(ws)).some((c) => c.id === stale.id));
});

test("CASE C — a key in use is refused, naming the slot", async () => {
  const { ws, used } = await setUp();
  const result = await removeUnusedAICredential(ws, used.id, repos);
  assert.strictEqual(result.removed, false);
  assert.match((result as { reason: string }).reason, /daily_workhorse/);
  assert.ok((await repos.llmProviderCredential.listByWorkspace(ws)).some((c) => c.id === used.id));
});

test("CASE D — an integration key is never removed here", async () => {
  const { ws, search } = await setUp();
  const result = await removeUnusedAICredential(ws, search.id, repos);
  assert.strictEqual(result.removed, false);
  assert.match((result as { reason: string }).reason, /integration/);
  assert.ok((await repos.llmProviderCredential.listByWorkspace(ws)).some((c) => c.id === search.id));
});

(async () => {
  console.log("\n=== GOLDEN: removing a saved AI key is safe ===\n");
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (error) {
      fail += 1;
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: ai-credential-cleanup");
    process.exit(1);
  }
})();
