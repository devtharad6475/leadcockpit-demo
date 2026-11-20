/**
 * Golden test — FORM LABEL BINDING (2026-08-05, audit finding F-9).
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Every `<label>` must be associated with the control it names, or a screen
 * reader announces an unlabelled edit box. HTML gives two ways to do it:
 *
 *   IMPLICIT — the label WRAPS the control:
 *       <label><span>Provider</span><select .../></label>
 *
 *   EXPLICIT — the label points at the control's id:
 *       <label htmlFor="x">Provider</label><select id="x" .../>
 *
 * This codebase uses the implicit form almost everywhere, which is correct and
 * needs no change. The audit found a handful of places using NEITHER: a
 * `<label>` sitting as a SIBLING of its input with no `htmlFor`. Those included
 * all four fields of the public signup form and both fields of the invite
 * form — the first screens a new customer ever sees.
 *
 * ─── WHAT THIS TEST ASSERTS ────────────────────────────────────────────────
 *
 * A label element whose content is plain text (i.e. it does NOT wrap a control)
 * must carry `htmlFor`. Labels that wrap their control are skipped — they are
 * already associated.
 *
 * This is a source-text check rather than a DOM check on purpose: it runs in
 * milliseconds, needs no browser, and catches the mistake at the moment it is
 * written. A rendered-DOM accessibility sweep is a different (and slower) tool;
 * this one exists to stop the specific regression the audit found.
 *
 * Run: npm run golden:form-label-binding
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Generated Prisma client contains no JSX; skip it (30k+ lines).
      if (entry === "generated" || entry === "node_modules") continue;
      walk(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

type Offender = { file: string; line: number; text: string };

const offenders: Offender[] = [];
const files = walk(path.resolve(process.cwd(), "src"));

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    // Match a <label ...>TEXT</label> that opens AND closes on one line with
    // nothing but plain text between. That shape cannot be wrapping a control,
    // so it needs htmlFor. A multi-line <label> that contains an <input>,
    // <select> or <textarea> is the implicit (valid) form and is not matched.
    const match = line.match(/<label(?![^>]*\bhtmlFor\b)[^>]*>([^<>{}]+)<\/label>/);
    if (!match) return;
    // A label whose text is only whitespace is decorative; ignore it.
    if (!match[1].trim()) return;
    offenders.push({
      file: path.relative(process.cwd(), file).replace(/\\/g, "/"),
      line: index + 1,
      text: match[1].trim().slice(0, 60),
    });
  });
}

console.log("GOLDEN: form label binding (audit F-9)");
console.log("");
console.log(`  scanned ${files.length} .tsx files`);

if (offenders.length === 0) {
  console.log("");
  console.log("=== FORM LABEL BINDING: no unassociated labels ✅ ===");
  process.exit(0);
}

console.log("");
console.log(`=== FORM LABEL BINDING: ${offenders.length} unassociated label(s) ❌ ===`);
console.log("");
for (const o of offenders) {
  console.log(`  ✗ ${o.file}:${o.line}`);
  console.log(`      "${o.text}"`);
}
console.log("");
console.log("  Each label above names a control it is not associated with, so a");
console.log("  screen reader announces that control as unlabelled.");
console.log("  Fix: add htmlFor=\"x\" to the label and id=\"x\" to its input,");
console.log("  or wrap the control inside the label.");
process.exit(1);
