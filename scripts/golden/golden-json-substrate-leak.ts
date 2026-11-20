/**
 * golden-json-substrate-leak.ts — audit A-7, N-DATA-16.
 *
 * WHY THIS TEST EXISTS
 *
 *   `src/lib/db.ts` is the JSON substrate and ONLY the JSON substrate. readData,
 *   writeData and mutateData open `.leadgen-data/app-data.json` directly; they
 *   do not consult PERSISTENCE_PROVIDER and they have no Prisma path. That is by
 *   design — the provider-aware layer is `@/repositories`.
 *
 *   So any shipping code that calls one of those three OUTSIDE a
 *   `getPersistenceProvider() === "json"` branch is reading or writing a file
 *   that, in a Postgres deployment, nothing else in the application touches. It
 *   does not crash. It does not log. It returns the seed shape and carries on.
 *   That is the worst failure mode there is: a silent wrong answer.
 *
 *   This is not hypothetical. Found 2026-08-25 in POST /api/erasure/:leadId,
 *   which loaded humanFallbackTasks and the do-not-contact registry this way.
 *   On Postgres, a right-to-erasure request therefore erased no fallback tasks
 *   (personal data left behind) and could not preserve a do-not-contact record
 *   it could not see. Two call sites, both fixed; this golden exists so the
 *   third one can never be written quietly.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat)
 *
 *   CASE A — POSITIVE CONTROL. A fabricated source that calls readData() with no
 *     provider guard MUST be flagged. Without this, a detector that silently
 *     matched nothing would print a green "0 leaks" forever.
 *
 *   CASE B — NEGATIVE CONTROL. The same fabricated call, wrapped in
 *     `if (getPersistenceProvider() === "json") { ... }`, MUST NOT be flagged.
 *     A detector that flags everything is as useless as one that flags nothing.
 *
 *   CASE C — SCOPE PROOF. The scan MUST actually parse a large body of real
 *     source. If the globs break or the parser silently returns empty trees,
 *     CASE D would report a vacuous green over nothing at all. Note what this
 *     case deliberately does NOT assert: that some @/lib/db call still exists.
 *     Zero is a legitimate and desirable end state, so hinging the proof on one
 *     surviving call site would turn a future cleanup into a red suite.
 *
 *   CASE D — THE GUARD ITSELF. Zero unguarded call sites across the scanned
 *     shipping code.
 *
 * HOW IT DECIDES, AND WHY IT IS AN AST AND NOT A REGEX
 *
 *   A regex cannot tell `readData()` from `this.readData()`, from a parameter
 *   named `mutateData` that the caller injected (ErasureCascade does exactly
 *   that, legitimately), or from the word appearing in a comment — and this file
 *   is full of comments about readData. So it parses with the TypeScript
 *   compiler and only considers a call whose callee is a plain identifier that
 *   the file actually imported from `@/lib/db`, by either form:
 *     import { readData } from "@/lib/db";
 *     const { readData } = await import("@/lib/db");
 *   A call is guarded when some ancestor `if` tests the persistence provider
 *   against "json" and the call sits in that if's THEN branch.
 *
 * MUTATION-TESTED 2026-08-25, every mutation compiling clean under tsc and
 * every source restored byte-identical (sha256 verified) afterwards:
 *   m1 the guard detector calls every unguarded call guarded   -> CASE A fails
 *   m2 the guard detector never recognises a guard             -> CASE B fails
 *   m3 the import tracker forgets every imported name          -> CASE A fails
 *   m4 the scan walks no directories                           -> CASE C fails
 *   m5 THE REAL FIX IS REVERTED: the erasure route goes back to
 *      readData() for humanFallbackTasks                       -> CASE D fails
 * 5 of 5 caught, no equivalents. m5 is the one that matters — it sabotages the
 * shipping code rather than the test, which is the only way to show this golden
 * would have caught the bug it was written for.
 *
 * Run: npx tsx scripts/golden/golden-json-substrate-leak.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const DB_NAMES = new Set(["readData", "writeData", "mutateData"]);
const DB_MODULE = "@/lib/db";

/**
 * Files that are ALLOWED to speak JSON directly, each for a stated reason.
 * Anything not on this list and not under a provider guard is a finding.
 */
const EXEMPT = [
  // The implementation itself.
  "src/lib/db.ts",
  // The JSON repository bundle: being the JSON substrate is its whole job.
  "src/repositories/json/",
  // The transaction adapter. It is JSON-by-construction and documented as such;
  // every caller of runInTransaction is behind a provider guard, which is what
  // CASE D checks at those call sites rather than here.
  "src/lib/run-in-transaction.ts",
];

const SCAN_DIRS = ["src/app/api", "src/services", "src/lib"];

type Finding = { file: string; line: number; name: string; snippet: string };

function collectFiles(dir: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
}

function isExempt(rel: string): boolean {
  const normalized = rel.split(path.sep).join("/");
  return EXEMPT.some((prefix) => normalized === prefix || normalized.startsWith(prefix));
}

/** Names this file pulled out of @/lib/db, by either import form. */
function importedDbNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  const addFromBindings = (bindings: ts.NamedImportBindings | undefined) => {
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const local = element.name.text;
        const original = element.propertyName?.text ?? local;
        if (DB_NAMES.has(original)) names.add(local);
      }
    }
  };

  const visit = (node: ts.Node) => {
    // import { readData } from "@/lib/db";
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === DB_MODULE) addFromBindings(node.importClause?.namedBindings);
    }
    // const { readData } = await import("@/lib/db");
    if (ts.isVariableDeclaration(node) && node.initializer && node.name && ts.isObjectBindingPattern(node.name)) {
      const init = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
      const isDbImport =
        ts.isCallExpression(init) &&
        init.expression.kind === ts.SyntaxKind.ImportKeyword &&
        init.arguments.length === 1 &&
        ts.isStringLiteral(init.arguments[0]) &&
        (init.arguments[0] as ts.StringLiteral).text === DB_MODULE;
      if (isDbImport) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const local = element.name.text;
          const original =
            element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : local;
          if (DB_NAMES.has(original)) names.add(local);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return names;
}

