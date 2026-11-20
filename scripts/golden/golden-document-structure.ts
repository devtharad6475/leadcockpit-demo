/**
 * golden-document-structure.ts — tables keep their headings, chunks keep their
 * sections (2026-09-17, session 56).
 *
 * Pins src/rag/document-structure.ts. Fixtures are the SHAPES pdf-parse really
 * produced from the five Om Jari test PDFs — tab-separated rows with the header
 * on the first line only, a long cell wrapped onto its own tab-less line, a page
 * footer ending "<tab>Page 1 of 4", and "-- 1 of 4 --" page markers — plus the
 * Markdown pipe tables that .md / .docx uploads carry.
 *
 *   CASE A — a wide tab table: every row names every column.
 *   CASE B — a two-column key/value table becomes "key: value".
 *   CASE C — a wrapped cell is rejoined onto its own row, not dropped.
 *   CASE D — page footers and page markers are removed; a lone tab line
 *            (a masthead) is not a table and keeps its text.
 *   CASE E — a Markdown pipe table serialises the same way.
 *   CASE F — chunks follow headings and every chunk names its section.
 *   CASE G — a table row is never cut in half, and no chunk exceeds the limit
 *            unless one line alone is longer.
 *   CASE H — a short plain document is still exactly one chunk (the contract
 *            the old splitters had, relied on by existing callers).
 *   CASE I — a wrapped line starting with a number ("500 Kg MOQ") is not
 *            mistaken for a heading.
 *   CASE J — documents joined by the pipeline keep their own source label, and
 *            a heading from one file never leaks onto the next.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { chunkByStructure, serializeTables } from "@/rag/document-structure";

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}

const T = "\t";

const PRICE_PDF = [
  "2. Price list (Standard grade, stocked shades)",
  `Article ${T}50-199 kg ${T}200-499 kg ${T}500 kg and above`,
  `Kasab Zari 150D ${T}Rs 350 / kg ${T}Rs 335 / kg ${T}Rs 320 / kg`,
  `Neem Zari ${T}Rs 295 / kg ${T}Rs 285 / kg ${T}Rs 272 / kg`,
  "Premium grade: add 12% to the Standard price.",
].join("\n");

const FACTS_PDF = [
  "1. Company overview",
  `Fact ${T}Detail`,
  `Registered name ${T}Om Jari & Metallic`,
  `Factory address ${T}Plot 55-56, Nirman Industrial Estate, Fulpada, Surat`,
  "395008, Gujarat, India",
  `Website ${T}https://omjari.in`,
  `Om Jari & Metallic - synthetic test data for LeadCockpit ${T}Page 1 of 4`,
  "",
  "-- 1 of 4 --",
  "",
  "2. Value proposition",
  "Buyers choose us for shade consistency.",
].join("\n");

console.log("\n=== GOLDEN: document structure (tables + sections) ===\n");

check("CASE A — a wide tab table names every column on every row", () => {
  const out = serializeTables(PRICE_PDF);
  assert.ok(
    out.includes("Neem Zari — 50-199 kg: Rs 295 / kg; 200-499 kg: Rs 285 / kg; 500 kg and above: Rs 272 / kg."),
    `Neem Zari row lost its column names:\n${out}`,
  );
  assert.ok(out.includes("Table columns: Article | 50-199 kg | 200-499 kg | 500 kg and above."), "header summary missing");
  assert.ok(!out.includes("\t"), "a tab survived serialisation");
  assert.ok(out.includes("Premium grade: add 12% to the Standard price."), "prose after the table was lost");
});

check("CASE B — a two-column table becomes key: value", () => {
  const out = serializeTables(FACTS_PDF);
  assert.ok(out.includes("Registered name: Om Jari & Metallic"), out);
  assert.ok(out.includes("Website: https://omjari.in"), out);
  assert.ok(!out.includes("Fact:"), "the header row of a key/value table must not become a fact");
});

check("CASE C — a wrapped cell is rejoined onto its row", () => {
  const out = serializeTables(FACTS_PDF);
  assert.ok(
    out.includes("Factory address: Plot 55-56, Nirman Industrial Estate, Fulpada, Surat 395008, Gujarat, India"),
    `wrapped address not rejoined:\n${out}`,
  );
});

check("CASE D — page furniture removed; a lone tab line keeps its text", () => {
  const out = serializeTables(FACTS_PDF);
  assert.ok(!/Page 1 of 4/.test(out), "page footer survived");
  assert.ok(!/-- 1 of 4 --/.test(out), "page marker survived");
  assert.ok(!out.includes("synthetic test data for LeadCockpit"), "footer caption survived");
  const masthead = serializeTables(`OM JARI & METALLIC ${T}DOCUMENT 1 OF 5\nCompany Profile`);
  assert.strictEqual(masthead, "OM JARI & METALLIC DOCUMENT 1 OF 5\nCompany Profile");
});

check("CASE E — a Markdown pipe table serialises the same way", () => {
  const md = [
    "## 2. Price list",
    "| Article | 50-199 kg | 200-499 kg |",
    "|---|---|---|",
    "| Coco Zari | Rs 265 / kg | Rs 255 / kg |",
  ].join("\n");
  const out = serializeTables(md);
  assert.ok(out.includes("Coco Zari — 50-199 kg: Rs 265 / kg; 200-499 kg: Rs 255 / kg."), out);
  assert.ok(!out.includes("|---"), "separator row survived");
});

check("CASE F — chunks follow headings and name their section", () => {
  const chunks = chunkByStructure(`${FACTS_PDF}\n${PRICE_PDF}`);
  assert.strictEqual(chunks.length, 3, `expected one chunk per section, got ${chunks.length}:\n${chunks.join("\n---\n")}`);
  assert.ok(chunks[0].startsWith("Section: 1. Company overview\n"), chunks[0]);
  assert.ok(chunks[1].startsWith("Section: 2. Value proposition\n"), chunks[1]);
  assert.ok(chunks[2].startsWith("Section: 2. Price list (Standard grade, stocked shades)\n"), chunks[2]);
  assert.ok(!chunks[1].includes("Registered name"), "a section leaked into the next one");
});

check("CASE G — rows are never cut and chunks respect the limit", () => {
  const rows = Array.from({ length: 40 }, (_, n) => `Article ${n} ${T}Rs ${100 + n} / kg ${T}Rs ${90 + n} / kg`);
  const text = ["3. Big table", `Article ${T}Small ${T}Large`, ...rows].join("\n");
  const limit = 400;
  const chunks = chunkByStructure(text, limit);
  assert.ok(chunks.length > 1, "a long table should span several chunks");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= limit, `chunk of ${chunk.length} chars exceeds ${limit}`);
    assert.ok(chunk.startsWith("Section: 3. Big table\n"), "a continuation chunk lost its section heading");
    for (const line of chunk.split("\n").slice(1)) {
      assert.ok(/^(Article \d+ — Small: Rs \d+ \/ kg; Large: Rs \d+ \/ kg\.|Table columns: .+)$/.test(line), `row was cut: "${line}"`);
    }
  }
  const joined = chunks.join("\n");
  for (let n = 0; n < 40; n += 1) assert.ok(joined.includes(`Article ${n} — Small: Rs ${100 + n} / kg`), `row ${n} missing`);
});

check("CASE H — a short plain document is exactly one chunk", () => {
  const chunks = chunkByStructure("We sell zari thread in Surat. MOQ is 50 kg.");
  assert.deepStrictEqual(chunks, ["We sell zari thread in Surat. MOQ is 50 kg."]);
});

check("CASE I — a wrapped line starting with a number is not a heading", () => {
  const chunks = chunkByStructure("1. Minimum order\nOur minimum is\n500 Kg MOQ for cording\nand 50 kg for zari.");
  assert.strictEqual(chunks.length, 1, chunks.join("\n---\n"));
  assert.ok(chunks[0].includes("500 Kg MOQ for cording"), chunks[0]);
});

check("CASE J — joined documents keep their own labels; a heading never leaks into the next file", () => {
  // The exact shape KnowledgeSourceBundleService.buildCombinedSourceText makes.
  const combined = [
    "[Source: File - policy.md]",
    "## Below-minimum enquiries",
    "A buyer asking for less than the minimum is referred to the owner.",
    "",
    "---",
    "",
    "[Source: File - notes.txt]",
    "minimum order zari thread - 10 kg per shade",
  ].join("\n");
  const chunks = chunkByStructure(combined);
  assert.strictEqual(chunks.length, 2, chunks.join("\n---\n"));
  assert.ok(chunks[0].startsWith("Source: File - policy.md\nSection: Below-minimum enquiries\n"), chunks[0]);
  assert.ok(chunks[1].startsWith("Source: File - notes.txt\n"), chunks[1]);
  assert.ok(!chunks[1].includes("Section: Below-minimum enquiries"), "the notepad was filed under the policy's heading");
  // A horizontal rule alone also ends the previous heading.
  const ruled = chunkByStructure("## Returns\nNo returns on cut cones.\n---\nWe are closed on Sundays.");
  assert.strictEqual(ruled.length, 2, ruled.join("\n---\n"));
  assert.strictEqual(ruled[1], "We are closed on Sundays.");
});

console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) {
  console.log("❌ GOLDEN FAILED: document-structure");
  process.exit(1);
}
