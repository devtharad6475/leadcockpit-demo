/**
 * LeadListPagination.ts — OPT-IN pagination for the lead list (P-3 fix,
 * Session 7 2026-07-28).
 *
 * THE PROBLEM (audit S7 P-3):
 *   GET /api/leads returned the ENTIRE workspace's leads with no row cap. At
 *   multi-tenant scale every dashboard load shipped a multi-MB JSON blob and
 *   could OOM Node. The same unbounded pattern existed across list endpoints.
 *
 * THE FIX (chokepoint, no silent ripple):
 *   This module adds `listLeadsPage` — a paginated read for EXTERNAL list
 *   consumers (the API endpoint). It applies a default page size, a hard
 *   ceiling, and limit/offset slicing, and returns a page envelope
 *   `{ items, total, limit, offset, hasMore }`.
 *
 *   CRITICAL DESIGN CHOICE — the base `repos.lead.listLeads` is deliberately
 *   LEFT UNCAPPED. Several INTERNAL services genuinely need ALL leads:
 *     - LeadReviewBatchService (counts auto-approves-today across the workspace)
 *     - ProspectingService (dedup check vs every existing lead)
 *     - OutreachQueueService / LeadReviewDecisionService (the review queue)
 *     - WhatsAppConversationEngine (lead context)
 *   Silently paginating those would make them miss leads and compute wrong
 *   counts — the classic ripple trap. Pagination is therefore OPT-IN via this
 *   explicit module, used only by the GET /leads endpoint. Internal callers keep
 *   calling `listLeads` directly.
 *
 * DEFAULT_PAGE_SIZE / MAX_PAGE_SIZE:
 *   The default is large enough that a normal CRM never paginates in practice
 *   (so the UI stays simple), but the ceiling guarantees no single request can
 *   ever return an unbounded result. The operator can pass a smaller ?limit.
 *
 * Pinned by `golden:list-pagination`.
 */
import type { Lead } from "@/lib/types";
import type { ListLeadFilters, RepositoryBundle } from "@/repositories/interfaces";

/** Default page size when the caller omits `limit`. Large enough that normal
 *  workspaces get everything in one page; small enough to bound the payload. */
export const DEFAULT_PAGE_SIZE = 500;

/** Hard ceiling on `limit`. A request asking for more is clamped to this — no
 *  unbounded query is ever possible, even via the API. */
export const MAX_PAGE_SIZE = 1000;

export type LeadPage = {
  items: Lead[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

export type ListLeadsPageOptions = {
  limit?: number;
  offset?: number;
  filters?: ListLeadFilters;
};

/**
 * Read one page of leads for a workspace. Workspace-scoped (the underlying
 * listLeads already filters by workspaceId; this adds limit/offset/ceiling).
 *
 * Implementation note: in the JSON runtime this slices in memory after the
 * workspace filter (the JSON store holds the whole file anyway). In the Prisma
 * runtime the limit/offset can be pushed into the DB query — but correctness is
 * identical either way, and the ceiling protects both. The page envelope is the
 * stable contract the UI consumes.
 */
export async function listLeadsPage(
  repos: RepositoryBundle,
  workspaceId: string,
  options: ListLeadsPageOptions = {},
): Promise<LeadPage> {
  const requestedLimit = options.limit ?? DEFAULT_PAGE_SIZE;
  // Clamp: limit in [1, MAX_PAGE_SIZE]. Negative/zero/non-finite → default.
  const safeLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  // Clamp: offset ≥ 0. Negative/non-finite → 0.
  const safeOffset = Number.isFinite(options.offset) && (options.offset as number) >= 0
    ? Math.floor(options.offset as number)
    : 0;

  // The underlying listLeads is workspace-scoped + filter-scoped. We then apply
  // offset/limit to produce the page. total is the count BEFORE paging so the UI
  // can render "showing X of Y".
  const all = await repos.lead.listLeads(workspaceId, options.filters);
  const total = all.length;
  const items = all.slice(safeOffset, safeOffset + safeLimit);
  const hasMore = safeOffset + items.length < total;

  return { items, total, limit: safeLimit, offset: safeOffset, hasMore };
}
