/**
 * golden-product-research-reachable.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * The dashboard tells the operator what to do next, and one of the things it
 * tells them is:
 *
 *   "Analyze product applications and buyer segments to improve targeting."
 *
 * That step is served by exactly one endpoint, POST /api/product-research/
 * generate. On the live deployment it was unreachable twice over:
 *
 *   1. Nothing called it. No button in the app, no script, no test — a full
 *      grep of the repository found the route definition and nothing else.
 *   2. Had anything called it, it would have returned 400. It gated on
 *      `profile.products`, and the Profile screen says in as many words that
 *      "products, customers and selling points ... moved to the Knowledge
 *      Base". Nothing writes that field any more, so the gate rejected every
 *      workspace in existence, with a message telling the operator to add
 *      products to a form that no longer has that field.
 *
 * So the product asked for a step it did not offer, and would have refused it
 * on the grounds of a field it had itself removed.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — the endpoint has a caller in the UI. This is the half that no
 *   behavioural test can see: the service worked fine, and nobody could run it.
 *
 *   CASE B — the recommended-next-action string and the button that satisfies
 *   it both exist. A next-step the product recommends must be a step it offers.
 *
 *   CASE C — the research service works from product NAMES, whatever their
 *   source, and produces buyer segments and market maps for them.
 *
 *   CASE D — a workspace with no products anywhere still refuses, and says
 *   where to add them. Inventing buyer segments for products that do not exist
 *   is worse than the 400.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { runProductApplicationResearch } from "@/services/ProductApplicationResearchService";
import { createJsonRepos } from "./_helpers/provider";
import { readSource } from "./_helpers/read-source";
import type { BusinessProfile } from "@/lib/types";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

const ENDPOINT = "/api/product-research/generate";

test("CASE A — the endpoint has a caller in the UI", async () => {
  const uiFiles = [
    "src/app/page.tsx",
    "src/app/sections/StructuredSettings.tsx",
    "src/app/sections/QuestionsFromAI.tsx",
  ];
  const callers = uiFiles.filter((file) => readSource(file).includes(ENDPOINT));
  assert.ok(
    callers.length > 0,
    `${ENDPOINT} is defined in the API and called from nowhere — an endpoint with no caller is a feature the operator cannot run`,
  );
});

test("CASE B — the step the dashboard recommends is a step the product offers", async () => {
  const route = readSource("src/app/api/[[...path]]/route.ts");
  assert.ok(
    route.includes("Analyze product applications and buyer segments to improve targeting."),
    "the recommended-next-action string moved — this golden's source parse needs updating",
  );
  const page = readSource("src/app/page.tsx");
  assert.ok(
    page.includes(ENDPOINT),
    "the dashboard recommends this step, so the app must contain a control that performs it",
  );
});

test("CASE C — research runs from product names and produces targeting rows", async () => {
  const repos = createJsonRepos();
  const WS = `ws_golden_prodresearch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const profile = {
    id: "profile_golden_research",
    workspaceId: WS,
    companyName: "TechNova Solutions",
    industry: "Enterprise software solutions",
    businessType: "Service provider",
    // The names the operator's Settings → Products catalogue holds. The route
    // supplies these when profile.products is empty, which it always is now.
    products: ["Cloud ERP System", "AI CRM"],
    desiredCustomerTypes: ["Wholesale buyers", "Manufacturers", "Export buyers"],
    status: "draft",
  } as unknown as BusinessProfile;

  const result = await runProductApplicationResearch(profile, repos);
  assert.strictEqual(result.products.length, 2, `both catalogue products are researched, got ${result.products.length}`);
  assert.ok(result.buyerSegments.length > 0, "targeting advice needs buyer segments");
  assert.ok(result.marketMaps.length > 0, "and the map that ties segments to products");

  const stored = await repos.productKnowledge.listByWorkspace(WS);
  assert.strictEqual(stored.length, 2, "the run persists what it found, so the next screen can read it");
});

test("CASE D — no products anywhere still refuses, and says where to add them", async () => {
  const repos = createJsonRepos();
  const WS = `ws_golden_prodresearch_empty_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const profile = {
    id: "profile_golden_research_empty",
    workspaceId: WS,
    companyName: "TechNova Solutions",
    products: [],
    status: "draft",
  } as unknown as BusinessProfile;

  const result = await runProductApplicationResearch(profile, repos);
  assert.strictEqual(result.products.length, 0, "no products in, no products invented");
  assert.strictEqual(result.buyerSegments.length, 0, "and no buyer segments for products that do not exist");

  const route = readSource("src/app/api/[[...path]]/route.ts");
  assert.ok(
    route.includes("on the Catalogue page (Add your products)"),
    "the refusal must name the screen that actually holds the catalogue — the old message pointed at a form field that no longer exists",
  );
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  console.log("golden-product-research-reachable — N-BUG (a step the dashboard recommends must be a step the operator can run)\n");
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
  console.log("");
  console.log(`product-research-reachable: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
