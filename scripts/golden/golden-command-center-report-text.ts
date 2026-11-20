/**
 * golden-command-center-report-text.ts — the master's report is typeset, and
 * never edited (2026-09-24, Command Center v2).
 *
 *   CASE A — ALL-CAPS lines become headings, "- " and "1." lines become list
 *            items, "---" becomes a divider.
 *   CASE B — every word of the report survives; only markup is added.
 *   CASE C — ordinary sentences stay paragraphs (a sentence that merely starts
 *            with a capital word is not a heading).
 *
 * Run: npx tsx scripts/golden/golden-command-center-report-text.ts
 */
import assert from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportText } from "@/app/sections/command-center-parts";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => void }> = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

const REPORT = [
  "Here's the short version.",
  "",
  "WHAT WE FOUND",
  "- Your lead list has 14 leads.",
  "- Two are **flagged**.",
  "---",
  "WHAT STILL NEEDS YOU:",
  "1. Confirm the minimum order.",
  "2. Approve the drafts.",
  "Nothing was sent to any customer.",
].join("\n");

const html = renderToStaticMarkup(React.createElement(ReportText, { text: REPORT }));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

test("CASE A — headings, lists and dividers", () => {
  assert.strictEqual((html.match(/<h3/g) || []).length, 2, "two headings");
  assert.match(html, /<h3[^>]*>WHAT WE FOUND<\/h3>/);
  assert.match(html, /<h3[^>]*>WHAT STILL NEEDS YOU<\/h3>/, "a trailing colon is dropped from a heading");
  assert.strictEqual((html.match(/<li/g) || []).length, 4, "four list items");
  assert.strictEqual((html.match(/<ul/g) || []).length, 2, "two separate lists");
  assert.strictEqual((html.match(/<hr/g) || []).length, 1, "one divider");
});

test("CASE B — no word is lost", () => {
  const words = REPORT.replace(/\*\*/g, "").replace(/^(-{3,}|- |\d+\. )/gm, "").replace(/:$/gm, "").split(/\s+/).filter(Boolean);
  const rendered = text(html);
  for (const word of words) assert.ok(rendered.includes(word), `"${word}" is missing from the rendered report`);
});

test("CASE C — sentences stay paragraphs", () => {
  assert.match(html, /<p[^>]*>Here&#x27;s the short version\.<\/p>/);
  assert.match(html, /<p[^>]*>Nothing was sent to any customer\.<\/p>/);
});

console.log("\n=== GOLDEN: Command Center report formatting ===\n");
for (const c of cases) {
  try {
    c.fn();
    pass += 1;
    console.log(`  ✓ ${c.name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) {
  console.log("❌ GOLDEN FAILED: command-center-report-text");
  process.exit(1);
}
