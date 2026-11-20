/**
 * golden-no-dotenv-instructions.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * On the live Integrations screen, an owner who wants WhatsApp sending was told:
 *
 *   "…real sending is inactive because the required environment variables are
 *    not set in your .env file."
 *   "Open your .env file to enter your Meta Access Token and Phone Number ID…"
 *   "(Configure a verify token in your .env file before connecting WhatsApp.)"
 *
 * There is no .env file this reader can open. The product is a hosted web app;
 * they have a browser, not a shell on the box. Worse, the thing that ACTUALLY
 * solves it — "Your WhatsApp credentials (this workspace)", which stores the
 * token encrypted against the workspace — sits a few inches up the same screen.
 *
 * Instructions the reader cannot follow read as "this product is broken". This
 * is the same failure as the AI chip claiming "AI running" beside a dead key:
 * the screen describing a world other than the one the owner is standing in.
 *
 * WHY A WHOLE-FAMILY CHECK AND NOT THREE STRING ASSERTIONS
 * -------------------------------------------------------
 * Three copies of one mistake means the mistake is easy to make. Pinning the
 * three sentences would let the fourth through. This scans every screen.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — no user-facing string tells the reader to act on a .env file.
 *   Naming the concept in a server-diagnostics heading is fine; instructing a
 *   business owner to go and edit one is not.
 *
 *   CASE B — the three live sentences specifically are gone.
 *
 *   CASE C — the replacement still points somewhere real: the Integrations
 *   screen must name the in-app credential path.
 *
 *   CASE D — the scanner actually works. A known-bad sentence must be caught,
 *   or CASE A is a test that can never fail.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "./_helpers/read-source";

type Case = { name: string; fn: () => void };
const cases: Case[] = [];
function test(name: string, fn: () => void) { cases.push({ name, fn }); }

const SCREEN_DIR = "src/app/sections";
const SCREEN_FILES = [
  "src/app/page.tsx",
  ...readdirSync(SCREEN_DIR).filter((f) => f.endsWith(".tsx")).map((f) => join(SCREEN_DIR, f).replace(/\\/g, "/")),
];

/** Comments are for developers, who DO have a shell. Only shipped text counts. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, " ");
}

/**
 * "Go and do something to a .env file" — a verb of action within a short reach
 * of the filename. Deliberately narrow: `Server environment check (.env)` is a
 * label for a diagnostics panel, not an instruction, and must stay allowed.
 */
const INSTRUCTION = /\b(?:open|edit|configure|create|update|add\s+(?:it|them|these)?\s*to|set\s+(?:it|them|these)?\s*in|enter\s+(?:it|them|these)?\s*in|not\s+set\s+in|missing\s+from)\b[^"'`]{0,60}\.env\b/i;

function offenders(): Array<{ file: string; line: number; text: string }> {
  const found: Array<{ file: string; line: number; text: string }> = [];
  for (const file of SCREEN_FILES) {
    const lines = withoutComments(readSource(file)).split("\n");
    lines.forEach((text, index) => {
      if (INSTRUCTION.test(text)) found.push({ file, line: index + 1, text: text.trim().slice(0, 140) });
    });
  }
  return found;
}

test("CASE A — no screen tells the owner to go and edit a .env file", () => {
  assert.deepStrictEqual(offenders(), [],
    "the reader of these screens has a browser, not a shell on the server — an instruction they cannot follow reads as 'this is broken'");
});

test("CASE B — the three sentences found on the live deployment are gone", () => {
  const integrations = readSource("src/app/sections/IntegrationsSection.tsx");
  const gone = [
    "are not set in your .env file",
    "Open your <code",
    "Configure a verify token in your .env file",
  ].filter((phrase) => integrations.includes(phrase));
  assert.deepStrictEqual(gone, [], "each of these was on screen, and none of them could be acted on");
});

test("CASE C — the replacement points at something the owner can actually do", () => {
  const integrations = withoutComments(readSource("src/app/sections/IntegrationsSection.tsx"));
  // 2026-09-30 redesign: the credential box is now the WhatsApp side panel,
  // opened by "Set up" on the row that says "Not set up".
  assert.ok(/Connect your number/.test(integrations) && /Access token/.test(integrations),
    "the in-app credential box is the path that works — the screen has to name it");
  assert.ok(/Not set up/.test(integrations) && /"Set up"/.test(integrations),
    "and offer it right where the owner is told WhatsApp is not set up");
});

test("CASE D — the scanner would catch this if it came back", () => {
  const knownBad = [
    'title="Open your .env file to add the key"',
    "<p>The required variables are not set in your .env file.</p>",
    "<span>Configure a verify token in your .env before connecting.</span>",
  ];
  const missed = knownBad.filter((line) => !INSTRUCTION.test(line));
  assert.deepStrictEqual(missed, [], "a scanner that cannot fail is not a test");

  const allowed = [
    "<h4>Server environment check (.env)</h4>",
    "// read from process.env at boot",
  ];
  const falsePositives = allowed.filter((line) => INSTRUCTION.test(withoutComments(line)));
  assert.deepStrictEqual(falsePositives, [],
    "naming the concept in a diagnostics heading is not an instruction, and flagging it would get this check switched off");
});

// --- RUNNER ---------------------------------------------------------------------
(() => {
  console.log("golden-no-dotenv-instructions — N-BUG (a hosted owner cannot open a .env file)\n");
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`no-dotenv-instructions: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
