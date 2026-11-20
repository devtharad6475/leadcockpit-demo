/**
 * golden-model-json-line-breaks.ts — a correct model answer is not thrown away
 * because it put real line breaks inside a JSON string (2026-09-24).
 *
 * Seen live on the Command Center's first run: the message writer replied
 *   {"action":"answer","text":"**No drafts produced — no eligible leads.**<newline>…
 * JSON.parse refused it ("Bad control character in string literal"), and the
 * step was reported as FAILED although its answer was right.
 *
 *   CASE A — that exact shape now parses, with the line breaks kept as text.
 *   CASE B — tabs and carriage returns inside strings are kept too.
 *   CASE C — line breaks BETWEEN fields (ordinary pretty-printing) are untouched.
 *   CASE D — an escaped quote inside a string does not confuse the repair.
 *   CASE E — anything else broken still fails, with the original error.
 *   CASE F — every provider that parses model JSON uses this reader.
 *
 * Run: npx tsx scripts/golden/golden-model-json-line-breaks.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { parseModelJson } from "@/llm/providers/tolerant-json";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => void }> = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

test("CASE A — the reply that failed live", () => {
  const raw = '{"action":"answer","text":"**No drafts produced — no eligible leads.**\n\n**Eligibility check (from t1):**\n- Wholesaler leads r"}';
  assert.throws(() => JSON.parse(raw), /control character/i, "sanity: plain JSON.parse rejects it");
  const parsed = parseModelJson(raw) as { action: string; text: string };
  assert.strictEqual(parsed.action, "answer");
  assert.ok(parsed.text.startsWith("**No drafts produced"));
  assert.ok(parsed.text.includes("\n\n**Eligibility check"), "the line breaks survive as text");
});

test("CASE B — tabs and carriage returns inside strings", () => {
  const parsed = parseModelJson('{"a":"one\ttwo\r\nthree"}') as { a: string };
  assert.strictEqual(parsed.a, "one\ttwo\r\nthree");
});

test("CASE C — pretty-printed JSON is untouched", () => {
  const raw = '{\n  "a": 1,\n  "b": ["x", "y"]\n}';
  assert.deepStrictEqual(parseModelJson(raw), { a: 1, b: ["x", "y"] });
});

test("CASE D — an escaped quote inside a string", () => {
  const parsed = parseModelJson('{"a":"she said \\"yes\\"\nthen left","b":2}') as { a: string; b: number };
  assert.strictEqual(parsed.a, 'she said "yes"\nthen left');
  assert.strictEqual(parsed.b, 2);
});

test("CASE E — other damage still fails, with the original error", () => {
  assert.throws(() => parseModelJson('{"a": 1,, "b": 2}'), SyntaxError);
  assert.throws(() => parseModelJson('{"a":"cut off\n'), SyntaxError, "an unfinished reply is not repaired into a finished one");
});

test("CASE F — every provider uses it", () => {
  for (const file of ["OpenAICompatibleProvider", "AnthropicCompatibleProvider", "GeminiCompatibleProvider", "OllamaProvider"]) {
    const source = readFileSync(`src/llm/providers/${file}.ts`, "utf8");
    assert.ok(/parseModelJson\(/.test(source), `${file} must read model JSON with parseModelJson`);
    assert.ok(!/JSON\.parse\((jsonText|extractJson\(rawText\))\)/.test(source), `${file} still parses model output strictly`);
  }
});

console.log("\n=== GOLDEN: model JSON with line breaks inside strings ===\n");
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
  console.log("❌ GOLDEN FAILED: model-json-line-breaks");
  process.exit(1);
}
