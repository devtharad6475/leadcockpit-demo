/**
 * golden-acceptance-harness-intact.ts — N-TEST-7, raised 2026-08-24 (S15-4),
 * built 2026-08-24 (S16-1).
 *
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------
 * `scripts/acceptance/run-ten-company-acceptance.ts` is the CEO's A5/A6
 * acceptance run — ten invented companies, each imported through the product's
 * own service layer, each then talked to as a customer on the REAL model. It
 * scored 60/60 on 2026-08-19 and it is the single strongest piece of evidence
 * in this repository.
 *
 * It is also a PHOTOGRAPH, not a test. It makes real, paid model calls and takes
 * ~131 seconds, so it deliberately does NOT belong in `run-all-goldens.ts` — a
 * regression suite that costs money and needs the network is a suite people stop
 * running. That is the right call, and it leaves a hole: nothing notices if the
 * harness quietly stops being able to prove anything.
 *
 * WHAT THIS GOLDEN IS, AND WHAT IT IS DELIBERATELY NOT
 * ----------------------------------------------------
 * It does NOT run the acceptance run, does NOT call a model, and does NOT touch
 * the network. It cannot tell you that the AI still answers correctly — only the
 * expensive run can, and only on the day it is run.
 *
 * What it CAN do is guard the properties that would make that expensive run
 * meaningless while still printing a reassuring "60/60":
 *
 *   1. Ten companies still exist, in ten DIFFERENT industries. The whole point
 *      of ten is breadth; ten personas that drifted into one trade would prove
 *      what one persona proves.
 *   2. Every persona still carries BOTH honest and adversarial turns. A5 without
 *      A6 is half the CEO's sentence, and A6 is the half that catches the model
 *      agreeing with a customer who is wrong.
 *   3. All SEVEN graders are still wired into the grading function. A grader
 *      that is deleted does not fail — it silently stops being able to fail,
 *      and the score goes UP. (G1 real model · G2 grounded · G3 not echoed ·
 *      G4 asks back · G5 held for a human · G6 no invented numbers · G7 no
 *      cross-tenant leak.)
 *   4. `enableMockFallback` is still FALSE. This is the one that matters most.
 *      If the mock is ever allowed back in, the run scores 60/60 against canned
 *      strings and reports it in exactly the same words. A green that cannot go
 *      red is worse than no green at all.
 *   5. The fake contacts are still unroutable by construction (N-SAFETY-1).
 *   6. The run is still DISCOVERABLE — `npm run acceptance:ten` exists. Before
 *      S16-1 there was no npm script at all: the most important artefact in the
 *      repo was reachable only by someone who already knew the file path.
 *
 * WHY THE SOURCE IS COMMENT-STRIPPED BEFORE SCANNING
 * --------------------------------------------------
 * The S11-1 lesson, learned the hard way and repeated at S14-1: a golden that
 * scans source will happily match the banned pattern quoted inside the comment
 * explaining why it is banned. This very docblock contains the string
 * `enableMockFallback` several times. A golden that reads comments is not
 * reading the product.
 */

// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

const HARNESS = path.join(process.cwd(), "scripts", "acceptance", "run-ten-company-acceptance.ts");
const PERSONAS_FILE = path.join(process.cwd(), "scripts", "acceptance", "personas.ts");
const PKG = path.join(process.cwd(), "package.json");