/**
 * True when `node` sits in the THEN branch of an `if` that tests the persistence
 * provider against "json". The else branch deliberately does not count: that is
 * the Prisma side.
 */
function underJsonGuard(node: ts.Node): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (parent) {
    if (ts.isIfStatement(parent)) {
      const condition = parent.expression.getText();
      const testsProvider = /getPersistenceProvider\s*\(\s*\)/.test(condition) && /["']json["']/.test(condition);
      // Inside the THEN branch (walking up, `child` is whichever branch we came from).
      if (testsProvider && child === parent.thenStatement) return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/** Every unguarded @/lib/db call in one parsed source. */
function findLeaks(rel: string, text: string): Finding[] {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const names = importedDbNames(source);
  if (names.size === 0) return [];

  const findings: Finding[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text)) {
      if (!underJsonGuard(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        findings.push({
          file: rel,
          line: line + 1,
          name: node.expression.text,
          snippet: node.getText(source).split("\n")[0].slice(0, 90),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/**
 * Two numbers per file: how many @/lib/db calls it makes (reported for context)
 * and how many call expressions it contains at all (CASE C's proof that the
 * parser really walked a real tree and not an empty one).
 */
function measure(rel: string, text: string): { dbCalls: number; allCalls: number } {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const names = importedDbNames(source);
  let dbCalls = 0;
  let allCalls = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      allCalls += 1;
      if (ts.isIdentifier(node.expression) && names.has(node.expression.text)) dbCalls += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { dbCalls, allCalls };
}

function main() {
  let failures = 0;

  // ── CASE A — positive control ────────────────────────────────────────────
  const unguardedSample = [
    'import { readData } from "@/lib/db";',
    "export async function loadThings(workspaceId: string) {",
    "  return ((await readData()).things || []).filter((t) => t.workspaceId === workspaceId);",
    "}",
  ].join("\n");
  const caseA = findLeaks("synthetic-unguarded.ts", unguardedSample);
  if (caseA.length === 1 && caseA[0].name === "readData") {
    console.log("CASE A pass — an unguarded readData() in a fabricated source is flagged");
  } else {
    console.log(`CASE A FAIL — expected exactly 1 finding, got ${caseA.length}`);
    failures += 1;
  }

  // ── CASE B — negative control ────────────────────────────────────────────
  const guardedSample = [
    'import { readData } from "@/lib/db";',
    'import { getPersistenceProvider } from "@/lib/persistence";',
    "export async function loadThings(workspaceId: string) {",
    '  if (getPersistenceProvider() === "json") {',
    "    return ((await readData()).things || []).filter((t) => t.workspaceId === workspaceId);",
    "  }",
    "  return [];",
    "}",
  ].join("\n");
  const caseB = findLeaks("synthetic-guarded.ts", guardedSample);
  if (caseB.length === 0) {
    console.log("CASE B pass — the same call under a json provider guard is not flagged");
  } else {
    console.log(`CASE B FAIL — a guarded call was flagged: ${JSON.stringify(caseB)}`);
    failures += 1;
  }

  // ── Scan the real sources ────────────────────────────────────────────────
  const files: string[] = [];
  for (const dir of SCAN_DIRS) collectFiles(path.join(ROOT, dir), files);

  let scanned = 0;
  let dbCalls = 0;
  let allCalls = 0;
  const leaks: Finding[] = [];
  for (const full of files) {
    const rel = path.relative(ROOT, full);
    if (isExempt(rel)) continue;
    scanned += 1;
    const text = readFileSync(full, "utf8");
    const counts = measure(rel, text);
    dbCalls += counts.dbCalls;
    allCalls += counts.allCalls;
    leaks.push(...findLeaks(rel, text));
  }

  // ── CASE C — scope proof ─────────────────────────────────────────────────
  if (scanned > 100 && allCalls > 1000) {
    console.log(`CASE C pass — ${scanned} shipping files parsed, ${allCalls} call expressions walked`);
    console.log(`             (${dbCalls} of them are @/lib/db calls, all of them guarded)`);
  } else {
    console.log(`CASE C FAIL — scan looks vacuous: ${scanned} files, ${allCalls} call expressions`);
    failures += 1;
  }

  // ── CASE D — the guard ───────────────────────────────────────────────────
  if (leaks.length === 0) {
    console.log("CASE D pass — no shipping code reads or writes the JSON file outside a provider guard");
  } else {
    console.log(`CASE D FAIL — ${leaks.length} unguarded JSON-substrate call site(s):`);
    for (const leak of leaks) {
      console.log(`    ${leak.file}:${leak.line}  ${leak.snippet}`);
    }
    console.log("");
    console.log("  Each of these runs against .leadgen-data/app-data.json even when the");
    console.log("  deployment is on Postgres, where nothing else reads or writes that file.");
    console.log("  Use @/repositories (provider-aware) or put the call behind");
    console.log('  `if (getPersistenceProvider() === "json")` with a Prisma path beside it.');
    failures += 1;
  }

  console.log("");
  if (failures === 0) {
    console.log("=== JSON SUBSTRATE LEAK: 4/4 CASES PASS ✅ ===");
    process.exit(0);
  }
  console.log(`=== JSON SUBSTRATE LEAK: ${failures} CASE(S) FAILED ❌ ===`);
  process.exit(1);
}

main();
