import type { AppData } from "@/lib/types";

/**
 * Collections a reset must NOT touch, and why.
 *
 * Session 55. `scopeDataForExport` in the API route is the authoritative list
 * of what belongs to a workspace, so a reset is "clear everything in that
 * list" — with three deliberate exceptions:
 *
 *   workspaces / workspaceMembers — deleting these would remove the operator's
 *     own access along with the demo data. A reset clears what is IN the
 *     workspace, it does not delete the workspace.
 *
 *   doNotContactRegistry — this is the legal record of who asked never to be
 *     contacted again, and LOGIC.md is explicit that "DNC is permanent —
 *     clearing the lead flag does NOT remove them from the registry". A reset
 *     that emptied it would make every person who ever opted out contactable
 *     again by importing the same list. It is the one thing in a workspace that
 *     must outlive the workspace's contents.
 *
 * This lives in lib/ rather than in the route because BOTH the route and the
 * JSON repository need it, and the repository cannot import the route. It was
 * briefly written out twice — once in each — which is exactly how two
 * substrates come to disagree about what a reset means.
 */
export const RESET_PRESERVED_COLLECTIONS = ["workspaces", "workspaceMembers", "doNotContactRegistry"] as const;

/**
 * Clear a workspace's contents from a snapshot in place. Returns how many rows
 * went, per collection, so the screen can show what actually happened rather
 * than asserting success.
 *
 * This is the JSON substrate's delete: there the snapshot IS the database.
 * Postgres cannot use it — its snapshot writer is upsert-only — and deletes
 * through `RESET_COLLECTION_DELEGATES` in the Prisma repository instead.
 */
export function clearWorkspaceCollectionsInSnapshot(
  data: AppData,
  workspaceId: string,
  collections: readonly string[],
): Record<string, number> {
  const bag = data as unknown as Record<string, Array<{ workspaceId?: string }> | undefined>;
  const removed: Record<string, number> = {};
  for (const key of collections) {
    if ((RESET_PRESERVED_COLLECTIONS as readonly string[]).includes(key)) continue;
    const rows = bag[key];
    if (!Array.isArray(rows)) continue;
    const kept = rows.filter((row) => row.workspaceId !== workspaceId);
    if (kept.length !== rows.length) removed[key] = rows.length - kept.length;
    bag[key] = kept;
  }
  return removed;
}
