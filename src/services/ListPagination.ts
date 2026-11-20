/**
 * ListPagination.ts — the generic page/cap chokepoint for API list reads
 * (2026-08-05, audit finding F-8).
 *
 * ─── WHAT WAS WRONG ────────────────────────────────────────────────────────
 *
 * `LeadListPagination.ts` (Session 7, P-3) solved this correctly for ONE
 * endpoint and documented its reasoning well. But:
 *
 *   1. Every OTHER list endpoint stayed unbounded — `/api/replies`,
 *      `/api/messages`, `/api/auto-reply-logs`, `/api/tickets`,
 *      `/api/orders`, `/api/quotes` all did `return json(await
 *      repo.listByWorkspace(workspaceId))` with no ceiling at all.
 *
 *   2. Even for leads, the ceiling only applied when the caller OPTED IN by
 *      passing ?limit or ?offset. The default bare-array path — the one the
 *      dashboard actually uses — had no cap. So the protection existed but the
 *      real traffic bypassed it.
 *
 * At 15 demo leads none of this shows. At 20,000 rows every dashboard load
 * ships tens of megabytes and the browser tab dies.
 *
 * ─── THE DESIGN ────────────────────────────────────────────────────────────
 *
 * Two functions, deliberately different, because there are two callers with
 * genuinely different needs:
 *
 *   `paginate()`   — explicit page envelope for a caller that ASKED to page.
 *                    Returns { items, total, limit, offset, hasMore }.
 *
 *   `capBareList()` — a SAFETY CEILING for the legacy bare-array responses.
 *                    Returns the array, capped, plus a flag saying whether it
 *                    was truncated. The route turns that flag into response
 *                    headers so the client can tell the user honestly.
 *
 * ─── WHY THE CEILING IS NOT SILENT ─────────────────────────────────────────
 *
 * Silently truncating a list the UI believes is complete is WORSE than a slow
 * response: `leads.filter(x).length` on a truncated array renders a confidently
 * wrong number on the dashboard, and `leads.find(byId)` returns undefined for a
 * record that exists. A wrong number nobody questions beats a slow page for
 * damage.
 *
 * So truncation is always reported:
 *   - `X-Total-Count`  — how many rows actually exist
 *   - `X-Returned-Count` — how many are in this response
 *   - `X-Truncated: true` — set only when those differ
 *
 * and the UI shows a banner rather than pretending the list is whole.
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * It does not touch the repository-level `listByWorkspace` calls used by
 * INTERNAL services. Per the reasoning already established in
 * LeadListPagination.ts, those genuinely need every row (dedup checks, batch
 * counts, queue building) and silently paginating them would make them compute
 * wrong answers. Pagination stays an API-boundary concern.
 *
 * Pinned by `golden:list-pagination`.
 */

/** Default page size when a paginating caller omits `limit`. */
export const DEFAULT_PAGE_SIZE = 500;

/** Hard ceiling on an explicit `limit`. No request can exceed this. */
export const MAX_PAGE_SIZE = 1000;

/**
 * Ceiling applied to the LEGACY bare-array responses.
 *
 * Higher than MAX_PAGE_SIZE on purpose: this path is a backstop against
 * catastrophe (OOM), not a UX pagination size. A workspace under this many rows
 * behaves exactly as it always has — no behaviour change for any real customer
 * today — while a runaway workspace can no longer take the server down.
 */
export const BARE_LIST_CEILING = 2000;

export type Page<T> = {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

/** Clamp `limit` into [1, MAX_PAGE_SIZE]; non-finite/≤0 falls back to default. */
export function safeLimit(requested: number | undefined): number {
  return Number.isFinite(requested) && (requested as number) > 0
    ? Math.min(Math.floor(requested as number), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
}

/** Clamp `offset` to ≥ 0; non-finite/negative falls back to 0. */
export function safeOffset(requested: number | undefined): number {
  return Number.isFinite(requested) && (requested as number) >= 0
    ? Math.floor(requested as number)
    : 0;
}

/**
 * Slice an already workspace-scoped list into a page envelope.
 *
 * `total` is the count BEFORE paging, so the UI can render "showing X of Y"
 * truthfully.
 */
export function paginate<T>(all: T[], limit?: number, offset?: number): Page<T> {
  const useLimit = safeLimit(limit);
  const useOffset = safeOffset(offset);
  const items = all.slice(useOffset, useOffset + useLimit);
  return {
    items,
    total: all.length,
    limit: useLimit,
    offset: useOffset,
    hasMore: useOffset + items.length < all.length,
  };
}

export type CappedList<T> = {
  items: T[];
  total: number;
  truncated: boolean;
};

/**
 * Apply the catastrophe ceiling to a legacy bare-array response.
 *
 * Returns the (possibly capped) rows plus the true total, so the caller can
 * report the truncation instead of hiding it.
 */
export function capBareList<T>(all: T[], ceiling: number = BARE_LIST_CEILING): CappedList<T> {
  if (all.length <= ceiling) return { items: all, total: all.length, truncated: false };
  return { items: all.slice(0, ceiling), total: all.length, truncated: true };
}

/**
 * Response headers describing a capped bare list. Always includes the true
 * total and the returned count; only sets X-Truncated when they differ.
 */
export function paginationHeaders<T>(capped: CappedList<T>): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Total-Count": String(capped.total),
    "X-Returned-Count": String(capped.items.length),
  };
  if (capped.truncated) headers["X-Truncated"] = "true";
  return headers;
}
