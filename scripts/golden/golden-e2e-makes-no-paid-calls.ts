/**
 * golden-e2e-makes-no-paid-calls.ts — the browser test server holds no key
 * that costs money or can reach a real person (2026-09-24).
 *
 * `npm run test:e2e` used to read `.env` and with it the real platform keys:
 * three billed DeepSeek ICP generations per run in one spec alone, possible
 * billed SerpApi searches, and the live e-mail and WhatsApp send tokens.
 * playwright.config.ts now blanks them (PAID_KEY_ENV_NAMES).
 *
 * The danger is drift: a key added to the product next month is read from
 * `.env` by the test server unless someone remembers this list. So:
 *
 *   CASE A — every provider key the model layer knows (PLATFORM_KEY_ENV and its
 *            unprefixed fallbacks) is on the blank list.
 *   CASE B — every `process.env.X` the product reads whose name ends in
 *            `API_KEY`, or is a WhatsApp/Meta send token, is on the list.
 *   CASE C — the blanks are applied to the server env, and only E2E_REAL_AI=1
 *            turns them off.
 *
 * Run: npx tsx scripts/golden/golden-e2e-makes-no-paid-calls.ts
 */
import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_KEY_ENV, PLATFORM_KEY_ENV_FALLBACK } from "@/llm/platform-defaults";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => void }> = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

const config = readFileSync("playwright.config.ts", "utf8");
const listBlock = config.slice(config.indexOf("export const PAID_KEY_ENV_NAMES"), config.indexOf("] as const;"));
const blanked = new Set([...listBlock.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "generated" || name === "node_modules") continue;
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

// Keys that never cost money or send: encryption, session and webhook-signature
// secrets. Listed so the exclusion is a decision, not an accident.
const NOT_PAID = new Set(["ENCRYPTION_KEY"]);

test("CASE A — every model-provider key is blanked", () => {
  for (const name of [...Object.values(PLATFORM_KEY_ENV), ...Object.values(PLATFORM_KEY_ENV_FALLBACK)]) {
    assert.ok(blanked.has(name), `${name} is read by the model layer but not blanked for the test server`);
  }
});

test("CASE B — every paid key or send token the product reads is blanked", () => {
  const read = new Set<string>();
  for (const file of sourceFiles("src")) {
    for (const match of readFileSync(file, "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)) read.add(match[1]);
  }
  const paid = [...read].filter((name) =>
    !NOT_PAID.has(name) && (/API_KEY$/.test(name) || /^(WHATSAPP_(CLOUD_ACCESS_)?TOKEN|META_SYSTEM_TOKEN)$/.test(name)));
  assert.ok(paid.length >= 8, `sanity: expected to find the product's key readers, found ${paid.length}`);
  const missing = paid.filter((name) => !blanked.has(name));
  assert.deepStrictEqual(missing, [], "add these to PAID_KEY_ENV_NAMES in playwright.config.ts");
});

test("CASE C — the blanks reach the server, unless a paid run is asked for", () => {
  assert.ok(/process\.env\.E2E_REAL_AI === "1" \? \{\} :/.test(config), "only E2E_REAL_AI=1 may keep the keys");
  assert.ok(/const SHARED_SERVER_ENV = \{\s*\.\.\.NO_PAID_CALLS_ENV,/.test(config), "the blanks must be part of the server env");
  const sharedUses = (config.match(/\.\.\.SHARED_SERVER_ENV,/g) || []).length;
  assert.strictEqual(sharedUses, 2, "both targets (JSON and Postgres) must inherit the shared env");
});

console.log("\n=== GOLDEN: the browser test server makes no paid calls ===\n");
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
  console.log("❌ GOLDEN FAILED: e2e-makes-no-paid-calls");
  process.exit(1);
}
