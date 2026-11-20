/**
 * Golden test — the model can be asked to look at an existing lead again, and
 * the screen says who did the looking.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * A live workspace held fifty-four discovered companies. Fifty of them still
 * carried the sentence discovery had written when it found them, and four
 * carried real model reasoning. The operator asked why, and reading the code
 * gave the answer:
 *
 *   - `POST /api/leads/:id/score` and the "Score all" button both ran
 *     `scoreLead()`, which is arithmetic over which fields happen to be
 *     non-empty. It OVERWRITES `scoreReason` with a restatement of its own
 *     four numbers — so pressing the button labelled "Score" replaced whatever
 *     the model had said with "Fit 4/5, need 4/5, reachability 4/5...".
 *   - The model path, `qualifyLead`, existed and was good. It ran only during
 *     discovery, on a candidate that was not a lead yet. Nothing in the
 *     product could point it at a lead that already existed.
 *   - The lead drawer, when a lead had no reason text at all, INVENTED a
 *     paragraph: "The agent detected patterns suggesting they are currently
 *     sourcing products like yours." No agent had detected anything. That is
 *     the product asserting an analysis that was never performed.
 *
 * The same shape as the other seven defects this session: an engine built and
 * wired, with the one control that turns it on never shipped.
 *
 *   CASE A — an existing lead can be turned into something the scorer accepts,
 *     and the candidate carries NO identity or audit keys. `qualifyLead`
 *     spreads its candidate into its return value and the caller writes that
 *     back, so an id or a createdAt riding along would be written over the
 *     real one.
 *
 *   CASE B — the candidate still carries the facts the model needs to judge
 *     with. Stripping too much would make every re-score an opinion about an
 *     empty company.
 *
 *   CASE C — only score fields are written back, whatever the model returns.
 *     This is the second half of CASE A and the one that actually protects the
 *     row: even if a candidate key slipped through, the write-back allowlist
 *     stops it reaching the database.
 *
 *   CASE D — the single-lead route asks the model, and ONLY the model
 *     (2026-09-25: lead scoring is AI only). A failed answer changes nothing.
 *
 *   CASE E — "Score with AI" is capped and never re-reads a lead the AI has
 *     already scored, because that button is one click and a workspace can
 *     hold thousands of leads.
 *
 *   CASE F — the screen stops inventing an analysis, says whether the AI has
 *     scored the lead, and offers the (re-)score.
 *
 * Substrate: the two real pure helpers, plus a static read of the route and the
 * screen. No repository, no network, no AI.
 */
import "./_helpers/isolate-standalone";
import type { Lead } from "@/lib/types";
import {
  leadToScoringCandidate,
  scoreFieldsFrom,
  RESCORE_WRITEBACK_KEYS,
  campaignForScoring,
} from "@/services/ProspectingService";
import { scoringIcpFor } from "@/services/ProspectingService";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const ROUTE = "src/app/api/[[...path]]/route.ts";
const SERVICE = "src/services/ProspectingService.ts";
const SCREEN = "src/app/page.tsx";

function existingLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "lead_existing_1",
    workspaceId: "w1",
    campaignId: "camp_1",
    icpId: "icp_1",
    companyName: "Northwind Components",
    contactName: "A. Buyer",
    websiteUrl: "https://example.com",
    email: "buyer@example.com",
    phone: "+10000000000",
    city: "Springfield",
    country: "India",
    industry: "Component manufacturing",
    buyerType: "manufacturer",
    fitReason: "Buys the category in bulk",
    discoveredInfo: "Listed a large catalogue",
    personalizationNote: "Recently expanded their line",
    source: "google_maps",
    leadScore: 14, fitScore: 4, needScore: 4, reachabilityScore: 4, timingScore: 2,
    confidenceScore: 0.6,
    qualificationStatus: "mql",
    scoreReason: { reason: "Found from Google Maps query", evidence: { searchQuery: "component manufacturers" } },
    status: "discovered",
    enrichmentStatus: "not_started",
    reviewStatus: "pending",
    doNotContact: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  } as Lead;
}

