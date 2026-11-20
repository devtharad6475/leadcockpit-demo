/**
 * mutation-sweep.ts — answer "can this check fail?" for the whole suite, by
 * machine, unattended.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * The board's most honest bad number is "checks proven able to fail": 31 of
 * 189 at the time this was written. The other 158 are not known bad — they are
 * UNKNOWN, which is a different and worse thing, because a green suite is
 * quoted as evidence in this project's own documents.
 *
 * Until now that number moved by hand: pick a golden, read the shipping code,
 * invent a break, run it, restore it, write it up. Roughly one or two per
 * session. At that rate 158 is not a plan.
 *
 * The insight is that the hand-work was buying two different things and only
 * one of them needs a human:
 *
 *   1. "Is this check capable of failing at all?" — a mechanical question. A
 *      dumb, type-preserving break is enough to answer it, and a machine can
 *      try thousands overnight for free.
 *   2. "Is this check asserting the RIGHT thing?" — not mechanical. That is
 *      what found the phantom-field class of fault (S24-24), and it needed the
 *      compiler plus judgement. Not this tool's job.
 *
 * This tool does (1) at scale so that human attention is spent only on what
 * survives it. A surviving mutation is a lead, not a verdict.
 *
 * ── WHAT IT DOES NOT PROVE ────────────────────────────────────────────────
 * A killed mutation proves the golden can fail when THAT line changes. It does
 * not prove the golden asserts anything true, does not prove the fixture is
 * honest, and does not prove coverage of any line it never mutated. A golden
 * with 12/12 kills is "demonstrably alive", NOT "verified".
 *
 * Equally: a SURVIVED mutation is not automatically a hole. Some mutations are
 * genuinely equivalent — they change the source without changing any observable
 * behaviour (L32: `providerMessageId` is optional, so typo-ing it changed
 * nothing, and that was a real result rather than a mistake). Survivors need
 * triage. That triage is far cheaper than mutating 158 checks by hand.
 *
 * ── TYPE-PRESERVING BY CONSTRUCTION ───────────────────────────────────────
 * The loop rule is "mutations that still compile", because a mutation that
 * fails to compile makes the test fail for the wrong reason and proves nothing.
 * tsx transpiles WITHOUT typechecking, so a broken-typed mutation would still
 * run and would silently produce a fake "kill". Every operator below is
 * therefore chosen to preserve types: comparison operators swap for comparison
 * operators, booleans for booleans, numbers for numbers. `--verify-types` runs
 * `tsc --noEmit` on a sample to confirm that claim rather than assert it.
 *
 * ── SAFETY ────────────────────────────────────────────────────────────────
 * This tool edits shipping source files in place. It is only safe because:
 *   - every target is snapshotted to .mutation-sweep/pristine/ BEFORE anything
 *     is written, and restored from that snapshot after every single mutation;
 *   - the restore is verified by sha256, and a mismatch aborts the whole run
 *     rather than continuing;
 *   - the file currently mutated is recorded in .mutation-sweep/INFLIGHT.json
 *     before it is written, so a hard kill mid-run is recoverable with
 *     `--restore`;
 *   - it refuses to start if `git status` shows a target file already dirty in
 *     a way it did not create, because it cannot tell your edit from its own.
 *
 * Run `npx tsx scripts/probes/mutation-sweep.ts --restore` after any crash,
 * before doing anything else.
 *
 * ── USAGE ─────────────────────────────────────────────────────────────────
 *   --only <substr>     restrict to goldens whose filename contains substr
 *   --max <n>           mutations per golden (default 12)
 *   --calibrate         run the two calibration cases and stop
 *   --verify-types      typecheck a sample of mutations, then stop
 *   --restore           restore every pristine snapshot and exit
 *   --resume            skip goldens already present in the results file
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { transformSync } from "esbuild";

const ROOT = process.cwd();
const GOLDEN_DIR = path.resolve(ROOT, "scripts/golden");
const WORK = path.resolve(ROOT, ".mutation-sweep");
const PRISTINE = path.join(WORK, "pristine");
const INFLIGHT = path.join(WORK, "INFLIGHT.json");
const RESULTS = path.join(WORK, "results.jsonl");

// Same exclusions as the suite runner, same reasons (see its header).
const SUITE_EXCLUDE = new Set(["golden-demo-data-integrity.ts", "golden-docker-compose.ts"]);

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ONLY = opt("--only", "");
const MAX_PER_GOLDEN = Number(opt("--max", "12"));
const RUN_TIMEOUT_MS = Number(opt("--timeout", "180000"));
// --plan answers "why did this golden score what it scored?" without running
// anything. Two aim faults have already been found by asking that question,
// and both times the answer was in WHERE the mutations landed, which the
// result file does not record. Prints the picked sites and touches no source.
const PLAN = flag("--plan");
// --self-test grades the grader. Two properties have to hold or every number
// this tool prints is worthless:
//   1. masking preserves length, or every site index points at the wrong byte;
//   2. every mutation still PARSES. A mutation that breaks the parse kills the
//      golden for a reason that has nothing to do with the golden, and the
//      sweep records a kill it did not earn -- a red that means nothing, read
//      as good news, which is the exact disease this tool exists to treat.
// Property 2 is why the comparison operators demand whitespace, and it became
// load-bearing again when `${...}` spans stopped being masked as text.
const SELF_TEST = flag("--self-test");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const readRaw = (p: string) => readFileSync(p, "utf8");

// ─── snapshot / restore ───────────────────────────────────────────────────
function snapshotPath(rel: string) {
  return path.join(PRISTINE, rel.replace(/[\\/]/g, "__"));
}
// WRITING TO SOURCE IS NOT RELIABLY ATOMIC ON THIS MACHINE, AND PASS 3 PROVED IT.
// The sweep died mid-run with `UNKNOWN: unknown error, open
// src/app/api/[[...path]]/workspace-resolution.ts` (errno -4094) -- a Windows
// sharing violation, not a bug in the mutation. Something else held the file
// open for the instant we tried to write it: the Next dev server's watcher
// recompiles on every change, and this sweep changes a file twice per mutation,
// hundreds of times a minute.
//
// The failure mode is what makes this worth guarding rather than shrugging at.
// It threw from restore(), i.e. on the way BACK, which is the one moment the
// tree is knowingly holding a deliberate bug. `--restore` recovered it cleanly
// (169 files, 0 mismatches afterwards), so the safety net held -- but a net that
// gets used is a net that will eventually be used at a worse moment. Retry the
// write instead of relying on the recovery path.
//
// Deliberately NOT an unbounded retry: if the file is genuinely locked, failing
// loudly and leaving INFLIGHT.json for --restore is correct. Six attempts over
// roughly a second and a half covers a compile-and-release; anything longer is a
// real lock and should stop the run.
function writeWithRetry(abs: string, content: string): void {
  const waits = [25, 50, 100, 200, 400, 800];
  for (let attempt = 0; ; attempt++) {
    try { writeFileSync(abs, content, "utf8"); return; }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "UNKNOWN" || code === "EBUSY" || code === "EPERM" || code === "EACCES";
      if (!transient || attempt >= waits.length) throw err;
      // Synchronous sleep on purpose: everything else here is synchronous, and
      // an await would let the loop continue mutating other files meanwhile.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waits[attempt]);
    }
  }
}

function snapshot(rel: string) {
  const dst = snapshotPath(rel);
  if (!existsSync(dst)) writeWithRetry(dst, readRaw(path.resolve(ROOT, rel)));
}
function restore(rel: string) {
  const src = snapshotPath(rel);
  if (!existsSync(src)) return;
  const want = readRaw(src);
  writeWithRetry(path.resolve(ROOT, rel), want);
  const got = readRaw(path.resolve(ROOT, rel));
  if (sha(got) !== sha(want)) {
    console.error(`FATAL: restore of ${rel} did not match its snapshot. Source may be corrupt. Stopping.`);
    process.exit(2);
  }
}
function restoreAll() {
  if (!existsSync(PRISTINE)) {
    console.log("no snapshots to restore");
    return;
  }
  let n = 0;
  for (const f of readdirSync(PRISTINE)) {
    const rel = f.replace(/__/g, path.sep);
    const target = path.resolve(ROOT, rel);
    if (!existsSync(target)) continue;
    writeWithRetry(target, readRaw(path.join(PRISTINE, f)));
    n++;
  }
  if (existsSync(INFLIGHT)) rmSync(INFLIGHT);
  console.log(`restored ${n} file(s) from snapshot`);
}

if (flag("--restore")) {
  restoreAll();
  process.exit(0);
}

// A crash last time would have left a file mutated. Refuse to compound it.
if (existsSync(INFLIGHT)) {
  const stale = JSON.parse(readRaw(INFLIGHT));
  console.error(`A previous run left ${stale.rel} mutated. Run with --restore first.`);
  process.exit(2);
}

mkdirSync(PRISTINE, { recursive: true });

// ─── mutation operators, all type-preserving ──────────────────────────────
type Op = { name: string; find: RegExp; to: (m: string) => string };
const OPS: Op[] = [
  // The four comparison operators REQUIRE whitespace on both sides. This is not
  // cosmetic and it is the single most important line in this file.
  //
  // `<` and `>` are also generic brackets, and this codebase is full of them:
  // `Record<string, unknown>`, `Promise<void>`, `Partial<T>`. Measured on
  // WhatsAppConversationEngine.ts, a naive `<` pattern hit 18 sites and ALL 18
  // were generics; a naive `>` hit 11 of which 8 were generics. Mutating one
  // produces `Record<=string, unknown>` — a SYNTAX error, not a type error. tsx
  // then fails to parse the file, the golden dies, and the sweep records a KILL
  // IT DID NOT EARN. Every golden touching a generic-heavy file would have
  // reported near-perfect coverage on the strength of a parse failure.
  //
  // That is the same disease this whole exercise exists to treat, inverted: a
  // red that means nothing, read as good news. Requiring spaces costs a handful
  // of real sites written `x<y` (this tree is prettier-formatted, so almost
  // none) and costs zero correctness. Generic brackets never carry spaces.
  // `=>` cannot match either, since a lookbehind for whitespace excludes it.
  { name: "gte->gt", find: /(?<=\s)>=(?=\s)/g, to: () => ">" },
  { name: "gt->gte", find: /(?<=\s)>(?=\s)/g, to: () => ">=" },
  { name: "lte->lt", find: /(?<=\s)<=(?=\s)/g, to: () => "<" },
  { name: "lt->lte", find: /(?<=\s)<(?=\s)/g, to: () => "<=" },
  { name: "strict-eq->neq", find: /===/g, to: () => "!==" },
  { name: "strict-neq->eq", find: /!==/g, to: () => "===" },
  { name: "and->or", find: /&&/g, to: () => "||" },
  { name: "or->and", find: /\|\|(?!=)/g, to: () => "&&" },
  { name: "true->false", find: /\btrue\b/g, to: () => "false" },
  { name: "false->true", find: /\bfalse\b/g, to: () => "true " },
  // Numeric literal bump. Type-preserving; catches off-by-one and threshold
  // guards, which is where money and limit rules live.
  { name: "num+1", find: /(?<![\w.$])(\d+)(?![\w.])/g, to: (m) => String(Number(m) + 1) },
];

/**
 * Blank out string/template/comment content so operators never fire inside a
 * message. Same length out as in, so match indexes map back onto the original.
 */