/**
 * Strip block and line comments so every scan below reads the code and not the
 * documentation. Deliberately simple: these two files contain no regex literal
 * or string that would confuse it, and a real parser here would be more code
 * than the thing it guards.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const harnessSrc = () => stripComments(fs.readFileSync(HARNESS, "utf8"));
const personasSrc = () => stripComments(fs.readFileSync(PERSONAS_FILE, "utf8"));

let failed = 0;
process.on("exit", (code) => {
  if (failed > 0 && code === 0) process.exitCode = 1;
});

test("CASE A — ten personas, ten DIFFERENT industries, all invented", async () => {
  const { PERSONAS } = await import("../acceptance/personas");

  assert.strictEqual(
    PERSONAS.length,
    10,
    `the CEO asked for TEN companies by name ("ten different customers or ten different companies"). ` +
      `Found ${PERSONAS.length}. If the count changes deliberately, change it here and say why in CEO-LOOP-STATUS.md.`,
  );

  const ids = PERSONAS.map((p) => p.id);
  assert.strictEqual(new Set(ids).size, 10, `two personas share an id: ${ids.join(", ")}`);

  // Breadth is the entire reason there are ten. Before this run the product had
  // only ever been exercised against one company, in textiles — a model that
  // looks grounded on one trade may simply be good at that trade.
  const industries = PERSONAS.map((p) => p.industry.toLowerCase().trim());
  assert.strictEqual(
    new Set(industries).size,
    10,
    `ten personas must be in ten DIFFERENT industries, found ${new Set(industries).size} distinct: ${industries.join(" | ")}`,
  );

  for (const p of PERSONAS) {
    assert.ok(p.company.companyName.trim().length > 0, `${p.id} has no company name`);
    assert.ok(
      p.knowledge.length > 0,
      `${p.id} carries no knowledge documents — the commercial facts (price, MOQ, lead time) are what the ` +
        `retrieval layer has to find. A persona with none can only be asked questions it cannot answer.`,
    );
    assert.ok(
      p.knownNumbers.length > 0,
      `${p.id} declares no knownNumbers, so the G6 invented-number detector has nothing to compare against ` +
        `and cannot fail for this persona`,
    );
  }
});

test("CASE B — every persona is asked BOTH honest and wrong-on-purpose questions", async () => {
  const { PERSONAS } = await import("../acceptance/personas");

  for (const p of PERSONAS) {
    const truthful = p.turns.filter((t) => t.kind === "truthful");
    const adversarial = p.turns.filter((t) => t.kind === "adversarial");

    assert.ok(
      truthful.length > 0,
      `${p.id} has no truthful turns — A5 asks whether the system answers correctly from the company's own data`,
    );
    // A6 is the half the CEO was most specific about: "it is not necessary that
    // always you are going to tell it the right thing." A persona with no
    // adversarial turn can never catch the model agreeing with a false claim.
    assert.ok(
      adversarial.length > 0,
      `${p.id} has NO adversarial turns. A5 without A6 is half the CEO's sentence, and A6 is the half that ` +
        `catches the system accepting wrong input silently.`,
    );

    // An adversarial turn that asserts nothing false and demands nothing back is
    // just another honest question wearing a label.
    for (const t of adversarial) {
      const bites = Boolean(t.mustNotMention?.length) || t.mustAskFollowUp === true || t.mustHoldForHuman === true;
      assert.ok(
        bites,
        `${p.id}/${t.id} is marked adversarial but asserts no mustNotMention, requires no follow-up question ` +
          `and requires no human hold — so nothing about it can fail. Either give it teeth or call it truthful.`,
      );
    }

    for (const t of p.turns) {
      assert.ok(t.ask.trim().length > 0, `${p.id}/${t.id} has an empty customer message`);
      assert.ok(
        t.why.trim().length > 0,
        `${p.id}/${t.id} has no 'why' — a turn nobody can explain is a turn nobody can judge`,
      );
    }
  }

  const totalTurns = PERSONAS.reduce((n, p) => n + p.turns.length, 0);
  assert.ok(
    totalTurns >= 60,
    `the recorded acceptance result is 60/60 turns; the harness now carries ${totalTurns}. ` +
      `Fewer turns than the number on the status board means the board is quoting a run that can no longer happen.`,
  );
});

test("CASE C — all SEVEN graders are still wired, and none can be silently deleted", () => {
  const src = harnessSrc();

  // A deleted grader does not fail. It stops being ABLE to fail, and the score
  // goes up. That is why each one is pinned by the string it pushes on failure.
  //
  // SEVEN, not six. The first draft of this golden pinned G1-G6 because the
  // harness docblock's numbered list was read as ending at G6 — G7 NO TENANT
  // LEAK is documented a few lines further down and was missed. It is the one
  // grader that is not about answer quality at all: ten tenants live in one
  // process during this run, so it asserts a reply never names another
  // persona's company. Caught by grepping every `failures.push` rather than
  // trusting the prose above it, which is the general lesson.
  const GRADERS = ["G1", "G2", "G3", "G4", "G5", "G6", "G7"] as const;
  for (const g of GRADERS) {
    const pattern = new RegExp(`failures\\.push\\(\\s*\`?['"\`]?${g}\\b`);
    assert.match(
      src,
      pattern,
      `grader ${g} no longer pushes a failure anywhere in the harness. A grader that cannot fail is not a grader — ` +
        `removing one RAISES the score, which is the opposite of what a red test looks like.`,
    );
  }

  // G1 is the load-bearing one: it is what makes every other grader a statement
  // about the real model rather than about a canned string.
  assert.match(
    src,
    /result\.llm\.mode\s*!==\s*"real"/,
    `G1 must assert the reply came from a REAL model call (result.llm.mode !== "real"). Without it the whole ` +
      `run can pass against mock output and report the same 60/60.`,
  );
  assert.match(
    src,
    /result\.llm\.fallbackUsed/,
    `G1 must also reject a reply that fell back to the mock mid-run — mode can read "real" on a call that ` +
      `quietly degraded`,
  );
});

test("CASE D — the mock fallback is OFF, so a green run cannot be a canned string", () => {
  const src = harnessSrc();

  assert.match(
    src,
    /enableMockFallback:\s*false/,
    `the acceptance run must set enableMockFallback: false. This is the single most important line in the ` +
      `harness: with the mock available, a broken or revoked key produces a full 60/60 against canned strings ` +
      `and prints it in exactly the same words as a real pass. A green that cannot go red is worse than no green.`,
  );

  assert.doesNotMatch(
    src,
    /enableMockFallback:\s*true/,
    `something in the acceptance harness enables the mock fallback. Nothing in this run may be allowed to ` +
      `answer from a canned string.`,
  );
});

test("CASE E — every invented contact is unroutable by construction (N-SAFETY-1)", () => {
  const src = personasSrc();

  // The rule is structural, not a promise: the phone helper builds numbers in an
  // unused block, and domains are RFC 2606. Nothing here can reach a person if a
  // stub is ever swapped for a live sender by accident.
  assert.match(
    src,
    /\+91 00000 000\$\{/,
    `personas.ts must build phone numbers from the unused +91 00000 000NN block (N-SAFETY-1). Real-looking ` +
      `numbers in a fixture are one swapped stub away from messaging a stranger.`,
  );

  const emails = src.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  assert.ok(emails.length > 0, "expected persona contact emails to be present at all");
  for (const e of emails) {
    assert.ok(
      /\.example$|@example\.com$/i.test(e),
      `persona email "${e}" is not an RFC 2606 reserved domain. Every invented address must be undeliverable ` +
        `by construction, not merely unlikely to exist.`,
    );
  }

  const urls = src.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  for (const u of urls) {
    assert.ok(
      /\.example(\/|$)|example\.com(\/|$)/i.test(u),
      `persona website "${u}" points at a domain that could belong to someone. Use an RFC 2606 domain.`,
    );
  }
});

test("CASE F — the run is discoverable: `npm run acceptance:ten` exists and points at the harness", () => {
  const pkg = JSON.parse(fs.readFileSync(PKG, "utf8")) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};

  // N-TEST-7 in one assertion. Until 2026-08-24 there was NO npm script for this
  // at all: `grep -n acceptance package.json` returned nothing, and the strongest
  // evidence in the repo was reachable only by someone who already knew the path.
  const cmd = scripts["acceptance:ten"];
  assert.ok(
    cmd,
    `package.json has no "acceptance:ten" script. The CEO's A5/A6 acceptance run is the strongest evidence in ` +
      `this repository and it must not be reachable only by knowing a file path — that is how it went five ` +
      `sessions without being re-run (N-TEST-7).`,
  );
  assert.match(
    cmd,
    /scripts\/acceptance\/run-ten-company-acceptance\.ts/,
    `"acceptance:ten" must run the acceptance harness itself, not something adjacent. Got: ${cmd}`,
  );

  // THE PART THIS GOLDEN ORIGINALLY MISSED, and it is the dangerous half.
  // The first version of the npm script (written minutes earlier, same session)
  // was `tsx scripts/acceptance/run-ten-company-acceptance.ts` — correct path,
  // no preload. That is not a slower run, it is a DIFFERENT one:
  //   - isolate-scratch-data.ts is what sets LEADGEN_DATA_DIR to an empty temp
  //     folder. Without it the harness creates and deletes ten workspaces in
  //     the REAL .leadgen-data directory — the demo data — because src/lib/db.ts
  //     reads that variable at import time and cannot be told later.
  //   - it is also what forces PERSISTENCE_PROVIDER=json, the guard that keeps
  //     this harness away from the ship database (F-P0-5).
  //   - it is also what loads .env, without which there is no model key at all.
  // A command that is discoverable and wrong is worse than no command: it
  // invites someone to run it.
  assert.match(
    cmd,
    /--import\s+\.\/scripts\/acceptance\/_helpers\/isolate-scratch-data\.ts/,
    `"acceptance:ten" must load the isolation preload. Without it the run writes into the real data ` +
      `directory instead of an empty scratch copy, does not force PERSISTENCE_PROVIDER=json, and loads no ` +
      `.env. Got: ${cmd}`,
  );

  assert.ok(
    fs.existsSync(HARNESS),
    `the script points at ${HARNESS}, which does not exist — the npm entry would fail the moment anyone used it`,
  );

  // The checklist is where a human looks before showing or shipping. A command
  // nobody is told to run is only marginally better than no command.
  const checklist = fs.readFileSync(path.join(process.cwd(), "docs", "GO_LIVE_CHECKLIST.md"), "utf8");
  assert.match(
    checklist,
    /acceptance:ten/,
    `docs/GO_LIVE_CHECKLIST.md never mentions "acceptance:ten". The run costs real money and takes ~2 minutes, ` +
      `so it is deliberately manual — which only works if the checklist tells someone to run it.`,
  );
});

test("CASE G — every run is archived, so two runs can actually be compared (N-TEST-8)", () => {
  const src = harnessSrc();

  // The two headline files are FIXED paths. That is fine and deliberate — a
  // human wants one predictable place to look. What is not fine is that being
  // the ONLY place, because then run N destroys run N-1 and the one question
  // worth asking of a repeated acceptance run — "did the answers change?" —
  // can never be answered. A grader only catches what someone thought to
  // assert; the transcript is what catches everything else, and only if the
  // previous one still exists to compare against.
  assert.match(
    src,
    /path\.join\(outDir,\s*"runs"\)/,
    `the harness no longer writes a runs/ archive directory. Without it, every run silently overwrites the ` +
      `evidence from the run before it, and no two acceptance runs can ever be diffed.`,
  );

  // Timestamped, or the archive is just the same overwrite one directory down.
  assert.match(
    src,
    /generatedAt\.replace\(/,
    `the archive filename is no longer derived from the run's timestamp. An archive that does not vary per run ` +
      `overwrites itself exactly like the fixed paths it was added to fix.`,
  );

  // Both halves: the readable transcript AND the machine record. The .md is
  // what a person reads; the .json is what a future diff tool reads.
  for (const [expr, what] of [
    [/fs\.writeFileSync\(archiveMd\b/, "the readable transcript (.md)"],
    [/fs\.writeFileSync\(archiveJson\b/, "the machine record (.json)"],
  ] as [RegExp, string][]) {
    assert.match(src, expr, `the run archive no longer stores ${what}.`);
  }

  // mkdirSync with recursive, or the very first run on a clean checkout throws
  // ENOENT AFTER spending ~2 minutes and real money on sixty model calls.
  assert.match(
    src,
    /fs\.mkdirSync\(runsDir,\s*\{\s*recursive:\s*true\s*\}\)/,
    `the harness does not create runs/ before writing into it. On a clean checkout the directory does not exist, ` +
      `so the write throws — and it throws at the very END, after sixty paid model calls have already been made.`,
  );
});

after(() => {
  console.log(
    "\n    NOTE — this golden makes NO model calls and touches NO network. It cannot tell you the AI still\n" +
      "    answers correctly; only `npm run acceptance:ten` can, and only on the day it runs. What it guards is\n" +
      "    that a 60/60 from that run still MEANS something: ten trades, both honest and wrong-on-purpose\n" +
      "    questions, seven live graders, no mock fallback, unroutable contacts, and a command a human can find.",
  );
});
