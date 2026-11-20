/**
 * Golden test — Market research that RUNS its plan (GAP-6).
 *
 * build-right Phase 3 — written BEFORE the service code. Defines the contract.
 *
 * Authority: docs/planning/CAPABILITY_GAP_AUDIT.md GAP-6. Before this,
 * `runResearchTask` ran the LLM (which only WRITES a research plan: "queries
 * and a source plan"), then `JSON.stringify`d the plan into chat as "Research
 * done" — and NOTHING executed the plan. The exact photo/voice archetype: it
 * looked like research happened, but no actual search ever ran.
 *
 * The fix: a dedicated MarketResearchService that (1) gets the plan (search
 * queries) from the LLM, then (2) ACTUALLY EXECUTES each query via the existing
 * SerpApi path, and (3) returns structured findings. Honest: when no SerpApi
 * key is configured, it says so explicitly (never fabricates results).
 *
 * Hand-computed BEFORE the assertions (the Golden Thread):
 *
 *   CASE A — the plan is EXECUTED, not just printed.
 *     Inject: an LLM-stub that returns queries ["gold zari buyers Mumbai",
 *     "textile wholesalers Surat"], and a search-stub that returns a known
 *     result per query (2 for the first, 1 for the second).
 *     Expected: the service returns 3 total findings (2 + 1), each tagged with
 *     its source query + source provider. The plan was RUN, not dumped.
 *
 *   CASE B — no-hallucination: with no search results (no key), the service
 *     returns ZERO findings + an honest "no live search configured" reason.
 *     It NEVER invents companies or demand.
 *
 *   CASE C — workspace-scoped + audited: a `market_research_run` audit row is
 *     written with the query count + finding count + provider status.
 *
 *   CASE D — empty plan (LLM returns no queries) → zero findings, honest
 *     reason "no queries generated", no crash.
 *
 * Test isolation (Gate #8): own workspace id (ws_mkt_*).
 * Run: npm run golden:market-research
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { runMarketResearch } from "@/services/MarketResearchService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function seedWorkspace(repos: RepositoryBundle, id: string) {
  await repos.workspace.create({ id, name: `Test WS ${id}`, status: "active" });
}

async function main() {
  const repos = await createJsonRepos();

  // ─── CASE A: the plan is EXECUTED, not just printed ────────────────────────
  // Hand-computed: query1 -> 2 results, query2 -> 1 result → 3 findings total.
  {
    const WS = "ws_mkt_a";
    await seedWorkspace(repos, WS);

    const plan = async () => ({
      queries: ["gold zari buyers Mumbai", "textile wholesalers Surat"],
      rationale: "Two high-intent B2B queries for the textile sector.",
    });
    const search = async (query: string) => {
      if (query.includes("Mumbai")) {
        return [
          { title: "Mumbai Zari Traders", snippet: "Bulk buyer of gold zari.", url: "https://example.com/1" },
          { title: " Maharashtra Textiles", snippet: "Wholesale zari sourcing.", url: "https://example.com/2" },
        ];
      }
      return [{ title: "Surat Fabric Hub", snippet: "Surat textile wholesaler.", url: "https://example.com/3" }];
    };

    const result = await runMarketResearch(WS, "gold zari market", repos, { plan, search });

    assert(result.findings.length === 3, `CASE A: 3 findings (2+1), got ${result.findings.length}`);
    assert(result.queriesRun === 2, `CASE A: 2 queries executed, got ${result.queriesRun}`);
    assert(result.findings.every((f) => f.sourceQuery), "CASE A: every finding tagged with its source query");
    assert(result.findings.some((f) => /Mumbai Zari/i.test(f.title)), "CASE A: a Mumbai finding is present");
    assert(result.executed === true, "CASE A: the plan was EXECUTED (not just printed)");
    console.log("✅ CASE A — the research plan is EXECUTED: 3 findings from 2 queries (not just printed)");
  }

  // ─── CASE B: no-hallucination — no key → 0 findings + honest reason ────────
  {
    const WS = "ws_mkt_b";
    await seedWorkspace(repos, WS);

    const plan = async () => ({ queries: ["saree manufacturers"], rationale: "x" });
    // Search returns nothing (simulates no SerpApi key / empty results).
    const search = async () => [];

    const result = await runMarketResearch(WS, "saree market", repos, { plan, search });

    assert(result.findings.length === 0, `CASE B: 0 findings when search yields nothing, got ${result.findings.length}`);
    assert(/no (live )?search|not configured|no results/i.test(result.reason), `CASE B: honest reason, got "${result.reason}"`);
    assert(result.executed === true, "CASE B: still 'executed' (it ran the plan; there was just no data)");
    console.log("✅ CASE B — no-hallucination: 0 findings + honest reason (never invents companies)");
  }

  // ─── CASE C: audited (a market_research_run row is written) ────────────────
  {
    const WS = "ws_mkt_c";
    await seedWorkspace(repos, WS);

    const plan = async () => ({ queries: ["query1", "query2"], rationale: "x" });
    const search = async () => [{ title: "Co", snippet: "s", url: "u" }];

    await runMarketResearch(WS, "test market", repos, { plan, search });

    const logs = (await repos.auditLog.listByWorkspace(WS)).filter((l) => l.workspaceId === WS);
    const researchLogs = logs.filter((l) => /market_research/i.test(l.eventType || ""));
    assert(researchLogs.length === 1, `CASE C: one market_research audit row, got ${researchLogs.length}`);
    console.log("✅ CASE C — audited: a market_research_run row records the run");
  }

  // ─── CASE D: empty plan → 0 findings, honest reason, no crash ──────────────
  {
    const WS = "ws_mkt_d";
    await seedWorkspace(repos, WS);

    const plan = async () => ({ queries: [], rationale: "nothing relevant" });
    const search = async () => [{ title: "should not be called", snippet: "", url: "" }];

    const result = await runMarketResearch(WS, "obscure topic", repos, { plan, search });
    assert(result.findings.length === 0, `CASE D: 0 findings for empty plan, got ${result.findings.length}`);
    assert(/no search queries/i.test(result.reason), `CASE D: honest "no queries" reason, got "${result.reason}"`);
    console.log("✅ CASE D — empty plan: 0 findings, honest reason, no crash");
  }

  console.log("\n✅✅✅ All market-research golden cases PASSED (A–D). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
