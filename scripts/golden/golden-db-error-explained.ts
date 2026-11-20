/**
 * golden-db-error-explained.ts — pins the failure-message classifier
 * (2026-08-18, CEO-loop session 5).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Running `scripts/migrate-json-to-postgres.ts` with the local Postgres
 * container stopped produced this, verbatim, and nothing else:
 *
 *     MIGRATION PLAN FAILED: PrismaClientKnownRequestError:
 *     Invalid `model("workspace").findMany()` invocation in
 *     src/repositories/prisma/index.ts:3020:28
 *
 * The query is not invalid. The database was off. Prisma puts the one useful
 * fact — `ECONNREFUSED` — on `error.code` and leaves it out of the message, so
 * the printed output actively points at the wrong file. That costs whoever
 * reads it a trip into the repository layer before they think to check whether
 * anything is listening on the port.
 *
 * WHY A GOLDEN AND NOT JUST A FIX. The classifier's whole value is telling
 * "the environment is down" apart from "the code is wrong". If it ever
 * collapses those two — most likely by growing a catch-all that calls
 * everything unreachable — the message becomes worse than the stack it
 * replaced, because it would confidently tell someone to restart a database
 * when their query is genuinely broken. That is the regression this pins, and
 * it is invisible without a test: the misleading output still LOOKS like a
 * helpful sentence.
 *
 * WHY IT RUNS OFFLINE. `classifyDbError`/`explainDbError` are pure — an unknown
 * thrown value in, a string out. The alternative is stopping a real database to
 * reproduce each case, which cannot be done in a suite that runs 4 Postgres
 * goldens against that same database.
 *
 * HAND-COMPUTED CONTRACT (written BEFORE running it):
 *
 *   CASE A — THE REAL ONE. The exact error shape observed above
 *            (name `PrismaClientKnownRequestError`, code `ECONNREFUSED`,
 *            message full of query text) classifies as `unreachable`, NOT as
 *            `query`. The message text is the trap; the code is the truth.
 *   CASE B — the advice actually names the remedy. A classification nobody can
 *            act on is the same as no classification, so the text must mention
 *            DATABASE_URL and must NOT claim the query is at fault.
 *   CASE C — Prisma's own P1001 lands in the same bucket as ECONNREFUSED. Two
 *            spellings of "nothing is listening" must not read differently.
 *   CASE D — an auth failure (P1000) is `rejected`, not `unreachable`. Telling
 *            someone to start a server that is already running, when the real
 *            problem is the password, sends them the wrong way.
 *   CASE E — a missing table (P2021) is `schema`, and the advice says
 *            `migrate deploy`. This is the "database is up, code is ahead of
 *            it" case, which looks like a connection problem to the naked eye.
 *   CASE F — THE ANTI-CATCH-ALL. A genuine query error (a Prisma error with a
 *            code that is NOT in any environment list, e.g. P2002 unique
 *            violation) is `query`, and the advice explicitly says it is a code
 *            defect and not an environment problem. Without this case, a
 *            classifier that returned "unreachable" for everything would pass
 *            A–E.
 *   CASE G — a plain `new Error("boom")`, a string, null, and undefined are all
 *            `other` and do not throw. This runs inside a `.catch()`; a
 *            classifier that throws on an odd input would replace the real
 *            failure with its own.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { classifyDbError, explainDbError } from "@/migration/explain-db-error";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}: ${(err as Error).message}`);
  }
}

/** Rebuilds the shape Prisma actually threw, message text and all. */
function prismaError(code: string, message: string) {
  const e = new Error(message) as Error & { code: string; clientVersion: string };
  e.name = "PrismaClientKnownRequestError";
  e.code = code;
  e.clientVersion = "7.8.0";
  return e;
}

/** The literal message observed on 2026-08-18 with the container stopped. */
const OBSERVED_MESSAGE = [
  "",
  'Invalid `model("workspace").findMany()` invocation in',
  "C:\...\src\repositories\prisma\index.ts:3020:28",
  "",
  "  3019 ] = await Promise.all([",
  '→ 3020   model("workspace").findMany(',
].join("\n");

function main() {
  console.log("GOLDEN db-error-explained — environment failure vs code defect\n");

  check("CASE A — the observed ECONNREFUSED is 'unreachable', not 'query'", () => {
    const err = prismaError("ECONNREFUSED", OBSERVED_MESSAGE);
    assert.strictEqual(classifyDbError(err), "unreachable",
      "the message is full of query text; only error.code tells the truth");
  });

  check("CASE B — the advice names the remedy and does not blame the query", () => {
    const text = explainDbError(prismaError("ECONNREFUSED", OBSERVED_MESSAGE));
    assert.ok(text.includes("DATABASE_URL"), `advice must name DATABASE_URL, got: ${text}`);
    assert.ok(text.includes("ECONNREFUSED"), "advice must keep the code, it is the one hard fact");
    assert.ok(!/code defect/i.test(text), `advice must not call this a code defect: ${text}`);
  });

  check("CASE C — Prisma's own P1001 classifies the same as ECONNREFUSED", () => {
    assert.strictEqual(classifyDbError(prismaError("P1001", "Can't reach database server")), "unreachable");
  });

  check("CASE D — an auth failure is 'rejected', not 'unreachable'", () => {
    const err = prismaError("P1000", "Authentication failed against database server");
    assert.strictEqual(classifyDbError(err), "rejected",
      "telling someone to start a server that is already up sends them the wrong way");
    assert.ok(/user, password/.test(explainDbError(err)));
  });

  check("CASE E — a missing table is 'schema' and the advice says migrate deploy", () => {
    const err = prismaError("P2021", "The table `public.Workspace` does not exist");
    assert.strictEqual(classifyDbError(err), "schema");
    assert.ok(explainDbError(err).includes("migrate deploy"), explainDbError(err));
  });

  check("CASE F — a genuine query error stays a query error (anti-catch-all)", () => {
    const err = prismaError("P2002", "Unique constraint failed on the fields: (`id`)");
    assert.strictEqual(classifyDbError(err), "query",
      "a classifier that says 'unreachable' for everything would pass every case above");
    assert.ok(/not an environment problem/.test(explainDbError(err)), explainDbError(err));
  });

  check("CASE G — non-database values are 'other' and never throw", () => {
    for (const value of [new Error("boom"), "a string", null, undefined, 42]) {
      assert.strictEqual(classifyDbError(value), "other", `classified ${String(value)} as a DB error`);
      assert.strictEqual(typeof explainDbError(value), "string");
    }
  });

  console.log("");
  console.log(`=== GOLDEN db-error-explained: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
