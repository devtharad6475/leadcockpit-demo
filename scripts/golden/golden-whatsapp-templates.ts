/**
 * golden-whatsapp-templates.ts — pins CP-25 (WhatsApp message templates CRUD).
 *
 * CONTRACTS:
 *   T1: create → stored with status "draft".
 *   T2: listByWorkspace → returns the created template.
 *   T3: update body → persists.
 *   T4: getById → returns the template.
 *   T5: deleteById → gone.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";
import assert from "node:assert";

const ws = `ws_watpl_${Date.now()}`;
type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

test("T1 — create a template → status 'draft'", async () => {
  const repos = createJsonRepos();
  const tpl = await repos.whatsAppTemplate.create(ws, { name: "order_update_en", body: "Hi {{1}}, your order {{2}} is ready.", language: "en_US", category: "UTILITY" });
  assert.strictEqual(tpl.status, "draft", "new template must be 'draft'");
  assert.strictEqual(tpl.name, "order_update_en");
  assert.ok(tpl.body.includes("{{1}}"), "body must preserve variable placeholders");
});

test("T2 — listByWorkspace → returns the template", async () => {
  const repos = createJsonRepos();
  await repos.whatsAppTemplate.create(ws, { name: "welcome_en", body: "Welcome {{1}}!", language: "en_US" });
  const list = await repos.whatsAppTemplate.listByWorkspace(ws);
  assert.ok(list.length >= 1, "list must include the template");
  assert.ok(list.some((t) => t.name === "welcome_en"), "must find 'welcome_en'");
});

test("T3 — update body → persists", async () => {
  const repos = createJsonRepos();
  const created = await repos.whatsAppTemplate.create(ws, { name: "price_en", body: "Price is {{1}}", language: "en_US" });
  const updated = await repos.whatsAppTemplate.update(ws, created.id, { body: "The price for {{1}} is {{2}} per metre.", status: "approved" });
  assert.strictEqual(updated.body, "The price for {{1}} is {{2}} per metre.");
  assert.strictEqual(updated.status, "approved");
});

test("T4 — getById → returns the template", async () => {
  const repos = createJsonRepos();
  const created = await repos.whatsAppTemplate.create(ws, { name: "delivery_en", body: "Delivery in {{1}} days.", language: "en_US" });
  const found = await repos.whatsAppTemplate.getById(ws, created.id);
  assert.ok(found, "must find by id");
  assert.strictEqual(found!.name, "delivery_en");
});

test("T5 — deleteById → template gone", async () => {
  const repos = createJsonRepos();
  const created = await repos.whatsAppTemplate.create(ws, { name: "temp_delete", body: "temp", language: "en_US" });
  await repos.whatsAppTemplate.deleteById(ws, created.id);
  const found = await repos.whatsAppTemplate.getById(ws, created.id);
  assert.strictEqual(found, undefined, "template must be gone after delete");
});

(async () => {
  let passed = 0, failed = 0;
  for (const c of cases) {
    try { await c.fn(); passed++; console.log(`  ✅ ${c.name}`); }
    catch (err) { failed++; console.error(`  ❌ ${c.name}: ${(err as Error).message}`); }
  }
  console.log(`\nwhatsapp-templates: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAILED ❌"}`);
  process.exit(failed > 0 ? 1 : 0);
})();
