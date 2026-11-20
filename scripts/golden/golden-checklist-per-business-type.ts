/**
 * golden-checklist-per-business-type.ts — N13 acceptance condition 3 (2026-09-25).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Every business was asked the same 424 questions. The bank asked for the
 * business type and industry and then ignored both (audit Q-2): a consultancy
 * was asked about MOQ, pallets and dispatch; a domestic seller about export
 * paperwork. The CEO's condition for retiring the 424: different businesses
 * get materially different checklists, and none is asked a question that
 * cannot apply to it.
 *
 * HAND-COMPUTED CONTRACT
 *   CASE A — each kind has questions no other kind gets (manufacturer:
 *            production_location; trader: supply_source; retailer:
 *            exchange_policy; service: service_scope), and any two kinds'
 *            checklists differ by at least 10 questions.
 *   CASE B — a service business is asked nothing about physical goods
 *            (MOQ, dispatch, courier, packing, samples, varieties, stock,
 *            shipping, warehouse stock, raw material, tooling, job work).
 *   CASE C — a business that does not export is asked nothing about exports
 *            (Incoterms, HS codes, letters of credit, overseas buyers).
 *   CASE D — a trader is asked nothing about making goods (production,
 *            tooling, job work, batch consistency).
 *   CASE E — nothing known → only questions every business answers, and
 *            "what kind of business are you" is one of them.
 *   CASE F — the proposal reads the kind from known facts and never invents
 *            one; the owner's confirmed choice always wins.
 *   CASE G — every question in the pool is on at least one checklist (a
 *            question no business can ever be asked is dead weight).
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { checklistChoiceFor, checklistQuestions } from "@/knowledge/knowledge-sheets";
import { getAllKnowledgeQuestions, type BusinessKind } from "@/knowledge/knowledge-question-framework";

const list = (kinds: BusinessKind[], exports = false) => checklistQuestions({ kinds, exports });
const keys = (kinds: BusinessKind[], exports = false) => new Set(list(kinds, exports).map((q) => q.questionKey));
const offenders = (kinds: BusinessKind[], pattern: RegExp, exports = false) =>
  list(kinds, exports).filter((q) => pattern.test(q.question)).map((q) => `${q.domainKey}/${q.questionKey}: "${q.question}"`);

const cases: Array<[string, () => void]> = [];
const test = (name: string, fn: () => void) => cases.push([name, fn]);

const OWN: Record<BusinessKind, string> = { manufacturer: "production_location", trader: "supply_source", retailer: "exchange_policy", service: "service_scope" };
const KINDS: BusinessKind[] = ["manufacturer", "trader", "retailer", "service"];

test("CASE A — each kind gets its own questions, and the lists differ materially", () => {
  for (const kind of KINDS) {
    assert.ok(keys([kind]).has(OWN[kind]), `${kind} checklist lacks its own question ${OWN[kind]}`);
    for (const other of KINDS.filter((item) => item !== kind)) {
      assert.ok(!keys([other]).has(OWN[kind]), `${other} is asked ${kind}'s question ${OWN[kind]}`);
    }
  }
  for (const a of KINDS) for (const b of KINDS) {
    if (a >= b) continue;
    const ka = keys([a]), kb = keys([b]);
    const diff = [...ka].filter((k) => !kb.has(k)).length + [...kb].filter((k) => !ka.has(k)).length;
    assert.ok(diff >= 10, `${a} and ${b} checklists differ by only ${diff} questions`);
  }
});

const GOODS_TOPICS = /\bmoq\b|minimum order|dispatch|courier|transporter|\bpack(ed|ing)\b|\bsamples?\b|variet|in stock|\bstock\b|shipping|deliver|warehouse|raw material|tooling|job work|pallet|carton/i;
const GOODS_ONLY_SECTIONS = ["shipping_delivery", "production_manufacturing", "sourcing_stock", "retail_store"];
test("CASE B — a service business is asked nothing about physical goods", () => {
  assert.deepEqual(offenders(["service"], GOODS_TOPICS), [], "a goods question is on the service checklist");
  const fromGoodsSections = list(["service"]).filter((q) => GOODS_ONLY_SECTIONS.includes(q.domainKey)).map((q) => `${q.domainKey}/${q.questionKey}`);
  assert.deepEqual(fromGoodsSections, [], "the service checklist has a question from a goods-only section");
});

const EXPORT_TOPICS = /incoterm|\bhs\b|customs code|letter of credit|overseas|\bFOB\b|\bCIF\b|export documents|certificate of origin/i;
test("CASE C — a business that does not export is asked nothing about exports", () => {
  for (const kind of KINDS) assert.deepEqual(offenders([kind], EXPORT_TOPICS), [], `${kind} (no exports) is asked an export question`);
  assert.ok(offenders(["manufacturer"], EXPORT_TOPICS, true).length >= 5, "an exporting manufacturer is not asked the export questions");
  assert.ok(!offenders(["service"], /incoterm|\bhs\b|export documents/i, true).length, "an exporting service business is asked goods-export questions");
});

const MAKING_TOPICS = /production|tooling|job work|repeat order matches|made at partner|own unit/i;
test("CASE D — a trader is asked nothing about making goods", () => {
  assert.deepEqual(offenders(["trader"], MAKING_TOPICS), [], "a manufacturing question is on the trader checklist");
});

test("CASE E — nothing known: only universal questions, including the business-type question", () => {
  const universal = list([]);
  assert.ok(universal.every((q) => q.appliesTo.kinds === "all" && !q.appliesTo.exportsOnly), "a kind-specific question is on the unknown-business checklist");
  assert.ok(universal.some((q) => q.questionKey === "business_type"), "the unknown-business checklist does not ask what kind of business it is");
  assert.deepEqual(offenders([], GOODS_TOPICS), [], "an unknown business is asked about physical goods");
});

test("CASE F — the proposal reads known facts, never invents, and the owner's choice wins", () => {
  assert.deepEqual(checklistChoiceFor({ businessTypeAnswer: "Mixed (manufacturer and trader)" }).kinds, ["manufacturer", "trader"]);
  assert.deepEqual(checklistChoiceFor({ businessTypeAnswer: "Service provider" }).kinds, ["service"]);
  assert.deepEqual(checklistChoiceFor({ industry: "Textile trims / zari manufacturing" }).kinds, ["manufacturer"]);
  const exporter = checklistChoiceFor({ businessTypeAnswer: "Exporter" });
  assert.equal(exporter.exports, true);
  assert.deepEqual(exporter.kinds, [], "'Exporter' says nothing about making vs trading; the kind must not be guessed");
  const nothing = checklistChoiceFor({});
  assert.equal(nothing.source, "unknown");
  assert.deepEqual(nothing.kinds, []);
  // The owner's words (the business-type answer) beat a website-scan industry.
  assert.deepEqual(checklistChoiceFor({ businessTypeAnswer: "Trader", industry: "garment manufacturing" }).kinds, ["trader"]);
  const confirmed = checklistChoiceFor({ confirmedAt: "2026-09-25T00:00:00Z", confirmedKinds: ["service"], confirmedExports: false, businessTypeAnswer: "Manufacturer" });
  assert.deepEqual([confirmed.source, confirmed.kinds], ["confirmed", ["service"]]);
});

test("CASE G — every question in the pool is on at least one checklist", () => {
  const reachable = new Set<string>();
  for (const exports of [false, true]) for (const kind of KINDS) for (const q of list([kind], exports)) reachable.add(`${q.domainKey}/${q.questionKey}`);
  const dead = getAllKnowledgeQuestions().filter((q) => !reachable.has(`${q.domainKey}/${q.questionKey}`)).map((q) => `${q.domainKey}/${q.questionKey}`);
  assert.deepEqual(dead, []);
});

let failed = 0;
console.log("golden-checklist-per-business-type — each kind of business gets its own checklist, with nothing that cannot apply\n");
for (const [name, fn] of cases) {
  try { fn(); console.log(`  ✅ ${name}`); } catch (e) { failed++; console.error(`  ❌ ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`); }
}
console.log(`\nchecklist-per-business-type: ${cases.length - failed} passed, ${failed} failed — ${failed ? "FAIL ❌" : "ALL GREEN ✅"}`);
if (failed) process.exit(1);
