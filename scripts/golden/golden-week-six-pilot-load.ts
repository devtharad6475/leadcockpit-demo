/** Bounded pilot contention proof, not a hosted throughput benchmark.
 * Expected independently: 2 companies × 50 customers; 10 quotes/company;
 * 5 simultaneous conversion retries/quote => exactly 20 linked orders, not 100.
 * Fractional quantity 1.5 × price 12.345 => saved INR total 18.52/order.
 * No AI, search, mail or customer send is called. All data is disposable.
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts scripts/golden/golden-week-six-pilot-load.ts
 */
import "./_helpers/isolate-standalone";
import "./_helpers/no-platform-ai-keys";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRepositories } from "@/repositories";
import { convertPersistedQuoteToOrder } from "@/services/QuoteConversionService";

const companies = ["week_six_pilot_a", "week_six_pilot_b"];
const customerId = (company: string, index: number) => `${company}_customer_${index}`;
const repos = createRepositories("json");

async function verifySaved() {
  for (const company of companies) {
    const other = companies.find(id => id !== company)!;
    const customers = await repos.lead.listLeads(company);
    assert.equal(customers.length, 50);
    assert.equal(new Set(customers.map(row => row.id)).size, 50);
    for (let index = 0; index < 50; index++) {
      const row = await repos.lead.getLeadById(company, customerId(company, index));
      assert.equal(row?.companyName, `Synthetic buyer ${index}`);
      assert.equal(row?.city, `Updated city ${index}`);
      assert.equal(row?.status, "contacted");
      assert.equal(await repos.lead.getLeadById(other, customerId(company, index)), undefined);
    }
    assert.equal((await repos.lead.listLeadPhoneNumbers(company, customerId(company, 0))).length, 1);
    assert.equal((await repos.lead.findLeadByPhone(company, "+91 90000 00000"))?.id, customerId(company, 0));
    const quotes = await repos.quote.listByWorkspace(company);
    const orders = await repos.order.listByWorkspace(company);
    assert.equal(quotes.length, 10);
    assert.equal(orders.length, 10);
    assert.equal(new Set(quotes.map(row => row.quoteNumber)).size, 10);
    assert.equal(new Set(orders.map(row => row.orderNumber)).size, 10);
    for (const quote of quotes) {
      assert.equal(quote.status, "converted");
      const order = orders.find(row => row.id === quote.orderId);
      assert.ok(order);
      assert.equal(order.quoteId, quote.id);
      assert.equal(order.leadId, quote.leadId);
      assert.equal(order.grandTotal, 18.52);
      assert.equal(order.lineItems[0].quantity, 1.5);
      assert.equal(order.lineItems[0].unitPrice, 12.345);
      assert.equal(await repos.order.getById(other, order.id), undefined);
      assert.equal(await repos.quote.getById(other, quote.id), undefined);
    }
  }
}

async function main() {
  assert.equal(process.env.PERSISTENCE_PROVIDER, "json", "Run with the force-json-provider preload");
  assert.ok(process.env.LEADGEN_DATA_DIR?.includes("golden"), "Disposable golden scratch directory required");
  if (process.argv.includes("--verify-saved")) {
    await verifySaved();
    console.log("PASS new process reads exact company-scoped customers, quote/order links and values");
    return;
  }
  const start = performance.now();
  const now = new Date().toISOString();
  await Promise.all(companies.map(id => repos.workspace.create({ id, name: `Synthetic pilot ${id}`, industry: "Testing", createdAt: now, updatedAt: now })));
  await Promise.all(companies.flatMap(workspaceId => Array.from({ length: 50 }, (_, index) => repos.lead.createLead({
    id: customerId(workspaceId, index), workspaceId, companyName: `Synthetic buyer ${index}`, status: "discovered", source: "manual",
  }))));
  await Promise.all(companies.flatMap(workspaceId => Array.from({ length: 50 }, (_, index) => repos.lead.updateLead(workspaceId, customerId(workspaceId, index), {
    city: `Updated city ${index}`, status: "contacted",
  }))));
  console.log("PASS 100 concurrent customer creates and 100 updates retain every intended value");
  await Promise.all(companies.flatMap(workspaceId => Array.from({ length: 20 }, (_, index) => repos.lead.addLeadPhoneNumber(workspaceId, customerId(workspaceId, 0), {
    number: index % 2 ? "+91 90000 00000" : "919000000000", type: "whatsapp", isPrimary: true,
  }))));
  console.log("PASS 40 duplicate phone requests retain one normalized number per company");
  const quotes = await Promise.all(companies.flatMap(workspaceId => Array.from({ length: 10 }, (_, index) => repos.quote.createWithNextQuoteNumber({
    workspaceId, leadId: customerId(workspaceId, index), status: "sent", currencyCode: "INR", grandTotal: 18.52,
    lineItems: [{ id: `${workspaceId}_line_${index}`, productName: "Measured synthetic item", quantity: 1.5, unit: "kg", unitPrice: 12.345, lineTotal: 18.52, currencyCode: "INR" }],
  }))));
  await Promise.all(quotes.map(async quote => {
    const results = await Promise.all(Array.from({ length: 5 }, () => convertPersistedQuoteToOrder(quote.workspaceId, quote.id, undefined, repos)));
    assert.ok(results.every(row => row?.order.id === results[0]?.order.id));
    assert.equal(results.filter(row => row?.alreadyConverted === false).length, 1);
    const other = companies.find(id => id !== quote.workspaceId)!;
    assert.equal(await convertPersistedQuoteToOrder(other, quote.id, undefined, repos), undefined);
  }));
  await verifySaved();
  console.log("PASS 100 conversion requests create exactly 20 orders with unique numbers and exact saved prices");
  const child = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/golden/golden-week-six-pilot-load.ts"), "--verify-saved"], {
    env: { ...process.env }, encoding: "utf8", timeout: 60_000,
  });
  assert.equal(child.status, 0, `${child.error?.message || ""}\n${child.stdout}\n${child.stderr}`);
  console.log(child.stdout.trim());
  console.log(`PASS golden-week-six-pilot-load: bounded synthetic JSON workload (${Math.round(performance.now() - start)}ms observed; not a capacity promise)`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
