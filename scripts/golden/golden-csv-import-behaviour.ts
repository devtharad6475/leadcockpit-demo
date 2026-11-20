/**
 * golden-csv-import-behaviour.ts — the owner's own list of leads, imported by
 * actually importing it (2026-09-24).
 *
 * Until now the CSV import was checked only by reading its source text
 * (golden-a-real-list-can-be-brought-in), so a rule could be present in the
 * code and still not work. These cases run real files through
 * `importLeadsFromCsv` against a real store.
 *
 *   CASE A — a clean file: every row becomes a lead, trimmed, with the phone
 *            number also on whatsappNumber (inbound is matched on it).
 *   CASE B — rows that name no company and no website are skipped and counted.
 *   CASE C — re-importing the same file creates nothing; a corrected website
 *            in a different case or with "www." is still the same company.
 *   CASE D — someone on the permanent do-not-contact register is not brought
 *            back, whether matched by phone, e-mail, or a separate phone column.
 *   CASE E — an explicit whatsapp column wins over the phone column.
 *   CASE F — a file over the row limit is refused whole: nothing is written.
 *   CASE G — the same company twice inside one file is imported once.
 *   CASE H — headers typed the way people type them ("Company Name",
 *     "E-mail", "Phone Number", "WhatsApp") are read (2026-09-26: such a file
 *     imported nothing and called every row empty).
 *
 * Run: npx tsx scripts/golden/golden-csv-import-behaviour.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { importLeadsFromCsv, MAX_CSV_ROWS, type CsvImportResult } from "@/services/LeadImportService";
import { registerDoNotContact } from "@/lib/dnc-registry";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

const repos = createJsonRepos();
let n = 0;
const freshWs = () => `ws_csv_${Date.now()}_${(n += 1)}`;
const run = async (ws: string, csv: string) => {
  const result = await importLeadsFromCsv(ws, csv, {}, repos);
  assert.ok(!("refused" in result), "a normal file must not be refused");
  return result as CsvImportResult;
};

const CLEAN = [
  "company_name,website,phone,email,city",
  "  Shree Laces  ,https://shreelaces.in, +91 98250 11111 ,orders@shreelaces.in,Surat",
  "Om Trims,,+91 98250 22222,,Mumbai",
].join("\n");

test("CASE A — a clean file: every row becomes a lead, and phones reach WhatsApp matching", async () => {
  const ws = freshWs();
  const result = await run(ws, CLEAN);
  assert.strictEqual(result.created, 2);
  const leads = await repos.lead.listLeads(ws);
  const shree = leads.find((lead) => lead.companyName === "Shree Laces");
  assert.ok(shree, "names are trimmed");
  assert.strictEqual(shree?.whatsappNumber, "+91 98250 11111");
  assert.strictEqual(shree?.phone, "+91 98250 11111");
  assert.strictEqual(shree?.doNotContact, false);
  assert.strictEqual(shree?.status, "needs_review", "an imported lead waits for review");
});

test("CASE B — rows naming no company and no website are skipped and counted", async () => {
  const ws = freshWs();
  const result = await run(ws, ["company_name,website,city", "Real Co,,Pune", ",,Surat", "  ,  ,"].join("\n"));
  assert.strictEqual(result.created, 1);
  assert.strictEqual(result.emptyRowsSkipped, 2);
});

test("CASE C — importing the same list again creates nothing", async () => {
  const ws = freshWs();
  await run(ws, CLEAN);
  const again = await run(ws, CLEAN.replace("https://shreelaces.in", "WWW.ShreeLaces.in/"));
  assert.strictEqual(again.created, 0);
  assert.strictEqual(again.duplicatesSkipped, 2);
  assert.strictEqual((await repos.lead.listLeads(ws)).length, 2);
});

test("CASE D — people who opted out are not brought back", async () => {
  const ws = freshWs();
  await registerDoNotContact(ws, { phone: "+91 98250 33333", reason: "asked to stop" }, repos);
  await registerDoNotContact(ws, { email: "no@stopme.in", reason: "asked to stop" }, repos);
  await registerDoNotContact(ws, { phone: "9825044444", reason: "asked to stop" }, repos);
  const result = await run(ws, [
    "company_name,phone,whatsapp,email",
    "By Phone Co,98250 33333,,",
    "By Email Co,,,NO@stopme.in",
    "By Second Number Co,+91 98250 44444,+91 98250 55555,",
    "Still Welcome Co,+91 98250 66666,,",
  ].join("\n"));
  assert.strictEqual(result.doNotContactSkipped, 3);
  assert.strictEqual(result.created, 1);
  assert.deepStrictEqual((await repos.lead.listLeads(ws)).map((lead) => lead.companyName), ["Still Welcome Co"]);
});

test("CASE E — an explicit WhatsApp column wins over the phone column", async () => {
  const ws = freshWs();
  await run(ws, ["company_name,phone,whatsapp", "Two Numbers Co,+91 22 4000 0000,+91 98250 77777"].join("\n"));
  const [lead] = await repos.lead.listLeads(ws);
  assert.strictEqual(lead.whatsappNumber, "+91 98250 77777");
  assert.strictEqual(lead.phone, "+91 22 4000 0000");
});

test("CASE F — a file over the row limit is refused whole", async () => {
  const ws = freshWs();
  const rows = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `Company ${i}`);
  const result = await importLeadsFromCsv(ws, ["company_name", ...rows].join("\n"), {}, repos);
  assert.ok("refused" in result && result.code === "CSV_TOO_MANY_ROWS");
  assert.strictEqual((await repos.lead.listLeads(ws)).length, 0, "nothing half-imported");
});

test("CASE G — the same company twice in one file is imported once", async () => {
  const ws = freshWs();
  const result = await run(ws, ["company_name,city", "Twin Co,Surat", "twin  co,Surat"].join("\n"));
  assert.strictEqual(result.created, 1);
  assert.strictEqual(result.duplicatesSkipped, 1);
});

test("CASE H — headers are read however they are spelled", async () => {
  const ws = freshWs();
  const result = await run(ws, ["Company Name , E-mail,Phone Number,WhatsApp,City", "Header Co,h@csv.example,+91 00000 00071,+91 00000 00072,Surat"].join("\n"));
  assert.strictEqual(result.created, 1, `created ${result.created}; empty rows ${result.emptyRowsSkipped}`);
  const lead = result.leads[0];
  assert.strictEqual(lead.companyName, "Header Co");
  assert.strictEqual(lead.email, "h@csv.example");
  assert.strictEqual(lead.whatsappNumber, "+91 00000 00072", "the WhatsApp column was not read");
});

(async () => {
  console.log("\n=== GOLDEN: a CSV list imports correctly when actually imported ===\n");
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
    console.log("❌ GOLDEN FAILED: csv-import-behaviour");
    process.exit(1);
  }
})();
