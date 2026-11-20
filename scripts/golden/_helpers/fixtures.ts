/**
 * fixtures.ts — the tenant a golden invents has to actually exist.
 *
 * WHY THIS FILE EXISTS (2026-08-25, audit A-7, N-TEST-9)
 * -----------------------------------------------------
 * The JSON substrate has no foreign keys. Writing a lead whose `workspaceId` is
 * `workspace_setup_card_order_golden` succeeds even though no such workspace was
 * ever created, because JSON is a file and a file does not check. Postgres does
 * check, and refuses:
 *
 *     Foreign key constraint violated on the constraint: `leads_workspace_id_fkey`
 *
 * That is not Postgres being awkward. It is the first time anything has asked
 * these goldens to be honest about what they need, and several of them were not:
 * they asserted correct behaviour about a tenant that did not exist. A rule
 * proven against an impossible database is not proven.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a way to make red goldens green. It creates ONE row — the tenant —
 * and nothing else. No leads, no products, no settings, no demo data. If a
 * golden needs more than a tenant, it seeds it itself, in its own file, where a
 * reader can see it. The moment this file starts seeding convenience data it
 * becomes a place where a golden's real dependencies go to hide, which is the
 * exact failure mode A-7 exists to expose.
 *
 * WHY A HELPER AND NOT A SEEDED TEMPLATE DATABASE
 * ----------------------------------------------
 * The obvious alternative was to seed `workspace_demo` into
 * `leadgen_golden_template` once, so every clone starts with it. That is fewer
 * edits and it was rejected: it makes the dependency INVISIBLE. A golden would
 * depend on a tenant it never mentions, the harness would supply it silently,
 * and the next person to read the file would have no way to know. One line in
 * the golden's own `main()` says what it needs, out loud, in the place somebody
 * reading the golden will actually look.
 *
 * BOTH SUBSTRATES. `repos.workspace.create()` passes an explicit `id` straight
 * through on Prisma and on JSON, so the same call works either way. On JSON the
 * row usually already exists (the demo file has it) and this is a no-op read.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";

/**
 * Make sure the tenant `id` exists before anything is hung off it.
 *
 * Idempotent, and deliberately tolerant of losing a create race: two goldens
 * never run concurrently today, but a helper that throws on "somebody else
 * created it first" would be a landmine the day that changes. A create that
 * fails is only a real failure if the row is STILL absent afterwards.
 *
 * @param name  Optional. Only used when the workspace is actually created, so a
 *              golden re-running against an existing tenant never renames it.
 */
export async function ensureWorkspace(
  repos: RepositoryBundle,
  id: string,
  name = `golden fixture ${id}`,
): Promise<void> {
  const existing = await repos.workspace.getById(id);
  if (existing) return;

  try {
    await repos.workspace.create({ id, name });
  } catch (error) {
    // Lost a race, or the substrate refused for some other reason. Only the
    // second read can tell the difference, and only it is allowed to decide.
    const nowThere = await repos.workspace.getById(id);
    if (!nowThere) {
      throw new Error(
        `ensureWorkspace("${id}") could not create the tenant and it is still absent: ${(error as Error).message}`,
      );
    }
  }
}

/** Several tenants at once, in order. Same rules as {@link ensureWorkspace}. */
export async function ensureWorkspaces(repos: RepositoryBundle, ids: string[]): Promise<void> {
  for (const id of ids) await ensureWorkspace(repos, id);
}
