/**
 * MarketResearchService — research that ACTUALLY RUNS its plan (GAP-6, 2026-07-31).
 *
 * Authority: docs/planning/CAPABILITY_GAP_AUDIT.md GAP-6 + docs/LOGIC.md CP-15.
 *
 * THE GAP THIS CLOSES: previously `runResearchTask` (OwnerCopilotService) ran
 * the `market_research` LLM task, whose prompt only says "Prepare market
 * research queries and source plan." The LLM returned a plan, and the code
 * `JSON.stringify`d it into chat as "Research done" — but NOTHING executed the
 * plan. No search ever ran. It looked like research happened; it didn't.
 *
 * THE FIX: this service takes the LLM's plan (a list of search queries) and
 * ACTUALLY EXECUTES each query via SerpApi (the same provider the prospecting +
 * enrichment paths already use). It returns structured findings, each tagged
 * with its source query + provider. Honest: with no SerpApi key (or empty
 * results) it returns ZERO findings + a clear reason — it never invents
 * companies or demand (no-hallucination, inherited).
 *
 * Design (build-right Phase 3d — centralized + injectable): the `plan` and
 * `search` functions are injectable so the golden proves the LOGIC (execute the
 * plan, tag findings, audit, no-hallucinate) deterministically — the real LLM
 * + SerpApi calls are the production defaults. Same honesty pattern as every
 * other golden (real path is a separate key-gated concern).
 */
import { LLMService } from "@/llm/LLMService";
import { assertSafeFetchUrl } from "@/lib/ssrf-guard";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { AuditLogService } from "@/services/AuditLogService";

export type MarketResearchFinding = {
  title: string;
  snippet: string;
  url: string;
  /** Which query produced this finding (provenance). */
  sourceQuery: string;
};

export type MarketResearchResult = {
  /** True iff the plan was executed (even if it yielded 0 results). False only
   *  if planning itself failed. Distinguishes "ran, no data" from "didn't run". */
  executed: boolean;
  queriesRun: number;
  findings: MarketResearchFinding[];
  /** Honest reason for the outcome (esp. when 0 findings). */
  reason: string;
  /** "serpapi" (real) | "mock" (no key) | "none". */
  provider: "serpapi" | "mock" | "none";
};

export type MarketResearchDeps = {
  /** Produces the plan (queries) for a topic. Default: the LLM market_research task. */
  plan?: (workspaceId: string, topic: string) => Promise<{ queries: string[]; rationale: string }>;
  /** Executes one search query → raw results (title/snippet/url). The service
   *  tags each with `sourceQuery` (provenance). Default: real SerpApi (Google). */
  search?: (query: string) => Promise<Array<{ title: string; snippet: string; url: string }>>;
  /** Fewer than the default 5 searches (each one is paid). Never more. */
  maxQueries?: number;
};

/**
 * Run market research on a topic: plan (LLM) → execute (SerpApi) → findings.
 * Workspace-scoped + audited. Never invents results.
 */
export async function runMarketResearch(
  workspaceId: string,
  topic: string,
  repos: RepositoryBundle,
  deps: MarketResearchDeps = {},
): Promise<MarketResearchResult> {
  const planFn = deps.plan ?? defaultPlan;
  // CP-18c (2026-08-02) — per-workspace SerpApi key overrides env. Resolve it
  // once for the whole run; defaultSearch uses it (env fallback when undefined).
  const { IntegrationCredentialService } = await import("@/services/IntegrationCredentialService");
  const workspaceSerpApiKey = await new IntegrationCredentialService(repos).resolveKey(workspaceId, "serpapi");
  const searchFn = deps.search ?? ((query: string) => defaultSearch(query, workspaceSerpApiKey));

  // 1) PLAN — get the search queries from the LLM (or injected stub).
  let queries: string[] = [];
  let rationale = "";
  try {
    const plan = await planFn(workspaceId, topic);
    queries = (plan.queries || []).filter((q) => q && q.trim()).map((q) => q.trim()).slice(0, Math.max(1, Math.min(5, deps.maxQueries ?? 5))); // cap at 5 queries (cost control)
    rationale = plan.rationale || "";
  } catch {
    // Planning failed → honest: didn't run, 0 findings, clear reason.
    return { executed: false, queriesRun: 0, findings: [], reason: "Research planning failed (the AI could not generate search queries). Add a real AI key and retry.", provider: "none" };
  }

  if (queries.length === 0) {
    await auditRun(repos, workspaceId, 0, 0, "none", "no queries generated");
    return { executed: true, queriesRun: 0, findings: [], reason: "No search queries were generated for this topic. Try a more specific topic.", provider: "none" };
  }

  // 2) EXECUTE — run each query. This is the step that was MISSING before (GAP-6).
  const allFindings: MarketResearchFinding[] = [];
  let provider: "serpapi" | "mock" | "none" = "none";
  for (const query of queries) {
    try {
      const results = await searchFn(query);
      if (results.length) {
        // Tag each finding with provenance + detect provider from the first result.
        for (const r of results) {
          allFindings.push({ title: r.title, snippet: r.snippet, url: r.url, sourceQuery: query });
        }
        provider = "serpapi";
      }
    } catch {
      // A single query failing shouldn't abort the whole run; continue.
    }
  }

  // 3) REPORT — honest reason + audit.
  const reason = allFindings.length === 0
    ? "No live search results found (SerpApi key not configured or no results). Configure PLATFORM_SERPAPI_API_KEY to run live market research."
    : `Found ${allFindings.length} result(s) across ${queries.length} quer${queries.length === 1 ? "y" : "ies"}.${rationale ? ` Plan: ${rationale}` : ""}`;

  await auditRun(repos, workspaceId, queries.length, allFindings.length, provider, reason);

  return {
    executed: true,
    queriesRun: queries.length,
    findings: allFindings,
    reason,
    provider,
  };
}