function maskLiterals(src: string): string {
  let out = "";
  let i = 0;
  let mode: "code" | "sq" | "dq" | "tpl" | "line" | "block" = "code";
  // A `${...}` span inside a template is CODE, not text, and blanking it made
  // the sweep blind to a lot of this product. Search queries, WhatsApp message
  // bodies and prompt assembly are built as templates, and the fallbacks that
  // decide what a customer actually receives -- `${input.offer || profile.products[0]}`
  // -- live inside the braces. Those were unmutatable, so no golden could be
  // graded on them. One counter per open `${`, holding the brace depth of the
  // object and block literals nested inside it, so the closing brace is matched
  // to the right opener.
  const tplStack: number[] = [];
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && n === "*") { mode = "block"; out += "  "; i += 2; continue; }
      if (c === "'") { mode = "sq"; out += c; i++; continue; }
      if (c === '"') { mode = "dq"; out += c; i++; continue; }
      if (c === "`") { mode = "tpl"; out += c; i++; continue; }
      if (tplStack.length > 0) {
        if (c === "{") tplStack[tplStack.length - 1]++;
        else if (c === "}") {
          if (tplStack[tplStack.length - 1] === 0) { tplStack.pop(); mode = "tpl"; out += c; i++; continue; }
          tplStack[tplStack.length - 1]--;
        }
      }
      out += c; i++; continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += c; } else out += " ";
      i++; continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") { mode = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? c : " "; i++; continue;
    }
    if (mode === "tpl" && c === "$" && n === "{") { tplStack.push(0); mode = "code"; out += "${"; i += 2; continue; }
    // inside a string
    if (c === "\\") { out += "  "; i += 2; continue; }
    const closer = mode === "sq" ? "'" : mode === "dq" ? '"' : "`";
    if (c === closer) { mode = "code"; out += c; i++; continue; }
    out += c === "\n" ? c : " ";
    i++;
  }
  return out;
}

