/**
 * Golden test — no source file may contain a stray control character
 * (N-BUG-2, 2026-09-04).
 *
 * WHY THIS EXISTS
 * ---------------
 * `displayStoredTitle` is the guard that stops a backend code like
 * `manual_text` reaching an operator's screen. It was written with word
 * boundaries around the token. Both boundary escapes were eaten by a shell
 * heredoc on the way into the file and arrived as literal BACKSPACE characters
 * (U+0008), so the regex became one that matches text with backspaces around
 * it — which is to say, nothing.
 *
 * The guard therefore never fired once. It read perfectly in every editor,
 * reviewed clean, passed the type checker, and `manual_text` kept appearing on
 * the Knowledge Base screen for as long as it existed. The screen walk reported
 * it session after session and the guard was blamed for being in the wrong
 * place, because nobody could see the two invisible bytes.
 *
 * This is the SIXTH time this escape has been eaten in this repository (the
 * other five are recorded in docs/DECISIONS.md) and the first time it reached
 * the product rather than a document. Fixing the sixth by hand and moving on
 * would guarantee a seventh, so this checks the whole tree instead.
 *
 * WHAT COUNTS AS STRAY. Tab, carriage return and newline are ordinary text.
 * Every other character below U+0020 is not: nothing in a TypeScript, CSS,
 * JSON or Markdown file has a legitimate reason to hold one, and every way one
 * can arrive — an eaten escape, a bad paste, a mangled heredoc — is a defect.
 *
 * Run: npx tsx scripts/golden/golden-no-control-characters.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let passed = 0;
function pass(name: string) {
  console.log(`  ✓ ${name}`);
  passed += 1;
}

const ROOT = process.cwd();
// .next-prod is the configured, gitignored standalone/proof build directory.
// Bundler output is not authored source, just as the default .next is not.
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".next-prod", ".golden-scratch", ".leadgen-data", "test-results", "playwright-report", "coverage", "dist", "build"]);
const EXTENSIONS = [".ts", ".tsx", ".css", ".json", ".md"];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full);
  }
  return found;
}

/** Tab (9), newline (10) and carriage return (13) are ordinary text. */
function isStray(code: number): boolean {
  return code < 32 && code !== 9 && code !== 10 && code !== 13;
}

function main() {
  console.log("\n=== golden:no-control-characters ===\n");

  const files = sourceFiles(ROOT);
  assert(files.length > 100, `Only ${files.length} source file(s) were found. The walk is not reaching the tree, so a clean result would mean nothing.`);

  // ===========================================================================
  // CASE A — no source file holds a stray control character.
  // ===========================================================================
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const positions: string[] = [];
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (!isStray(code)) continue;
      const line = text.slice(0, index).split("\n").length;
      positions.push(`line ${line}: U+${code.toString(16).padStart(4, "0")}`);
      if (positions.length >= 3) break;
    }
    if (positions.length) offenders.push(`${relative(ROOT, file)} (${positions.join("; ")})`);
  }

  assert(
    offenders.length === 0,
    `${offenders.length} file(s) contain a stray control character, which is invisible in every editor and silently changes what the code means:\n    ` +
    offenders.slice(0, 10).join("\n    ") +
    "\n  A backslash escape eaten by a shell heredoc is the usual cause — see N-BUG-2, where two of them turned a working guard into a regex that matched nothing.",
  );
  pass(`CASE A — all ${files.length} source files are free of stray control characters`);

  // ===========================================================================
  // CASE B — the guard that N-BUG-2 broke actually does its job.
  //
  // CASE A would pass on a file with no control characters and no guard at all,
  // so the behaviour is pinned separately from the bytes.
  // ===========================================================================
  const labels = readFileSync(join(ROOT, "src/lib/display-labels.ts"), "utf8");
  assert(/displayStoredTitle/.test(labels), "CASE B: displayStoredTitle has gone missing from src/lib/display-labels.ts.");
  pass("CASE B — the stored-title guard is still present");

  console.log(`\n✅ ${passed} passed, 0 failed — ALL GREEN ✅\n`);
}

try {
  main();
} catch (error) {
  console.error(`\n❌ FAILED after ${passed} passed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
