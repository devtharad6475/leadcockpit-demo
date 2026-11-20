/**
 * Break test, part 5 (2026-09-26): lead spreadsheets the way real people
 * save them. Each file is imported through the real endpoint on the
 * throwaway server ("leadgen-break", port 3020) and the answer is checked.
 *
 *   BREAK_BASE_URL=http://127.0.0.1:3020 npx tsx scripts/probes/break-csv.ts
 *
 * Every email and phone is unroutable (.example domain, +91 00000 block).
 */
const BASE = process.env.BREAK_BASE_URL || "http://127.0.0.1:3020";
const H = { "content-type": "application/json", origin: BASE };
const tag = Date.now();

async function importCsv(csv: string) {
  const campaigns = await fetch(`${BASE}/api/campaigns`, { headers: H }).then((r) => r.json()) as Array<{ id: string }>;
  const response = await fetch(`${BASE}/api/leads/upload-csv`, { method: "POST", headers: H, body: JSON.stringify({ csv, campaignId: campaigns[0]?.id }) });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, text: text.slice(0, 200) };
}

const cases: Array<[string, string, (r: Awaited<ReturnType<typeof importCsv>>) => string | undefined]> = [
  ["Excel's invisible start marker (BOM)", `﻿company_name,email\nBOM Co ${tag},bom.${tag}@csv.example\n`,
    (r) => (r.json.created === 1 ? undefined : `created ${r.json.created}: ${r.text}`)],
  ["semicolons instead of commas", `company_name;email\nSemi Co ${tag};semi.${tag}@csv.example\n`,
    (r) => (r.json.created === 1 ? undefined : `created ${r.json.created}: ${r.text}`)],
  ["a line break inside a quoted cell", `company_name,email,fit_reason\n"Quote Co ${tag}",quote.${tag}@csv.example,"line one\nline two"\n`,
    (r) => (r.json.created === 1 ? undefined : `created ${r.json.created}: ${r.text}`)],
  ["the same company twice in one file", `company_name,email\nTwice Co ${tag},twice.${tag}@csv.example\nTwice Co ${tag},twice.${tag}@csv.example\n`,
    (r) => (r.json.created === 1 ? undefined : `created ${r.json.created} (expected 1): ${r.text}`)],
  ["blank rows and spaces-only rows", `company_name,email\n\n   ,   \nBlank Co ${tag},blank.${tag}@csv.example\n,\n`,
    (r) => (r.json.created === 1 ? undefined : `created ${r.json.created}: ${r.text}`)],
  ["Windows line endings", `company_name,email\r\nCRLF Co ${tag},crlf.${tag}@csv.example\r\n`,
    (r) => (r.json.created === 1 ? undefined : `created ${r.json.created}: ${r.text}`)],
  ["headers in capitals with spaces", `Company Name , Email \nCaps Co ${tag},caps.${tag}@csv.example\n`,
    (r) => (r.json.created === 1 ? undefined : `created ${r.json.created}: ${r.text}`)],
  ["only a header row", `company_name,email\n`,
    (r) => (r.status < 500 && !r.json.created ? undefined : `${r.status} ${r.text}`)],
  ["not a spreadsheet at all", `%PDF-1.7 binary junk \u0000\u0001`,
    (r) => (r.status < 500 && !r.json.created ? undefined : `${r.status} ${r.text}`)],
  ["50,000 rows", "company_name,email\n" + Array.from({ length: 50000 }, (_, i) => `Bulk ${tag} ${i},bulk${i}.${tag}@csv.example`).join("\n"),
    (r) => (r.status < 500 ? undefined : `${r.status} ${r.text}`)],
];

(async () => {
  let failed = 0;
  for (const [label, csv, judge] of cases) {
    const started = Date.now();
    const result = await importCsv(csv);
    const problem = judge(result);
    if (problem) failed++;
    console.log(`${problem ? "FAIL" : "OK  "} ${label} → ${result.status}${result.json.created !== undefined ? `, ${result.json.created} created` : ""} (${Date.now() - started} ms)${problem ? `\n       ${problem}` : ""}`);
  }
  console.log(`\n${failed ? `${failed} FAILED` : "ALL OK"}`);
})().catch((error) => { console.error(error); process.exit(1); });

export {};