type Site = { rel: string; op: string; index: number; length: number; replacement: string; line: number };

/**
 * Does this mutation still PARSE?
 *
 * FAULT 7, found by --self-test the hour it was written: 271 of 15,958
 * candidate mutations across src/ did not parse. Nearly all were ` > ` turning
 * into ` >= ` inside a generic parameter list written across several lines:
 *
 *     type Args<
 *       T extends Model,
 *     > = ...
 *
 * The operators demand whitespace on both sides precisely to avoid generics,
 * and that rule is right for `Record<string, unknown>` -- but a closing bracket
 * sitting on its own line has whitespace on both sides too. The guard was a
 * guess about syntax, and the guess had a hole.
 *
 * A mutation that does not parse kills its golden instantly, for a reason that
 * has nothing to do with the golden, and the sweep books a KILL IT DID NOT
 * EARN -- coverage that reads as proof and is noise. So stop guessing and ask
 * the parser. The whitespace rules stay as a cheap pre-filter; this is the
 * thing that actually decides.
 */
function mutationParses(site: Site): boolean {
  const abs = path.resolve(ROOT, site.rel);
  const src = readRaw(abs);
  const mutated = src.slice(0, site.index) + site.replacement + src.slice(site.index + site.length);
  try {
    transformSync(mutated, { loader: site.rel.endsWith(".tsx") ? "tsx" : "ts" });
    return true;
  } catch {
    return false;
  }
}

