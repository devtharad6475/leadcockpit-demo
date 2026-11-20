/**
 * explain-db-error.ts — turn a Prisma failure into a sentence a human can act on.
 *
 * WHY THIS EXISTS. Running `scripts/migrate-json-to-postgres.ts` with the local
 * Postgres container stopped printed this and nothing else:
 *
 *     MIGRATION PLAN FAILED: PrismaClientKnownRequestError:
 *     Invalid `model("workspace").findMany()` invocation in
 *     src/repositories/prisma/index.ts:3020:28
 *       → 3020   model("workspace").findMany(
 *
 * The word "invalid" and a code frame pointing at a query that is in fact
 * perfectly valid. The only thing that was actually wrong lives in `error.code`
 * — `ECONNREFUSED` — and Prisma does not put it in the message. The first
 * reading of that output is "the readAll query is broken", which sends whoever
 * sees it into the repository layer instead of into `docker start`.
 *
 * PURE ON PURPOSE. Takes an unknown thrown value, returns a string. No I/O, no
 * process.exit, no logging — so the classification can be pinned by a golden
 * with hand-built error objects, offline, without stopping a database to
 * reproduce each case.
 */

/** What kind of failure this is, at the level a human cares about. */
export type DbFailureKind =
  /** The database is not reachable at all — wrong host/port, or nothing running there. */
  | "unreachable"
  /** Reached it, but were not let in — credentials or database name. */
  | "rejected"
  /** Reached it and let in, but the schema does not match the client. */
  | "schema"
  /** Reached it, ran the query, and the query itself failed. */
  | "query"
  /** Not a database error at all. */
  | "other";

interface PrismaLikeError {
  name?: unknown;
  code?: unknown;
  message?: unknown;
}

/**
 * Connection-class codes. The libc/OS-level ones (ECONNREFUSED, ETIMEDOUT,
 * ENOTFOUND, EHOSTUNREACH) surface on `error.code` while Prisma's own message
 * still describes the query, which is the whole trap. P1001/P1002 are Prisma's
 * own equivalents and are included so both spellings land in the same bucket.
 */
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET",
  "P1001", "P1002", "P1017",
]);

/** Authentication and "database does not exist" — reached the server, refused entry. */
const REJECTED_CODES = new Set(["P1000", "P1003", "P1010"]);

/** The client and the database disagree about the schema. */
const SCHEMA_CODES = new Set(["P2021", "P2022", "P1012"]);

export function classifyDbError(error: unknown): DbFailureKind {
  if (!error || typeof error !== "object") return "other";
  const e = error as PrismaLikeError;
  const code = typeof e.code === "string" ? e.code : "";
  if (UNREACHABLE_CODES.has(code)) return "unreachable";
  if (REJECTED_CODES.has(code)) return "rejected";
  if (SCHEMA_CODES.has(code)) return "schema";
  if (typeof e.name === "string" && e.name.startsWith("PrismaClient")) return "query";
  return "other";
}

/**
 * A sentence to print instead of a stack. Includes the code, because the code is
 * the one piece of the original output that was actually informative, and the
 * remedy, because knowing it is ECONNREFUSED is only half of knowing what to do.
 */
export function explainDbError(error: unknown): string {
  const code = (error as PrismaLikeError | null)?.code;
  const codeSuffix = typeof code === "string" && code ? ` (${code})` : "";
  switch (classifyDbError(error)) {
    case "unreachable":
      return `The database is not reachable${codeSuffix}. Nothing is wrong with the query — ` +
        `there is nothing listening at the address in DATABASE_URL. Start the local Postgres ` +
        `(\`docker start leadgen-pg\`) or point DATABASE_URL at a database that is running.`;
    case "rejected":
      return `The database refused the connection${codeSuffix} — the server answered but would ` +
        `not let us in. Check the user, password and database name in DATABASE_URL.`;
    case "schema":
      return `The database is running but its schema does not match this code${codeSuffix}. ` +
        `Run \`npx prisma migrate deploy\`.`;
    case "query":
      return `The database rejected this query${codeSuffix}. This one is a real code defect, ` +
        `not an environment problem — the message below points at the offending call.`;
    default:
      return "This is not a database error.";
  }
}
