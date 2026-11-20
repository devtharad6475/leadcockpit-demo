/**
 * safe-not-found.ts — Cluster 5 P1-2 family chokepoint (build-right Phase 3d).
 *
 * PROBLEM (audit NEW-A / P1-2): ~30 sites use `.catch(() => [])` or
 * `.catch(() => undefined)`. This silently hides REAL errors and returns the
 * empty value as if it were the truth. Examples that bit us:
 *   - countAutoApprovesToday returned 0 on a repo error → daily auto-approve
 *     cap silently disabled.
 *   - erasure preview reported "0 orders" when the order repo threw → operator
 *     could approve a delete believing nothing to lose.
 *   - AgentContextBuilder swallowed profile/settings errors → agent drafted
 *     replies with empty business knowledge.
 *
 * CONTRACT (pinned by golden:safe-not-found):
 *   - Not-found (ENOENT, Prisma P2025, NotFoundError) → swallow + return fallback.
 *     A missing workspace setting is NORMAL (workspace hasn't been configured
 *     yet). Caller legitimately wants the fallback so it can use defaults.
 *   - Anything else (disk error, corrupt JSON, TypeError, plain Error) →
 *     RE-THROW. Caller must surface it to the operator. Never silently absorb.
 *
 * USAGE (replace `.catch(() => [])` family):
 *   BEFORE:  await repos.foo.listByWorkspace(ws).catch(() => []);
 *   AFTER:   await safeNotFound(() => repos.foo.listByWorkspace(ws), { fallback: [] });
 *
 * Anti-cheat: the helper is a thin classifier. It cannot "fix" errors — it can
 * only decide swallow-vs-rethrow. The golden test pins both branches.
 */

/** Typed "this is a not-found situation" signal. Throw from any code path that
 *  wants to participate in the not-found contract without inventing an error code. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * Classify an unknown thrown value as "not found" or "real error".
 * One function — the single chokepoint the whole silent-catch family routes
 * through. Returns true ONLY for the recognized not-found family; false for
 * everything else (so real errors are never mis-swallowed).
 */
export function isNotFoundError(error: unknown): boolean {
  if (error == null) return false; // null/undefined — not a not-found; re-throw.
  // Our typed NotFoundError.
  if (error instanceof NotFoundError) return true;
  if (error instanceof Error) {
    // Filesystem not-found.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    // Prisma "record not found" — see https://www.prisma.io/docs/reference/api-reference/error-reference#p2025
    if ((error as { code?: string }).code === "P2025") return true;
    // Prisma throws on findUnique-or-throw etc. with code P2018 / P2025.
    if ((error as { code?: string }).code === "P2018") return true;
    return false;
  }
  // Non-Error throw (string, number, plain object) — never auto-swallow; surface it.
  return false;
}

/**
 * Run an async operation; if it throws a not-found error, return the caller's
 * fallback. If it throws anything else, RE-THROW (after logging). If it
 * succeeds, return its real value.
 *
 * The optional `context` string is included in the server log so the operator
 * can see WHERE the swallowed not-found or re-thrown error came from.
 */
export async function safeNotFound<T>(
  operation: () => Promise<T>,
  options: { fallback: T; context?: string },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isNotFoundError(error)) {
      // Expected "missing" — caller's fallback applies. Quiet log at debug level
      // so server logs show traceability without spamming.
      if (options.context) {
        console.warn(
          `[safeNotFound] not-found swallowed (${options.context}): ${(error as Error).message}`,
        );
      }
      return options.fallback;
    }
    // Real error — log loud + re-throw. Caller MUST surface to operator.
    console.error(
      `[safeNotFound] real error${options.context ? ` in ${options.context}` : ""}:`,
      error,
    );
    throw error;
  }
}