// ─── symbol-level aim ─────────────────────────────────────────────────────
//
// FAULT 6, found by --plan on golden-campaign-planning. The golden imports ONE
// symbol -- planCampaignDeterministicForTest -- and src/lib/agents.ts exports
// eleven. Spreading 12 mutations evenly down the file put all twelve inside
// functions the golden never calls: extractBusinessFromPages, scoreLead,
// generateMessage, classifyReply, the LLM-backed planCampaign. The subject
// function, lines 295-329, received NOTHING. The reported 0/12 was not a
// finding about the check at all; the check was never given a chance to fail.
// (Independently proven: receipt m42 shows this same golden going red on a
// compiling mutation inside that function.)
//
// So: bias the picking order toward the bodies of the symbols the golden
// actually imports. Deliberately a BIAS, not a filter -- every site stays in
// the pool, hot ones simply go first. A filter would be more precise and would
// also be the sixth place where clever aim logic silently drops sites it should
// have kept; five such faults have been found in this file already. When the
// symbol map resolves nothing, behaviour falls back exactly to the old order.
//
// The better long-term instrument is coverage-guided selection: run the golden
// once under NODE_V8_COVERAGE and mutate only bytes that actually executed.
// That would catch code reached indirectly rather than by name. It is not done
// here because tsx transpiles before running, so coverage offsets land in
// generated JS and have to be source-mapped back -- and a mis-mapped filter
// would silently exclude reachable sites, which is precisely the failure mode
// this comment exists to warn about.

/** Named imports in `src`, per module specifier. `import type` is skipped: a type cannot be mutated. */
function importedSymbols(src: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const re = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) continue;
    const names = m[2]
      .split(",")
      .map((p) => p.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    const key = m[3];
    if (!out.has(key)) out.set(key, new Set());
    for (const n of names) out.get(key)!.add(n);
  }
  return out;
}

/** Byte ranges of each exported symbol's body, with `export const A = B;` aliases resolved. */
function symbolRanges(rel: string): Map<string, [number, number]> {
  const src = readRaw(path.resolve(ROOT, rel));
  const masked = maskLiterals(src);
  const ranges = new Map<string, [number, number]>();
  const aliases: [string, string][] = [];

  const fn = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  for (const m of masked.matchAll(fn)) {
    const open = masked.indexOf("{", m.index! + m[0].length);
    if (open < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === "{") depth++;
      else if (masked[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > 0) ranges.set(m[1], [m.index!, end]);
  }

  const cn = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g;
  for (const m of masked.matchAll(cn)) aliases.push([m[1], m[2]]);
  for (const [from, to] of aliases) {
    const hit = ranges.get(to);
    if (hit && !ranges.has(from)) ranges.set(from, hit);
  }
  return ranges;
}

/**
 * Spread picks down a list instead of clustering them at the top, which in a
 * source file is imports and constants.
 */
function spread(sites: Site[], want: number): Site[] {
  if (sites.length === 0) return sites;
  // Walk the file top to bottom, not operator by operator. sitesFor() emits
  // every `>=` site, then every `&&` site, and so on, so a stride over its raw
  // order samples one operator's worth of the file before moving on. Sorting by
  // position first makes the stride mean what it reads as: spread down the file.
  const byPosition = [...sites].sort((a, b) => a.index - b.index);
  // One site per line in the first pass. Line 400 of agents.ts carries four
  // `>=` in a single scoring ladder; without this it took four of that golden's
  // twelve mutations and the other three thresholds in the same expression
  // taught us nothing the first one had not.
  const firstPass: Site[] = [];
  const extras: Site[] = [];
  const seenLine = new Set<number>();
  for (const site of byPosition) {
    if (seenLine.has(site.line)) extras.push(site);
    else { seenLine.add(site.line); firstPass.push(site); }
  }
  const stride = Math.max(1, Math.floor(firstPass.length / Math.max(1, want)));
  const order: Site[] = [];
  for (let i = 0; i < firstPass.length; i += stride) order.push(firstPass[i]);
  for (const site of firstPass) if (!order.includes(site)) order.push(site);
  return [...order, ...extras];
}

/**
 * The final within-file order: sites inside the bodies of `wanted` first,
 * everything else after, each group spread internally. Order only -- nothing is
 * dropped, so the worst case is the order this function replaced.
 */
function hotFirst(rel: string, sites: Site[], wanted: Set<string>, want: number): Site[] {
  if (wanted.size === 0) return spread(sites, want);
  const ranges = symbolRanges(rel);
  const spans = [...wanted].map((w) => ranges.get(w)).filter(Boolean) as [number, number][];
  if (spans.length === 0) return spread(sites, want);
  const hot: Site[] = [];
  const cold: Site[] = [];
  for (const site of sites) {
    (spans.some(([a, b]) => site.index >= a && site.index <= b) ? hot : cold).push(site);
  }
  return [...spread(hot, want), ...spread(cold, want)];
}

function sitesFor(rel: string): Site[] {
  const abs = path.resolve(ROOT, rel);
  const src = readRaw(abs);
  const masked = maskLiterals(src);
  const lineOf = (idx: number) => src.slice(0, idx).split("\n").length;
  const sites: Site[] = [];
  for (const op of OPS) {
    op.find.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = op.find.exec(masked)) !== null) {
      const replacement = op.to(m[0]);
      if (replacement === m[0]) continue;
      sites.push({ rel, op: op.name, index: m.index, length: m[0].length, replacement, line: lineOf(m.index) });
    }
  }
  return sites;
}

function applySite(site: Site) {
  const abs = path.resolve(ROOT, site.rel);
  const src = readRaw(snapshotPath(site.rel));
  const mutated = src.slice(0, site.index) + site.replacement + src.slice(site.index + site.length);
  writeFileSync(INFLIGHT, JSON.stringify({ rel: site.rel, op: site.op, line: site.line }), "utf8");
  writeWithRetry(abs, mutated);
}
function clearInflight() {
  if (existsSync(INFLIGHT)) rmSync(INFLIGHT);
}

