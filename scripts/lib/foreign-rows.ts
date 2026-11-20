/**
 * foreign-rows.ts — "did this seeder write these rows, or did somebody else?"
 *
 * Pulled out of scripts/seed-demo-prisma.ts (N-SEED-2, 2026-08-19) for one
 * reason: the seeder's guard has to be provably a DISCRIMINATOR, not a blanket
 * refusal. A guard that refuses unconditionally passes the "it refused on the
 * migrated database" test perfectly, and also breaks every legitimate use of
 * the seeder on an empty database. The seeder file itself calls main() on
 * import, so it cannot be imported by a golden; this can.
 *
 * The rule is about ORIGIN, not counts or timestamps: the seeder writes rows
 * with fixed `seed_*` ids, so anything else in the workspace belongs to
 * somebody else — in practice the real demo data set, migrated in from the JSON
 * file as `*_demo_*`.
 */
export const SEED_ID_PREFIX = "seed_";

export type IdentifiedRow = { id: string };

export type WorkspaceRows = {
  orders: IdentifiedRow[];
  quotes: IdentifiedRow[];
  leads: IdentifiedRow[];
};

/**
 * Returns a human-readable label for every row the seeder did not write, in a
 * stable order (orders, then quotes, then leads). Empty means the workspace
 * holds nothing but this seeder's own output — which is the case the seeder is
 * allowed to proceed on.
 */
export function findForeignRows(rows: WorkspaceRows): string[] {
  const foreign = (kind: string, list: IdentifiedRow[]) =>
    list.filter((r) => !r.id.startsWith(SEED_ID_PREFIX)).map((r) => `${kind} ${r.id}`);
  return [
    ...foreign("order", rows.orders),
    ...foreign("quote", rows.quotes),
    ...foreign("lead", rows.leads),
  ];
}