// ─── Default implementations (real integrations) ────────────────────────────

/** Default planner: the LLM market_research task. Honest mock fallback. */
async function defaultPlan(workspaceId: string, topic: string): Promise<{ queries: string[]; rationale: string }> {
  const llm = new LLMService();
  try {
    // 2026-08-07 real-AI proof-pass fix: the market_research prompt
    // (src/llm/prompts/index.ts) asks for `queries` as {query, rationale}[]
    // (a richer plan than a flat string list) and always has, but this
    // extraction assumed `queries: string[]`. A real model's response — which
    // correctly followed the prompt — made `.filter(q => q.trim())` below
    // throw ("q.trim is not a function", q being an object), caught by
    // runMarketResearch's outer try/catch and shown as "planning failed, add
    // a real AI key" even though the AI call succeeded and returned a good
    // plan. This task was 🟡 MOCK-only in the coverage map (never run against
    // a real model before today), so the crash was never observed.
    const result = await llm.runTask<{ queries?: Array<string | { query?: string; rationale?: string }>; rationale?: string; mock?: boolean }>(
      "market_research",
      { topic },
      { workspaceId },
    );
    if (result.mode === "mock" || result.output?.mock) {
      // Honest mock: a sensible deterministic plan, clearly labelled mock.
      return { queries: [`${topic} buyers`, `${topic} suppliers`, `${topic} wholesale`], rationale: "Mock plan (no real AI key)." };
    }
    const rawQueries = Array.isArray(result.output?.queries) ? result.output!.queries! : [];
    const queries = rawQueries
      .map((q) => (typeof q === "string" ? q : q?.query || ""))
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0);
    const rationale = result.output?.rationale
      || rawQueries.map((q) => (typeof q === "object" ? q?.rationale : undefined)).find(Boolean)
      || "";
    return { queries, rationale };
  } catch {
    return { queries: [`${topic} buyers`, `${topic} suppliers`, `${topic} wholesale`], rationale: "Mock plan (LLM unavailable)." };
  }
}

/** Default searcher: REAL SerpApi (Google search engine). Returns [] if no key.
 * CP-18c: a per-workspace key (passed in) overrides env. */
async function defaultSearch(query: string, workspaceKey?: string): Promise<MarketResearchFinding[]> {
  const key = (workspaceKey || process.env.PLATFORM_SERPAPI_API_KEY || process.env.SERPAPI_API_KEY || "").trim();
  if (!key) return []; // honest: no key → no results (never invents)

  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google");
  url.searchParams.set("q", query);
  url.searchParams.set("api_key", key);
  url.searchParams.set("num", "5"); // cap results per query (cost control)
  const safety = await assertSafeFetchUrl(url.toString());
  if (!safety.safe) return [];

  const res = await fetch(safety.url.toString(), { headers: { "user-agent": "LeadCockpitMarketResearch/0.1" } });
  if (!res.ok) return [];
  const payload = (await res.json()) as { organic_results?: Array<{ title?: string; snippet?: string; link?: string }> };
  return (payload.organic_results || []).slice(0, 5).map((r) => ({
    title: String(r.title || ""),
    snippet: String(r.snippet || ""),
    url: String(r.link || ""),
    sourceQuery: query,
  }));
}

async function auditRun(repos: RepositoryBundle, workspaceId: string, queriesRun: number, findingCount: number, provider: string, reason: string) {
  try {
    await new AuditLogService(repos).logAuditEvent({
      workspaceId,
      userId: "system",
      action: "market_research_run",
      entityType: "market_research",
      newValuesJson: { queriesRun, findingCount, provider },
      metadataJson: { note: reason.slice(0, 300) },
    });
  } catch {
    // Best-effort audit — must not abort the research result. (No-silent-failure:
    // a failure here is non-fatal because the research result itself is returned
    // to the caller; the audit is a secondary record.)
  }
}