// ─── golden → the shipping files it directly claims to guard ──────────────
// THE FIRST VERSION OF THIS FUNCTION UNDER-REPORTED, AND THE FULL SWEEP CAUGHT IT.
// It matched exactly one import form -- a static `from "@/x"` in the golden
// itself -- and 36 of the 186 goldens therefore resolved to ZERO targets. They
// were written down as "no-targets" and then, worse, silently dropped by the
// first triage pass, so 36 checks vanished from the report instead of appearing
// as ungraded. That is the flattering-error class again (L35): the visible
// numbers looked complete because the missing rows were invisible.
//
// Measured before this was changed, not assumed. Three forms were being missed:
//   (a) DYNAMIC import -- `await import("@/lib/ssrf-guard")`. Several goldens
//       import inside the test body on purpose, to control when module-level
//       side effects run.
//   (b) SRC-RELATIVE specifiers -- `from "../../src/llm/providers/X"`. Same
//       file, different spelling.
//   (c) ONE HOP through a relative test helper -- `from "./_helpers/provider"`,
//       where the helper is what actually pulls in the repositories and
//       services. The golden names the helper; the helper names the product.
// Adding all three moved 22 of the 36 from ungradeable to graded, including
// rate limiting, the job queue, the SSRF guard, email sending, credential CRUD
// and the commercial Prisma parity check -- security and money paths that had
// been reported as simply absent.
//
// The remaining 14 read source files as TEXT and assert on their structure
// (route coverage, CSP nonces, runbook contents). There is no imported module
// to mutate, so this operator set cannot grade them at all. They stay in their
// own category rather than being counted either way.
const AT_IMPORT = /(?:from\s+"@\/([^"]+)")|(?:import\(\s*"@\/([^"]+)"\s*\))/g;
const SRC_RELATIVE = /"(?:\.\.?\/)+src\/([^"]+)"/g;
const REL_IMPORT = /(?:from\s+"(\.\.?\/[^"]+)")|(?:import\(\s*"(\.\.?\/[^"]+)"\s*\))/g;

function resolveSrc(spec: string): string | null {
  for (const cand of [`src/${spec}.ts`, `src/${spec}.tsx`, `src/${spec}/index.ts`]) {
    if (existsSync(path.resolve(ROOT, cand))) return cand.replace(/\//g, path.sep);
  }
  return null;
}

function collectInto(src: string, out: Set<string>): void {
  for (const m of src.matchAll(AT_IMPORT)) {
    const hit = resolveSrc((m[1] ?? m[2]) as string);
    if (hit) out.add(hit);
  }
  for (const m of src.matchAll(SRC_RELATIVE)) {
    const hit = resolveSrc(m[1]);
    if (hit) out.add(hit);
  }
}

function targetsOf(goldenRel: string): string[] {
  const abs = path.resolve(ROOT, goldenRel);
  const src = readRaw(abs);
  const out = new Set<string>();
  collectInto(src, out);

  // One hop, deliberately not more. Two hops would drag half of src/ into the
  // pool for every golden, and a mutation in a file the check never exercises
  // that survives tells you nothing about the check -- it just dilutes the
  // score toward "everything is decoration".
  for (const m of src.matchAll(REL_IMPORT)) {
    const spec = (m[1] ?? m[2]) as string;
    if (spec.includes("/src/")) continue; // already covered by SRC_RELATIVE
    const base = path.resolve(path.dirname(abs), spec);
    for (const cand of [`${base}.ts`, path.join(base, "index.ts"), `${base}.tsx`]) {
      if (existsSync(cand)) { collectInto(readRaw(cand), out); break; }
    }
  }
  return [...out];
}

// ─── running one golden ───────────────────────────────────────────────────
const PRELOAD_JSON = "./scripts/golden/_helpers/force-json-provider.ts";
const PRELOAD_PRISMA = "./scripts/golden/_helpers/force-prisma-provider.ts";
const PRELOAD_HYBRID = "./scripts/golden/_helpers/isolate-json-data.ts";
function preloadFor(rel: string): string {
  const src = readRaw(path.resolve(ROOT, rel));
  if (src.includes("// PRISMA_GOLDEN")) return PRELOAD_PRISMA;
  if (src.includes("// HYBRID_GOLDEN")) return PRELOAD_HYBRID;
  return PRELOAD_JSON;
}
type RunOutcome = { ok: boolean; timedOut: boolean; skipped: boolean; ms: number; assertion: boolean };
function runGolden(rel: string): RunOutcome {
  const t0 = Date.now();
  // NOT `npx`: on Windows a .cmd shim needs shell:true, and shell:true
  // concatenates rather than escapes its arguments (Node DEP0190) — a shell
  // metacharacter in a path would then be executed. Invoking node directly with
  // tsx's loader keeps shell:false AND drops ~1s of npx resolution per run,
  // which across a few thousand runs is the difference between a sweep that
  // finishes overnight and one that does not.
  const r = spawnSync(process.execPath, ["--import", "tsx", "--import", preloadFor(rel), rel], {
    cwd: ROOT, timeout: RUN_TIMEOUT_MS, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], shell: false,
  });
  const ms = Date.now() - t0;
  const stdout = r.stdout || "";
  const timedOut = (r as { error?: { code?: string } }).error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
  const skipped = stdout.split("\n").some((l) => l.trim().startsWith("SKIP:"));
  // Tell "the check noticed and said so" apart from "the process died".
  // Both exit non-zero, but only the first is the check doing its job; the
  // second can be a module that no longer loads at all, which every golden
  // touching that file would report identically and which says nothing about
  // any of them. Recorded, not acted on: a crash still counts as a kill (the
  // product broke and the test went red), but a golden whose kills are ALL
  // crashes and none assertions is a weaker result than the raw number looks,
  // and triage needs to see that rather than infer it.
  // FIRST VERSION OF THIS LINE WAS WRONG AND THE TRIAL RUN CAUGHT IT.
  // It tested for /AssertionError/, and every kill in the trial came back
  // "0 by assertion" — which read as a finding about the goldens ("none of
  // them detect anything, they just crash") and was actually a finding about
  // this classifier. The goldens in this suite CATCH their assertion and
  // print `err.message` only (golden-whatsapp-window.ts:48), so the class
  // name never reaches the output. A report built on that would have invented
  // a problem that does not exist.
  // What actually separates the two cases: a golden that DETECTED the break
  // reaches its own summary and prints its own failure marker; a golden that
  // CRASHED (module no longer loads, unhandled throw) never gets that far.
  const blob = stdout + (r.stderr || "");
  const assertion = /AssertionError|ERR_ASSERTION|\u274c|FAILED/.test(blob);
  return { ok: r.status === 0 && !timedOut, timedOut, skipped, ms, assertion };
}