async function main() {
  console.log("=== GOLDEN: the model can be asked to look again ===\n");

  const route = readSource(ROUTE);
  const screen = readSource(SCREEN);
  const service = readSource(SERVICE);

  // ---------------------------------------------------------------- CASE A
  {
    const candidate = leadToScoringCandidate(existingLead()) as Record<string, unknown>;
    for (const forbidden of ["id", "workspaceId", "createdAt", "updatedAt", "status", "reviewStatus", "leadScore", "scoreReason", "enrichmentStatus", "doNotContact"]) {
      assert(
        !(forbidden in candidate),
        `CASE A: the scoring candidate carries "${forbidden}" — qualifyLead spreads the candidate into what the caller writes back, so this would overwrite the real value`,
      );
    }
    assert(typeof candidate.searchQuery === "string" && candidate.searchQuery.length > 0, "CASE A: the candidate must record what it is being scored against");
    assert(candidate.searchMode === "existing_lead_rescore", `CASE A: a re-score must say it is a re-score, got ${String(candidate.searchMode)}`);
    console.log("✅ CASE A — an existing lead becomes a candidate, without its identity");
  }

  // ---------------------------------------------------------------- CASE B
  {
    const candidate = leadToScoringCandidate(existingLead()) as Record<string, unknown>;
    for (const kept of ["companyName", "industry", "buyerType", "websiteUrl", "city", "country", "email", "phone", "fitReason", "discoveredInfo"]) {
      assert(candidate[kept], `CASE B: the model cannot judge a lead it is not shown — "${kept}" was stripped`);
    }
    // The original discovery query is provenance, and survives.
    assert(candidate.searchQuery === "component manufacturers", `CASE B: the original discovery query must be carried through, got ${String(candidate.searchQuery)}`);
    // An empty lead must not produce empty-string keys the model reads as facts.
    const bare = leadToScoringCandidate({ id: "l", workspaceId: "w1", companyName: "" } as Lead) as Record<string, unknown>;
    assert(!("companyName" in bare), "CASE B: an empty field must be absent, not present and blank");
    console.log("✅ CASE B — the facts the model needs survive the trip");
  }

  // ---------------------------------------------------------------- CASE C
  {
    const written = scoreFieldsFrom({
      id: "SOMETHING_ELSE",
      workspaceId: "OTHER_WORKSPACE",
      createdAt: "1999-01-01T00:00:00.000Z",
      status: "won",
      companyName: "Renamed By The Model",
      fitScore: 5, needScore: 5, reachabilityScore: 5, timingScore: 4,
      leadScore: 19, qualificationStatus: "sql", confidenceScore: 0.9,
      fitReason: "Evidence-based reason", relevancyReason: "Evidence-based reason",
      scoreReason: { reason: "Evidence-based reason", scoresFrom: "model" },
    } as Partial<Lead>) as Record<string, unknown>;

    for (const forbidden of ["id", "workspaceId", "createdAt", "status", "companyName"]) {
      assert(!(forbidden in written), `CASE C: a re-score wrote "${forbidden}" back to the lead — scoring must not rename, re-own or re-date a record`);
    }
    for (const expected of ["fitScore", "needScore", "reachabilityScore", "timingScore", "leadScore", "qualificationStatus", "fitReason", "scoreReason"]) {
      assert(expected in written, `CASE C: the re-score did not write "${expected}" — the score would not change`);
    }
    assert(
      !(RESCORE_WRITEBACK_KEYS as readonly string[]).includes("id"),
      "CASE C: the write-back allowlist itself must not contain identity keys",
    );
    // A model that returns nothing must write nothing rather than blanking the row.
    assert(Object.keys(scoreFieldsFrom({})).length === 0, "CASE C: an empty result must clear nothing");
    console.log("✅ CASE C — only the score is written back");
  }

  // ---------------------------------------------------------------- CASE D
  {
    const branch = route.slice(
      route.indexOf(`if (match(path, ["leads", ":id", "score"]))`),
      route.indexOf(`if (match(path, ["leads", ":id", "review-decision"]))`),
    );
    assert(branch.length > 0, `CASE D: could not isolate the single-lead score route in ${ROUTE}`);
    assert(/rescoreLead\(/.test(branch), "CASE D: scoring a lead must ask the model");
    assert(!/scoreLead\(lead|useModel/.test(branch), "CASE D: the rule-based path must be gone — lead scoring is AI only");
    assert(/if \(!aiScored\) \{[\s\S]*?return json\(\{ \.\.\.lead, aiScored: false/.test(branch),
      "CASE D: when the AI does not score, the lead must be returned UNCHANGED — a failed re-score must not wipe the AI's earlier score");
    console.log("✅ CASE D — one lead is scored by the AI only, and a failure changes nothing");
  }

  // ---------------------------------------------------------------- CASE E
  {
    const branch = route.slice(
      route.indexOf(`if (match(path, ["leads", "bulk-score"]))`),
      route.indexOf(`if (match(path, ["messages", "generate"]))`),
    );
    assert(branch.length > 0, `CASE E: could not isolate the bulk-score route in ${ROUTE}`);
    assert(/scoreLeadsAwaitingAi\(/.test(branch) && /Math\.min\(/.test(branch), "CASE E: bulk scoring must go through the capped shared pass");
    const fn = service.slice(service.indexOf("export async function scoreLeadsAwaitingAi"));
    assert(/!isAiScored\(lead\)/.test(fn), "CASE E: the pass must skip leads the AI already scored — one click would otherwise re-buy every opinion");
    assert(/stoppedReason = result\.reason;\s*break;/.test(fn), "CASE E: the pass must stop at the first failure instead of calling a dead AI again and again");
    assert(/waiting\.slice\(0, options\.limit\)/.test(fn), "CASE E: the pass must respect its budget");
    console.log("✅ CASE E — 'Score with AI' is capped, skips what the AI already read, and stops when the AI is down");
  }

  // ---------------------------------------------------------------- CASE F
  {
    assert(
      !/The agent detected patterns suggesting/.test(screen),
      `CASE F: ${SCREEN} still invents an analysis when the AI produced none`,
    );
    assert(/isAiScored\(drawerLead\)/.test(screen), "CASE F: the drawer never says whether the AI scored this lead");
    assert(/Score with AI/.test(screen), "CASE F: the operator has no way to ask the AI to score");
    assert(!/Scored by the simple rules/.test(screen), "CASE F: the screen still offers rule-based scores");
    console.log("✅ CASE F — the screen says whether the AI scored it, and offers the score");
  }

  // ---------------------------------------------------------------- CASE F2
  {
    const call = screen.slice(screen.indexOf(`"/api/leads/bulk-score"`), screen.indexOf(`"/api/leads/bulk-score"`) + 1200);
    assert(call.length > 0, "CASE F2: setup — the leads screen no longer calls bulk-score");
    assert(/stillWaiting/.test(call) && /aiScored/.test(call),
      "CASE F2: the screen does not read back how many leads the AI scored and how many still wait, so a capped pass looks like a finished one");
    console.log("✅ CASE F2 — the AI pass is reachable, and says how much of the pipeline is still waiting");
  }

  // ---------------------------------------------------------------- CASE F3
  {
    // Measured on the live demo (2026-09-09): ~3.5–8s of model call per lead.
    // Past about a minute the caller gives up while the server finishes and
    // bills for it. The default budget must fit inside one request.
    const branch = route.slice(route.indexOf(`if (match(path, ["leads", "bulk-score"]))`));
    const budget = branch.match(/Number\(body\.limit\) \|\| (\d+)/);
    assert(budget, "CASE F3: the model budget is no longer a literal default — check it still fits in one request");
    assert(Number(budget![1]) <= 10, `CASE F3: the default model budget is ${budget![1]} leads — too many for one request`);
    console.log(`✅ CASE F3 — the default AI pass (${budget![1]} leads) finishes inside a request`);
  }

  // ---------------------------------------------------------------- CASE G
  {
    // Found on the live demo, 2026-09-09: one lead was still attached to an
    // ICP the owner had ARCHIVED, together with the campaign built from it.
    // Asked to score it, the model was told the target market was one the
    // business had abandoned, and judged the lead against that — correctly,
    // and uselessly. Archiving an ICP is the owner saying "this is not who we
    // sell to any more"; continuing to score by it is the one reading of the
    // record that cannot be what they meant. Same fallback as a lead with no
    // ICP at all, which is every CSV import.
    const selected = { id: "icp_selected", status: "selected", name: "Who we sell to now" };
    const archived = { id: "icp_archived", status: "archived", name: "Who we used to sell to" };
    const attached = { id: "icp_attached", status: "suggested", name: "Attached and still current" };
    const all = [selected, archived, attached];
    const repos = {
      icp: {
        getById: async (_ws: string, id: string) => all.find((row) => row.id === id),
        // The real listByWorkspace excludes archived rows, as Postgres does.
        listByWorkspace: async () => all.filter((row) => row.status !== "archived"),
      },
    } as unknown as Parameters<typeof scoringIcpFor>[0];

    const forLead = async (icpId?: string) =>
      (await scoringIcpFor(repos, "w1", { icpId } as Lead))?.id;

    assert(
      (await forLead("icp_archived")) === "icp_selected",
      "CASE G: a lead attached to an ARCHIVED ICP is still scored against it — the model is told the target market is one the owner abandoned",
    );
    assert(
      (await forLead(undefined)) === "icp_selected",
      "CASE G: a lead with no ICP - every CSV import - is scored against no ICP at all",
    );
    assert(
      (await forLead("icp_attached")) === "icp_attached",
      "CASE G: a lead attached to a LIVE ICP must keep it — the fallback must not override a deliberate attachment",
    );

    // Nothing selected: score without an ICP rather than refuse. A workspace
    // mid-setup must not have its scoring blocked.
    const noneSelected = {
      icp: { getById: async () => undefined, listByWorkspace: async () => [] },
    } as unknown as Parameters<typeof scoringIcpFor>[0];
    assert(
      (await scoringIcpFor(noneSelected, "w1", { icpId: "gone" } as Lead)) === undefined,
      "CASE G: with no ICP selected the caller must score without one, not throw",
    );

    // And both scoring routes must actually use it, or the two can drift apart
    // on which ICP a lead is judged by.
    assert(/scoringIcpFor\(repos, workspaceId, lead\)/.test(service.slice(service.indexOf("export async function scoreLeadsAwaitingAi"))),
      "CASE G: the bulk AI pass resolves the ICP itself instead of through scoringIcpFor");
    for (const marker of [`["leads", ":id", "score"]`]) {
      const start = route.indexOf(`if (match(path, ${marker}))`);
      assert(start >= 0, `CASE G: setup — the ${marker} route is gone`);
      // To the START of the next route, so the window is the branch itself
      // rather than an arbitrary character count that a comment can push past.
      const next = route.indexOf("if (match(path, [", start + 1);
      const branch = route.slice(start, next > start ? next : undefined);
      assert(
        /scoringIcpFor\(/.test(branch),
        `CASE G: the ${marker} route resolves the ICP itself instead of through scoringIcpFor`,
      );
    }
    console.log("✅ CASE G — an archived or missing ICP falls back to the one the owner has selected");
  }

  // ---------------------------------------------------------------- CASE H
  {
    // The other half of CASE G, and the half that proved resolving the ICP
    // alone was not enough. `qualifyLead` reads the goal, target region and
    // product focus off the CAMPAIGN — that is how the model is told what this
    // business sells. With the ICP corrected and the campaign left as stored,
    // the live demo still answered:
    //
    //   "The campaign targets US wholesale distribution companies for
    //    enterprise software..."
    //
    // for a workspace selling zari thread in Surat. The model was handed two
    // contradictory descriptions of the same business and used the more
    // specific one, which was the stale one.
    const icp = { id: "icp_current" } as unknown as Parameters<typeof campaignForScoring>[1];
    const ofThisIcp = { id: "c1", icpId: "icp_current" } as Parameters<typeof campaignForScoring>[0];
    const ofRetiredIcp = { id: "c2", icpId: "icp_retired" } as Parameters<typeof campaignForScoring>[0];
    const ofNoIcp = { id: "c3", icpId: "" } as Parameters<typeof campaignForScoring>[0];

    assert(
      campaignForScoring(ofRetiredIcp, icp) === undefined,
      "CASE H: a campaign built from a RETIRED ideal customer is still used as context — the model is told what the business used to sell",
    );
    assert(
      campaignForScoring(ofThisIcp, icp) === ofThisIcp,
      "CASE H: the lead's own campaign must be used when it agrees with the ICP — a re-score must not throw away real context",
    );
    assert(
      campaignForScoring(ofNoIcp, icp) === ofNoIcp,
      "CASE H: a campaign with no ICP of its own contradicts nothing and must be kept",
    );
    assert(
      campaignForScoring(ofRetiredIcp, undefined) === ofRetiredIcp,
      "CASE H: with no ICP to disagree with, the attached campaign is all the context there is",
    );
    assert(
      campaignForScoring(undefined, icp) === undefined,
      "CASE H: no campaign means the caller must build the stand-in",
    );
    console.log("✅ CASE H — a campaign that disagrees with the ICP is not used as context");
  }

  console.log("\n=== GOLDEN PASSED (A-H) ===");
}

main();
