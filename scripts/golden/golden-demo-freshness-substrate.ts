/**
 * GOLDEN — the pre-demo freshness check must measure THE SUBSTRATE THE PRODUCT
 * SERVES FROM, and must say which one it measured (N-OBS-2).
 *
 * WHAT WENT WRONG, AND WHY A GOLDEN IS THE RIGHT ANSWER
 * ----------------------------------------------------
 * `demo:check` exists to stop someone showing a demo that has quietly changed
 * what it demonstrates (N-OBS-1). For four days it read
 * `.leadgen-data/app-data.json` unconditionally while `.env` set
 * `PERSISTENCE_PROVIDER=prisma`, so it graded a file the running product does not
 * read. Measured within the same minute on 2026-08-24:
 *
 *   JSON copy     -> "OK - Demo is demonstrable ... 23h 58m left"
 *   Postgres      -> 163.8h old, 0 open windows, NOT demonstrable
 *
 * The check was green, confident, and about the wrong database. That is the
 * worst failure shape a guard can have, because it is indistinguishable from
 * safety right up until the customer is watching.
 *
 * This golden makes NO database connection. It reads source. What it pins is
 * the set of properties that, if any one of them is quietly removed, puts the
 * bug straight back:
 *
 *   A  the checker asks which provider is configured, instead of assuming
 *   B  the checker can actually read Postgres, not just JSON
 *   C  the checker NAMES the substrate it measured in its output
 *   D  the advice printed to a Postgres operator is a command that WORKS
 *   E  a failure to read the data exits non-zero, never a quiet "fine"
 *
 * D deserves its own line. The obvious repair command, `seed:demo:prisma`,
 * refuses on this database and its `--force` would leave it half-written. Advice
 * that cannot work is worse than no advice, because it gets followed.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

const CHECKER = path.join(process.cwd(), "scripts", "check-demo-freshness.ts");
const MODULE = path.join(process.cwd(), "src", "lib", "demo-freshness.ts");
const REFRESH = path.join(process.cwd(), "scripts", "refresh-demo-window-prisma.ts");
const PKG = path.join(process.cwd(), "package.json");

/** S11-1 lesson, repeated at S14-1: scan CODE, not the comments that describe it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const checkerSrc = () => stripComments(fs.readFileSync(CHECKER, "utf8"));
const moduleSrc = () => stripComments(fs.readFileSync(MODULE, "utf8"));
const refreshSrc = () => stripComments(fs.readFileSync(REFRESH, "utf8"));

test("CASE A — the checker asks which substrate is configured instead of assuming JSON", () => {
  const src = checkerSrc();
  assert.match(
    src,
    /getPersistenceProvider\s*\(/,
    "check-demo-freshness.ts no longer calls getPersistenceProvider(). Without it the checker grades whichever " +
      "store it was hard-coded to read, which is exactly how it spent four days reporting confidently on a file " +
      "the running product does not read.",
  );
  assert.match(
    src,
    /"prisma"/,
    'the checker never mentions the "prisma" provider, so it cannot be branching on it.',
  );
});

test("CASE B — the checker can actually read the Postgres substrate", () => {
  const src = checkerSrc();
  assert.match(
    src,
    /prisma\.lead\.findMany/,
    "the checker never queries leads through Prisma. Resolving the provider and then reading JSON anyway is the " +
      "original bug wearing a branch.",
  );
  assert.match(
    src,
    /lastInboundAt/,
    "the checker no longer reads lastInboundAt — the one field the WhatsApp 24-hour window is computed from.",
  );
});

test("CASE C — the output NAMES the substrate it measured", () => {
  const src = checkerSrc();
  assert.match(
    src,
    /measured:/,
    'the checker no longer prints a "measured:" line. An answer that does not say what it looked at is how the ' +
      "first version stayed wrong for four days without anybody noticing.",
  );
  // And it must never print the connection string: that carries a password.
  assert.doesNotMatch(
    src,
    /DATABASE_URL/,
    "the checker references DATABASE_URL. It must name the SUBSTRATE, never the connection string, which carries " +
      "a password and would end up in terminal scrollback and CI logs.",
  );
});

test("CASE D — a Postgres operator is given a command that actually works", () => {
  const mod = moduleSrc();
  const match = mod.match(/DEMO_REFRESH_COMMAND_PRISMA\s*=\s*"([^"]+)"/);
  assert.ok(match, "DEMO_REFRESH_COMMAND_PRISMA is gone. Then the Postgres branch has no repair advice at all.");
  const command = match![1];

  assert.doesNotMatch(
    command,
    /seed:demo:prisma/,
    `the Postgres repair advice is "${command}". That seeder REFUSES on this database — the demo rows were ` +
      "migrated in from JSON and are not its own seed_* rows — and its --force warns of a unique-constraint " +
      "failure that leaves the database half-written. Advice that cannot work is worse than no advice.",
  );
  assert.match(
    command,
    /demo:refresh:prisma/,
    `the Postgres repair advice is "${command}", which is not the refresh command.`,
  );

  const scripts = (JSON.parse(fs.readFileSync(PKG, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  assert.ok(
    scripts["demo:refresh:prisma"],
    'package.json has no "demo:refresh:prisma" script, so the advice above names a command that does not exist.',
  );

  // The refresh must not be able to run by accident, and must not rewrite a
  // healthy demo. Both guards are load-bearing: this script edits timestamps.
  const refresh = refreshSrc();
  assert.match(
    refresh,
    /includes\("--apply"\)/,
    "the refresh script no longer requires --apply. It rewrites every conversation timestamp in the workspace; " +
      "that must never happen because somebody ran the bare command to see what it did.",
  );
  assert.match(
    refresh,
    /deltaMs <= 0/,
    "the refresh script no longer refuses to move time BACKWARDS. Moving it backwards would reopen a WhatsApp " +
      "window the product had correctly closed, which is the one thing this must never be able to do.",
  );
  assert.match(
    refresh,
    /DEMO_MIN_WINDOW_MINUTES/,
    "the refresh script no longer checks whether the demo is already demonstrable, so it will re-stamp a healthy " +
      "conversation for no gain.",
  );
  assert.match(
    refresh,
    /lastInboundByLead/,
    "the refresh script no longer DERIVES lastInboundAt from the replies it moved. A hand-set copy of a derived " +
      "value is precisely what drifts (N-DATA-9).",
  );
});

test("CASE E — a checker that cannot read its data must not report 'fine'", () => {
  const src = checkerSrc();
  assert.match(
    src,
    /main\(\)[\s\S]*catch[\s\S]*process\.exit\(1\)/,
    "the checker's top-level failure path no longer exits non-zero. If the database is unreachable it would print " +
      "an error and exit 0, and every caller — including a release checklist — would read that as a healthy demo.",
  );
});

after(() => {
  console.log(
    "\n    NOTE — this golden opens no database. It cannot tell you the demo is fresh; only `npm run demo:check`\n" +
      "    can, and only at the moment it runs. What it guards is that demo:check is still ASKING THE RIGHT\n" +
      "    DATABASE and still saying which one — the two properties whose absence made it green and wrong.",
  );
});