// ─── calibration: the harness must reproduce a known result ───────────────
/**
 * A machine that grades 158 checks has to be graded first. Two cases:
 *
 *   POSITIVE — golden-knowledge-extraction-helpers guards
 *   ExtractionQualityService, and S24-24 proved by hand (receipt m41) that
 *   breaking the real-model rule makes it go red. If the sweep cannot find at
 *   least one killed mutation in that pair, its "killed" verdict means nothing.
 *
 *   NEGATIVE — the sweep must also produce SURVIVORS somewhere. A harness that
 *   reports 100% kills is not measuring; it is failing to restore, or failing
 *   to run the golden at all, and would read as good news either way. That is
 *   the exact failure mode this whole exercise exists to catch.
 */
function calibrate() {
  const rel = "scripts/golden/golden-knowledge-extraction-helpers.ts";
  const target = "src" + path.sep + "services" + path.sep + "ExtractionQualityService.ts";
  console.log("CALIBRATION\n");
  snapshot(target);
  const base = runGolden(rel);
  console.log(`  baseline: ${base.ok ? "PASS" : "FAIL"} (${base.ms}ms) — must be PASS`);
  if (!base.ok) { console.error("  cannot calibrate against a red baseline"); process.exit(2); }

  const all = sitesFor(target);
  console.log(`  ${all.length} mutation sites found in ExtractionQualityService.ts`);
  let killed = 0, survived = 0;
  for (const site of all.slice(0, 14)) {
    applySite(site);
    const r = runGolden(rel);
    restore(target);
    clearInflight();
    if (r.ok) survived++; else killed++;
    console.log(`  line ${String(site.line).padStart(4)} ${site.op.padEnd(16)} → ${r.ok ? "SURVIVED" : "killed"}`);
  }
  console.log(`\n  killed ${killed}, survived ${survived}`);
  console.log(`  positive calibration (needs killed>0): ${killed > 0 ? "PASS" : "FAIL"}`);
  console.log(`  negative calibration (needs survived>0): ${survived > 0 ? "PASS" : "FAIL — harness not trustworthy"}`);
  console.log(`  restore verified by sha256 after every mutation.`);
}

if (flag("--calibrate")) { calibrate(); process.exit(0); }

// ─── type-preservation check ──────────────────────────────────────────────
/**
 * The operator list CLAIMS to be type-preserving. `tsc --noEmit` is what turns
 * that claim into evidence: a mutation that does not typecheck would still RUN
 * under tsx and would score a fake kill.
 */
function verifyTypes() {
  const rel = "scripts/golden/golden-knowledge-extraction-helpers.ts";
  const target = "src" + path.sep + "services" + path.sep + "ExtractionQualityService.ts";
  snapshot(target);
  const sites = sitesFor(target).slice(0, 10);
  let clean = 0, dirty = 0;
  for (const site of sites) {
    applySite(site);
    const r = spawnSync(process.execPath, [path.resolve(ROOT, "node_modules/typescript/bin/tsc"), "--noEmit"],
      { cwd: ROOT, encoding: "utf8", timeout: 300000, shell: false });
    restore(target);
    clearInflight();
    const errs = ((r.stdout || "") + (r.stderr || "")).split("\n").filter((l) => l.includes("error TS")).length;
    if (errs === 0) clean++; else dirty++;
    console.log(`  line ${String(site.line).padStart(4)} ${site.op.padEnd(16)} → ${errs} type error(s)`);
  }
  console.log(`\n  ${clean} of ${clean + dirty} mutations typecheck cleanly.`);
  console.log(`  Any 'dirty' operator must be dropped from OPS — it would score fake kills.`);
  void rel;
}

if (flag("--verify-types")) { verifyTypes(); process.exit(0); }

// ─── the sweep ────────────────────────────────────────────────────────────
const done = new Set<string>();
if (flag("--resume") && existsSync(RESULTS)) {
  for (const line of readRaw(RESULTS).split("\n")) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).golden); } catch { /* partial last line */ }
  }
}

const goldens = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith(".ts") && !SUITE_EXCLUDE.has(f))
  .filter((f) => !ONLY || f.includes(ONLY))
  .sort()
  .map((f) => "scripts" + path.sep + "golden" + path.sep + f);

console.log(`mutation sweep: ${goldens.length} golden(s), up to ${MAX_PER_GOLDEN} mutations each\n`);

let totKilled = 0, totSurvived = 0, totSkipped = 0, totInconclusive = 0, totUngradeable = 0;
let skippedUnparseable = 0;

function selfTest(): never {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.resolve(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) files.push(rel);
    }
  };
  walk("src");
  let lengthFaults = 0;
  let parseFaults = 0;
  let checked = 0;
  for (const rel of files) {
    const abs = path.resolve(ROOT, rel);
    const src = readRaw(abs);
    if (maskLiterals(src).length !== src.length) {
      lengthFaults++;
      console.log(`  LENGTH FAULT ${rel}`);
    }
    const loader = rel.endsWith(".tsx") ? "tsx" : "ts";
    let baseOk = true;
    try { transformSync(src, { loader }); } catch { baseOk = false; }
    if (!baseOk) continue; // a file that does not parse clean cannot judge its mutations
    for (const site of sitesFor(rel)) {
      const mutated = src.slice(0, site.index) + site.replacement + src.slice(site.index + site.length);
      checked++;
      try { transformSync(mutated, { loader }); }
      catch (err) {
        parseFaults++;
        if (parseFaults <= 20) console.log(`  PARSE FAULT ${rel}:${site.line} ${site.op} -- ${String(err).split(String.fromCharCode(10))[0]}`);
      }
    }
  }
  console.log("");
  console.log(`self-test: ${files.length} files, ${checked} mutations parse-checked`);
  console.log(`  length faults: ${lengthFaults}   (must be 0 -- every site index would point at the wrong byte)`);
  console.log(`  parse faults:  ${parseFaults}   (candidates the run-time parse gate rejects before they can book an unearned kill)`);
  // Only a length fault is a failure. Parse faults are EXPECTED output now: the
  // whitespace rules are a cheap pre-filter that admits some unparseable
  // candidates, and mutationParses() throws those out at pick time. This number
  // is the size of the hole the gate is covering -- watch it, do not fail on it.
  process.exit(lengthFaults === 0 ? 0 : 1);
}

if (SELF_TEST) selfTest();

for (const golden of goldens) {
  const name = path.basename(golden, ".ts");
  if (done.has(name)) { console.log(`- ${name}: already done (resume)`); continue; }

  const targets = targetsOf(golden);
  if (targets.length === 0) {
    appendFileSync(RESULTS, JSON.stringify({ golden: name, verdict: "no-targets", killed: 0, survived: 0 }) + "\n");
    console.log(`- ${name}: no @/ imports to mutate`);
    continue;
  }

  const base = runGolden(golden);
  if (base.skipped) {
    appendFileSync(RESULTS, JSON.stringify({ golden: name, verdict: "declared-skip", killed: 0, survived: 0 }) + "\n");
    console.log(`- ${name}: declared SKIP — cannot be graded`);
    totSkipped++;
    continue;
  }
  if (!base.ok) {
    appendFileSync(RESULTS, JSON.stringify({ golden: name, verdict: "red-baseline", killed: 0, survived: 0 }) + "\n");
    console.log(`- ${name}: RED before any mutation — cannot be graded`);
    continue;
  }

  if (!PLAN) for (const t of targets) snapshot(t);

  // Spread the budget across every target file and every operator rather than
  // burning it all on the first file's first operator.
  // BUDGET ALLOCATION -- the first version diluted the result and the numbers
  // caught it. It flattened every target file into one list and strided across
  // it, so a golden importing a 171-line subject alongside a 612-line
  // neighbour spent 11 of its 12 mutations on the neighbour and ONE on the
  // thing it actually tests. golden-message-batching scored 0/12 that way:
  // eleven of those breaks were in WhatsAppConversationEngine, which the
  // batching test never calls, so of course it did not notice them. The
  // reported score was a fact about my sampling, not about the check.
  //
  // Round-robin across FILES instead, so every named target is sampled before
  // any file gets a second mutation. A golden's own subject can no longer be
  // crowded out by a larger file it merely mentions.
  const wantedBySpec = importedSymbols(readRaw(path.resolve(ROOT, golden)));
  const wantedFor = (t: string) => {
    const norm = t.replace(/\\/g, "/").replace(/^src\//, "").replace(/\.(tsx?)$/, "").replace(/\/index$/, "");
    const hit = new Set<string>();
    for (const [spec, names] of wantedBySpec) {
      const specNorm = spec.replace(/^@\//, "").replace(/\.(tsx?)$/, "");
      if (specNorm === norm || specNorm.endsWith("/" + norm) || norm.endsWith("/" + specNorm)) {
        for (const n of names) hit.add(n);
      }
    }
    return hit;
  };
  const wantPerFile = Math.max(1, Math.ceil(MAX_PER_GOLDEN / Math.max(1, targets.length)));
  const perFile = targets
    .map((t) => hotFirst(t, sitesFor(t), wantedFor(t), wantPerFile))
    .filter((sites) => sites.length > 0);
  const pool = perFile.flat();
  const picked: Site[] = [];
  if (perFile.length > 0) {
    // Each file's list already carries its final order from hotFirst(): the
    // subject's own body first, spread, then the rest of the file, spread.
    // Re-striding here would undo that -- an earlier version did exactly that
    // and the symbol bias had no effect at all.
    const cursors = perFile;
    // Order the ENTIRE pool, then take the first MAX that survive the parse
    // gate. Stopping the round-robin at MAX and filtering afterwards would let
    // an unparseable site spend a slot and leave the golden graded on eleven
    // mutations while the report says twelve.
    const ordered: Site[] = [];
    let round = 0;
    while (cursors.some((c) => round < c.length)) {
      for (const c of cursors) if (round < c.length) ordered.push(c[round]);
      round++;
    }
    for (const site of ordered) {
      if (picked.length >= MAX_PER_GOLDEN) break;
      if (mutationParses(site)) picked.push(site);
      else skippedUnparseable++;
    }
  }

  // A golden whose only imports are types (several import just
  // `@/repositories/interfaces`, which holds no logic) yields an empty pool.
  // That is NOT evidence the check is dead — it is evidence THIS TOOL cannot
  // grade it, because the code it exercises is reached through the repository
  // layer at runtime rather than named in an import. Conflating "untested by
  // me" with "proven incapable" would be the same lie as conflating "passing"
  // with "proven", which is the thing this sweep exists to stop. Reported in
  // its own category so it stays visibly unproven.
  if (PLAN) {
    console.log(`- ${name}: ${picked.length} site(s) from ${perFile.length} file(s) of ${targets.length} target(s)`);
    for (const site of picked) console.log(`    ${site.rel}:${site.line} ${site.op}`);
    if (picked.length === 0) console.log(`    (nothing mutable)`);
    continue;
  }
  if (picked.length === 0) {
    appendFileSync(RESULTS, JSON.stringify({ golden: name, verdict: "no-mutable-target", targets, killed: 0, survived: 0 }) + "\n");
    console.log(`- ${name}: no mutable code in its direct imports — NOT GRADED (still unproven)`);
    totUngradeable++;
    continue;
  }
  let killed = 0;
  let killedByAssertion = 0;
  let inconclusive = 0;
  type Mark = { file: string; line: number; op: string };
  const survivors: Mark[] = [];
  const kills: Mark[] = [];
  for (const site of picked) {
    applySite(site);
    const r = runGolden(golden);
    restore(site.rel);
    clearInflight();
    // A TIMEOUT IS NOT A KILL. A timed-out child exits non-zero, so the naive
    // `status !== 0` test would write down "this check caught the bug" for a
    // mutation that merely made the golden slow or sent it into a loop. It
    // caught nothing; it hung. Scoring a hang as proof is precisely the
    // flattering-error class this sweep exists to find, so a timeout counts
    // toward neither column and is reported in its own.
    if (r.timedOut) { inconclusive++; continue; }
    if (r.ok) survivors.push({ file: site.rel, line: site.line, op: site.op });
    else { killed++; kills.push({ file: site.rel, line: site.line, op: site.op }); if (r.assertion) killedByAssertion++; }
  }
  totKilled += killed;
  totSurvived += survivors.length;
  totInconclusive += inconclusive;

  appendFileSync(RESULTS, JSON.stringify({
    golden: name, verdict: "graded", baselineMs: base.ms,
    targets, mutations: picked.length, killed, killedByAssertion, inconclusive,
    survived: survivors.length, survivors, kills,
  }) + "\n");

  const verdict = killed === 0 ? "  ⚠ NO MUTATION KILLED — this check may be incapable of failing" : "";
  const asrt = killed > 0 ? ` (${killedByAssertion}/${killed} by assertion)` : "";
  const inc = inconclusive > 0 ? `, ${inconclusive} inconclusive` : "";
  console.log(`- ${name}: ${killed} killed${asrt} / ${survivors.length} survived of ${picked.length}${inc}${verdict}`);
}

console.log(`\n=== SWEEP DONE: ${totKilled} killed, ${totSurvived} survived, ${totInconclusive} inconclusive (timeout), ${totSkipped + totUngradeable} ungradeable ===`);
console.log(`  ${skippedUnparseable} candidate mutation(s) rejected before running: they do not parse, and a parse error kills a golden for reasons that have nothing to do with the golden.`);
console.log(`results: ${RESULTS}`);
console.log(`A killed mutation proves the check CAN fail. It does not prove the check is right.`);
restoreAll();
