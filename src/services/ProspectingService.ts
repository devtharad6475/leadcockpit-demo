import { NeedsActionError } from "@/lib/user-errors";
import * as cheerio from "cheerio";
import { calculateFNRTScore, isAiScored } from "@/lib/lead-rules";
import type { Campaign, ICP, Lead } from "@/lib/types";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { LLMService } from "@/llm/LLMService";
import type { LLMTaskResult } from "@/llm/types";
import { timestamp } from "@/lib/db";
import { isContactBlocked } from "@/lib/dnc-registry";
import { isSameCompany, websiteKey } from "@/lib/same-company";
import { safeFetch } from "@/lib/ssrf-guard";
import { getAuthMode } from "@/lib/auth";
import { defaultWorkspaceId } from "@/lib/db";

/**
 * "search_unavailable" (2026-09-27, break test L1): no search key, or the
 * search failed, in a workspace that is not the sample company. Nothing is
 * invented; the run finds nobody and says why.
 */
export type ProspectingMode = "live_google_maps" | "llm_assisted_demo" | "fallback_demo" | "search_unavailable";

/** Message the owner sees when discovery had no working search. */
export const SEARCH_NOT_CONNECTED_MESSAGE = "Search is not connected — no new buyers found today. Connect Google Maps search (SerpApi) under Integrations.";

/**
 * Invented sample prospects are allowed ONLY for the built-in sample company
 * on the demo site (AUTH_MODE=demo, workspace_demo). Anywhere else they would
 * become real-looking leads with drafted first messages.
 */
export function allowsInventedProspects(workspaceId: string | undefined): boolean {
  return getAuthMode() === "demo" && workspaceId === defaultWorkspaceId;
}

/**
 * Where a scoring candidate came from. A discovery run produces the three
 * ProspectingMode values; "existing_lead_rescore" is the fourth - a lead
 * already in the workspace, shown to the model a second time. It is
 * deliberately NOT a ProspectingMode: no discovery run can report it, and the
 * run's modeLabel must not have to account for it.
 */
export type CandidateOrigin = ProspectingMode | "existing_lead_rescore";

export type ProspectingCandidate = Partial<Lead> & {
  searchQuery: string;
  searchMode: CandidateOrigin;
  sourceProvider: string;
  rawContext?: string;
};

export type WebsiteContactInfo = {
  title?: string;
  description?: string;
  emails: string[];
  phones: string[];
  socialUrls: string[];
  linkedinUrl?: string;
  instagramUrl?: string;
  facebookUrl?: string;
  fetched: boolean;
  error?: string;
};

export type ProspectingRunResult = {
  status: "completed";
  mode: ProspectingMode;
  modeLabel: string;
  providerStatus: {
    serpApiConfigured: boolean;
    provider: string;
    modelName?: string;
    llmMode?: string;
    fallbackUsed?: boolean;
    warning?: string;
  };
  queries: string[];
  leads: Lead[];
  /**
   * 2026-09-26 (break test): which of `leads` were created by this run. The
   * daily scheduler assumed the first `created` entries were the new ones, but
   * found-again and new leads are interleaved in discovery order, so it drafted
   * first messages for leads it already had and skipped the new ones.
   */
  newLeadIds: string[];
  created: number;
  updated: number;
  duplicatesAvoided: number;
  scrapedWebsites: number;
  runId: string;
  warnings: string[];
};

type SearchResult = {
  mode: ProspectingMode;
  provider: string;
  warning?: string;
  candidates: ProspectingCandidate[];
};

type ScoreOutput = {
  fitScore?: number;
  needScore?: number;
  reachabilityScore?: number;
  timingScore?: number;
  fitReason?: string;
  // The lead-scoring prompt asks the model for `reason`, not `fitReason`, and
  // nothing here used to read it. Every scored lead therefore stored the
  // discovery template - "Found from Google Maps query X. Review before
  // outreach." - as its justification, next to provider "deepseek" and
  // mode "real", so the screen credited the model with a sentence it never
  // wrote and the operator never saw why a lead scored what it scored.
  reason?: string;
  scoreReason?: Record<string, unknown>;
};

export class ProspectingService {
  constructor(
    private readonly repos: RepositoryBundle = createRepositories(),
    private readonly llm: LLMService = new LLMService(undefined, repos),
  ) {}

  async prospectForWorkspace(input: {
    workspaceId: string;
    campaignId: string;
    icpId?: string;
    query?: string;
    region?: string;
    limit?: number;
  }): Promise<ProspectingRunResult> {
    const workspaceId = input.workspaceId;
    // CP-18c (2026-08-02) — per-workspace SerpApi key overrides env. Resolve
    // once for the run; threaded into searchGoogleMaps (env fallback inside).
    let workspaceSerpApiKey: string | undefined;
    try {
      const { IntegrationCredentialService } = await import("@/services/IntegrationCredentialService");
      workspaceSerpApiKey = await new IntegrationCredentialService(this.repos).resolveKey(workspaceId, "serpapi");
    } catch {
      workspaceSerpApiKey = undefined; // env fallback
    }
    const campaign = await this.repos.campaign.getById(workspaceId, input.campaignId);
    if (!campaign) throw new NeedsActionError("Approve a campaign first — finding new leads runs from an approved campaign (Prospecting → Campaign).");
    const icp = input.icpId
      ? await this.repos.icp.getById(workspaceId, input.icpId)
      : campaign.icpId
        ? await this.repos.icp.getById(workspaceId, campaign.icpId)
        : undefined;
    // Use nullish coalescing (`??`), NOT logical-or (`||`): `0` is a valid input
    // that must be clamped UP to 1 by Math.max, but `0 || 5 === 5` (0 is falsy),
    // which silently swallowed 0 and made the lower clamp dead code. `??` only
    // falls back to the default for null/undefined, so explicit 0 now reaches
    // the clamp and becomes 1 (audit-finding batch 3, root-caused 2026-07-27).
    const limit = Math.max(1, Math.min(Number(input.limit ?? 5), 12));
    const run = await this.repos.agentRun.create({
      workspaceId,
      agentName: "Prospect Discovery Agent",
      input: { campaignId: campaign.id, icpId: icp?.id, query: input.query, region: input.region, limit },
      status: "running",
      startedAt: timestamp(),
    });

    const warnings: string[] = [];
    try {
      const queryResult = await this.generateSearchQueries(workspaceId, campaign, icp, input.query, input.region);
      if (queryResult.warning) warnings.push(queryResult.warning);
      const queries = queryResult.queries.slice(0, 5);
      const candidates: ProspectingCandidate[] = [];
      let mode: ProspectingMode = this.hasSerpApiKey() || workspaceSerpApiKey ? "live_google_maps" : allowsInventedProspects(workspaceId) ? "llm_assisted_demo" : "search_unavailable";
      let scrapedWebsites = 0;

      for (const query of queries) {
        if (candidates.length >= limit) break;
        const search = await this.searchGoogleMaps(query, Math.max(1, limit - candidates.length), campaign, icp, workspaceSerpApiKey);
        if (search.warning) warnings.push(search.warning);
        if (search.mode === "search_unavailable") {
          // No working search: asking again with the next query only repeats it.
          if (!candidates.length) mode = "search_unavailable";
          break;
        }
        mode = search.mode;
        for (const candidate of search.candidates) {
          if (candidates.length >= limit) break;
          const contactInfo = candidate.websiteUrl ? await scrapeWebsiteContacts(candidate.websiteUrl) : emptyContactInfo();
          if (contactInfo.fetched) scrapedWebsites += 1;
          if (contactInfo.error && search.mode === "live_google_maps") warnings.push(`${candidate.companyName || "Prospect"} website scrape skipped: ${contactInfo.error}`);
          candidates.push(mergeCandidateContactInfo(candidate, contactInfo));
        }
      }

      // 2026-09-26 (break test): duplicates were looked for only inside THIS
      // campaign, so a company already a lead from another campaign or a CSV
      // was added a second time — and one marked do-not-contact there came
      // back as a fresh, contactable lead. The whole workspace is searched now.
      const existingLeads = await this.repos.lead.listLeads(workspaceId);
      const leads: Lead[] = [];
      const newLeadIds: string[] = [];
      const updatedLeadIds = new Set<string>();
      let created = 0;

      for (const candidate of candidates) {
        const qualified = await this.qualifyLead(workspaceId, candidate, campaign, icp);
        const existing = findExistingLead(existingLeads, qualified);
        if (existing) {
          // 2026-09-26 (break test): finding a company again used to write the
          // whole new-lead record over it — status "needs_review", review
          // "pending", consent "none", enrichment "not_started". A lead already
          // approved, contacted, won or rejected by the owner went back to the
          // start, and a daily re-run did it every morning. Re-discovery now
          // only FILLS what the lead is missing (non-destructive, like every
          // other source) and never touches its stage, review, consent,
          // enrichment, campaign or an AI score it already has.
          const permanentBlock = await isContactBlocked(workspaceId, existing, this.repos);
          const preservedDnc = existing.doNotContact || permanentBlock.blocked;
          const patch = rediscoveryPatch(existing, qualified);
          if (preservedDnc) {
            patch.doNotContact = true;
            if (!existing.doNotContact) patch.status = "do_not_contact";
          }
          const updatedLead = Object.keys(patch).length
            ? await this.repos.lead.updateLead(workspaceId, existing.id, patch)
            : existing;
          Object.assign(existing, updatedLead);
          if (!updatedLeadIds.has(existing.id)) {
            updatedLeadIds.add(existing.id);
            leads.push(updatedLead);
          }
          continue;
        }
        const leadInput: Partial<Lead> = {
          ...qualified,
          workspaceId,
          campaignId: campaign.id,
          icpId: icp?.id || campaign.icpId,
          source: qualified.source || (mode === "live_google_maps" ? "serpapi_google_maps" : "llm_assisted_demo"),
          status: "needs_review",
          reviewStatus: "pending",
          enrichmentStatus: "not_started",
          consentStatus: "none",
        };
        // Check the complete contact identity, including BOTH phone numbers.
        // A different WhatsApp number must not hide a permanent phone opt-out.
        // Registry errors propagate: discovery cannot safely recreate a buyer
        // while their opt-out status is unavailable.
        if ((await isContactBlocked(workspaceId, qualified, this.repos)).blocked) continue;
        const createdLead = await this.repos.lead.createLead({
          ...leadInput,
          doNotContact: false,
        });
        existingLeads.push(createdLead);
        leads.push(createdLead);
        newLeadIds.push(createdLead.id);
        created += 1;
      }

      const updated = updatedLeadIds.size;
      const output: ProspectingRunResult = {
        status: "completed",
        mode,
        modeLabel: mode === "live_google_maps" ? "Live Google Maps Search + Crawler" : mode === "llm_assisted_demo" ? "LLM-assisted Demo Mode" : mode === "search_unavailable" ? "Search is not connected" : "Fallback Demo Mode",
        providerStatus: {
          serpApiConfigured: Boolean(workspaceSerpApiKey || this.hasSerpApiKey()),
          provider: queryResult.llm?.provider || (mode === "live_google_maps" ? "serpapi" : "mock"),
          modelName: queryResult.llm?.modelName,
          llmMode: queryResult.llm?.mode,
          fallbackUsed: Boolean(queryResult.llm?.fallbackUsed),
          warning: queryResult.llm?.warning,
        },
        queries,
        leads,
        newLeadIds,
        created,
        updated,
        duplicatesAvoided: updated,
        scrapedWebsites,
        runId: run.id,
        warnings: Array.from(new Set(warnings)).slice(0, 6),
      };

      await this.repos.agentRun.update(workspaceId, run.id, {
        status: "completed",
        output: {
          mode: output.mode,
          modeLabel: output.modeLabel,
          queries: output.queries,
          leadIds: output.leads.map((lead) => lead.id),
          created,
          updated,
          scrapedWebsites,
          warnings: output.warnings,
        },
        completedAt: timestamp(),
      });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Prospect discovery failed.";
      await this.repos.agentRun.update(workspaceId, run.id, { status: "failed", errorMessage: message, completedAt: timestamp() });
      throw error;
    }
  }

  async generateSearchQueries(workspaceId: string, campaign: Campaign, icp?: ICP, query?: string, region?: string) {
    const existingQueries = [
      query,
      ...(campaign.plan?.searchQueries || []),
      icp?.buyerType && region ? `${icp.buyerType} ${region}` : undefined,
    ].filter(Boolean).map(String);
    const fallback = unique(existingQueries.length ? existingQueries : deterministicQueries(campaign, icp, region));
    let llm: LLMTaskResult<Record<string, unknown>> | undefined;
    try {
      llm = await this.llm.runTask<Record<string, unknown>>("prospect_research", {
        campaign: {
          name: campaign.name,
          goal: campaign.goal,
          targetRegion: campaign.targetRegion,
          productFocus: campaign.productFocus,
          searchQueries: campaign.plan?.searchQueries || [],
        },
        icp: icp ? {
          name: icp.name,
          buyerType: icp.buyerType,
          industries: icp.industries,
          geography: icp.geography,
          likelyNeeds: icp.likelyNeeds,
          qualificationRules: icp.qualificationRules,
        } : undefined,
        requestedQuery: query,
        region,
        expectedOutput: { queries: ["3 to 5 Google Maps search phrases"] },
      }, { workspaceId });
      const parsed = parseQueryOutput(llm.output);
      return {
        queries: unique([query, ...parsed, ...fallback]).filter(Boolean).slice(0, 5),
        llm,
        warning: llm.mode === "mock" ? "Search queries used the mock research route because no real research model is configured." : llm.warning,
      };
    } catch (error) {
      return {
        queries: fallback.slice(0, 5),
        llm,
        warning: error instanceof Error ? `Research model was unavailable; deterministic campaign queries were used. ${error.message}` : "Research model was unavailable; deterministic campaign queries were used.",
      };
    }
  }

  async searchGoogleMaps(query: string, limit: number, campaign?: Campaign, icp?: ICP, workspaceKey?: string): Promise<SearchResult> {
    // CP-18c: per-workspace key (passed in) overrides env.
    const key = (workspaceKey || this.serpApiKey());
    // 2026-09-27 (break test L1): with no key, or a failed search, this used to
    // hand back invented companies in EVERY workspace, and the daily run turned
    // them into leads with drafted messages and reported no problem. Invented
    // prospects are for the sample company on the demo site only.
    const inventedAllowed = allowsInventedProspects(campaign?.workspaceId);
    if (!key) {
      if (!inventedAllowed) {
        return { mode: "search_unavailable", provider: "none", warning: SEARCH_NOT_CONNECTED_MESSAGE, candidates: [] };
      }
      return {
        mode: "llm_assisted_demo",
        provider: "mock",
        warning: "SerpApi key is not configured, so discovery used LLM-assisted demo prospects for review.",
        candidates: demoCandidates(query, limit, campaign, icp),
      };
    }

    try {
      const url = new URL("https://serpapi.com/search.json");
      url.searchParams.set("engine", "google_maps");
      url.searchParams.set("type", "search");
      url.searchParams.set("q", query);
      url.searchParams.set("api_key", key);
      const response = await fetchWithTimeout(url.toString(), 8000);
      if (!response.ok) throw new Error(`SerpApi returned ${response.status}`);
      const payload = await response.json() as { local_results?: Array<Record<string, unknown>>; error?: string };
      if (payload.error) throw new Error(payload.error);
      return {
        mode: "live_google_maps",
        provider: "serpapi",
        candidates: (payload.local_results || []).slice(0, limit).map((item) => serpApiResultToCandidate(query, item)),
      };
    } catch (error) {
      // 2026-08-05 (build-right Phase 4 — no silent failures): a SerpApi
      // outage MUST NOT silently look like "0 candidates / demo mode." Log the
      // real error loudly so the operator sees discovery is broken, then fall
      // back to demo prospects (better a noisy fallback than a silent zero).
      const reason = error instanceof Error ? error.message : String(error);
      if (!inventedAllowed) {
        console.error(`[ProspectingService] SerpApi Google Maps search FAILED for query "${query}": ${reason}. No prospects this run — discovery is NOT live right now.`);
        return {
          mode: "search_unavailable",
          provider: "serpapi",
          warning: `Search failed (${reason}) — no new buyers found today. Check the Google Maps search (SerpApi) key under Integrations.`,
          candidates: [],
        };
      }
      console.error(`[ProspectingService] SerpApi Google Maps search FAILED for query "${query}": ${reason}. Falling back to demo prospects — discovery is NOT live right now.`);
      return {
        mode: "fallback_demo",
        provider: "serpapi",
        warning: `Live Google Maps search FAILED (${reason}). Demo prospects used — discovery is not live. Check PLATFORM_SERPAPI_API_KEY + network.`,
        candidates: demoCandidates(query, limit, campaign, icp),
      };
    }
  }

  async qualifyLead(workspaceId: string, candidate: ProspectingCandidate, campaign: Campaign, icp?: ICP): Promise<Partial<Lead>> {
    let llmOutput: ScoreOutput = {};
    let llmMeta: Partial<LLMTaskResult<ScoreOutput>> = {};
    try {
      const result = await this.llm.runTask<ScoreOutput>("lead_scoring", {
        lead: candidate,
        campaign: { name: campaign.name, goal: campaign.goal, productFocus: campaign.productFocus, targetRegion: campaign.targetRegion },
        icp,
        expectedOutput: { fitScore: 0, needScore: 0, reachabilityScore: 0, timingScore: 0, fitReason: "Evidence-based reason" },
      }, { workspaceId });
      llmOutput = typeof result.output === "object" && result.output ? result.output : {};
      llmMeta = result;
    } catch (error) {
      llmOutput = {};
      llmMeta = { mode: "unavailable" as never, warning: error instanceof Error ? error.message : String(error) };
    }

    // 2026-09-25 (CEO decision: lead scoring is AI ONLY). A score counts only
    // when a REAL model produced the numbers. Sample mode, a fallback model's
    // guess, an outage or an answer with no numbers in it all leave the lead
    // "not_scored" - it is never filled in by a rule. The rule this replaced
    // was measured at 93% against the AI's 99% (docs/planning/JEV_TRIAL.md),
    // and the owner chose waiting over guessing. Leads waiting are picked up by
    // "Score with AI" on the Leads screen and by the daily scheduler.
    const numbers = ["fitScore", "needScore", "reachabilityScore", "timingScore"]
      .map((key) => Number((llmOutput as Record<string, unknown>)[key]));
    const aiScored = numbers.every(Number.isFinite) && llmMeta.mode === "real" && !llmMeta.fallbackUsed;
    // A-7 (2026-08-25): searchQuery / searchMode / sourceProvider / rawContext
    // describe the discovery RUN, not the lead, and have no Postgres column -
    // spreading them into lead.create() broke every discovery on Postgres. They
    // are kept as provenance in scoreReason.evidence; rawContext is dropped.
    const { searchQuery, searchMode, sourceProvider, rawContext, ...leadFields } = candidate;
    void rawContext;
    const evidence = {
      searchQuery,
      searchMode,
      sourceProvider,
      website: candidate.websiteUrl,
      contactSignals: [candidate.email, candidate.phone, candidate.linkedinUrl, candidate.instagramUrl, candidate.facebookUrl].filter(Boolean).length,
    };
    if (!aiScored) {
      const why = llmMeta.mode === "mock" ? "the AI is in sample mode"
        : llmMeta.fallbackUsed ? "only a backup answered, not your chosen AI"
        : String(llmMeta.mode) === "unavailable" ? "the AI could not be reached"
        : "the AI did not return a score";
      return {
        ...leadFields,
        fitScore: 0,
        needScore: 0,
        reachabilityScore: 0,
        timingScore: 0,
        leadScore: 0,
        qualificationStatus: "not_scored",
        confidenceScore: candidate.confidenceScore || 0.45,
        fitReason: candidate.fitReason || "Found by discovery. Not scored yet.",
        relevancyReason: candidate.fitReason,
        personalizationNote: candidate.personalizationNote || candidate.discoveredInfo,
        scoreReason: {
          reason: `Not scored yet: ${why}. The AI will score it when it is available.`,
          scoring: "F-N-R-T",
          provider: llmMeta.provider || "none",
          mode: llmMeta.mode || "unavailable",
          fallbackUsed: true,
          scoresFrom: "none",
          awaitingAi: true,
          evidence,
        },
      };
    }
    const score = calculateFNRTScore({
      fitScore: numbers[0],
      needScore: numbers[1],
      reachabilityScore: numbers[2],
      timingScore: numbers[3],
    });

    const fitReason = String(llmOutput.fitReason || llmOutput.reason || candidate.fitReason || "");

    return {
      ...leadFields,
      fitScore: score.fitScore,
      needScore: score.needScore,
      reachabilityScore: score.reachabilityScore,
      timingScore: score.timingScore,
      leadScore: score.totalScore,
      qualificationStatus: score.qualificationStatus,
      confidenceScore: candidate.confidenceScore || Math.min(0.92, 0.45 + score.totalScore / 40),
      fitReason,
      relevancyReason: fitReason,
      personalizationNote: candidate.personalizationNote || candidate.discoveredInfo || fitReason,
      scoreReason: {
        reason: fitReason,
        scoring: "F-N-R-T",
        provider: llmMeta.provider || "deterministic",
        mode: llmMeta.mode || "fallback",
        fallbackUsed: false,
        scoresFrom: "model",
        evidence,
      },
    };
  }

  /**
   * 2026-09-09 (session 55) - ask the model to look at a lead that already
   * exists.
   *
   * WHY: `qualifyLead` above is the only code in the product that asks the
   * model what it thinks of a company, and it could only ever be reached
   * during a discovery run, on a candidate that was not a lead yet. A live
   * workspace holding fifty-four discovered companies therefore had no action
   * anywhere that would make the model reconsider one of them: fifty still
   * carried the sentence discovery wrote when it found them. Worse, the button
   * labelled "Score" ran `scoreLead()` - arithmetic over which fields happen
   * to be non-empty - and OVERWROTE whatever the model had said with a
   * restatement of its own four numbers.
   *
   * The lead is reduced to a candidate (identity and audit keys stripped, see
   * leadToScoringCandidate), scored by the same function discovery uses, and
   * only score fields are handed back to the caller.
   */
  /**
   * 2026-09-25 — returns `aiScored: false` (and no fields) when the AI did not
   * score it. A re-score that fails must never replace the AI's earlier score
   * with "not scored"; the caller keeps the lead as it is and says why.
   */
  async rescoreLead(workspaceId: string, lead: Lead, icp?: ICP): Promise<{ fields: Partial<Lead>; aiScored: boolean; reason: string }> {
    const attached = lead.campaignId
      ? await this.repos.campaign.getById(workspaceId, lead.campaignId)
      : undefined;
    const qualified = await this.qualifyLead(
      workspaceId,
      leadToScoringCandidate(lead),
      campaignForScoring(attached, icp) || await this.standInCampaign(workspaceId, icp),
      icp,
    );
    const reason = String((qualified.scoreReason as { reason?: string } | undefined)?.reason || "");
    if (qualified.qualificationStatus === "not_scored") return { fields: {}, aiScored: false, reason };
    return { fields: scoreFieldsFrom(qualified), aiScored: true, reason };
  }

  /**
   * A lead imported from a CSV has no campaign, and that is exactly the case
   * where a second opinion is most useful. `qualifyLead` reads four fields off
   * the campaign, so a stand-in built from the business profile and the ICP
   * gives the model the same context a real campaign would - without inventing
   * a campaign record in the operator's workspace.
   */
  private async standInCampaign(workspaceId: string, icp?: ICP): Promise<Campaign> {
    const profile = await this.repos.businessProfile.getByWorkspace(workspaceId);
    const now = timestamp();
    return {
      id: "",
      workspaceId,
      businessProfileId: profile?.id || "",
      icpId: icp?.id || "",
      name: "Re-scoring an existing lead",
      goal: profile?.companyName
        ? `Judge how well this company fits ${profile.companyName} as a customer.`
        : "Judge how well this company fits this business as a customer.",
      targetRegion: icp?.geography?.length ? icp.geography : (profile?.targetGeographies || []),
      productFocus: profile?.products?.length ? profile.products : (profile?.productCategories || []),
      offer: "",
      selectedChannels: [],
      dailyOutreachLimit: 0,
      leadGoal: 0,
      status: "draft",
      approvalStatus: "needs_review",
      plan: {} as Campaign["plan"],
      createdAt: now,
      updatedAt: now,
    };
  }

  private serpApiKey() {
    const value = process.env.PLATFORM_SERPAPI_API_KEY || process.env.SERPAPI_API_KEY || "";
    return value.trim();
  }

  private hasSerpApiKey() {
    return Boolean(this.serpApiKey());
  }
}

/**
 * The lead fields a scoring candidate is allowed to carry.
 *
 * WHY AN ALLOWLIST (2026-09-09, session 55): `qualifyLead` spreads its
 * candidate into the object it returns, and a re-score writes that object back
 * to the lead. A denylist that missed `id`, `workspaceId` or `createdAt` would
 * let a scoring pass rename, re-own or re-date the record it was only asked to
 * have an opinion about. These are the facts the model needs to judge with,
 * and nothing else.
 */
export const RESCORE_DESCRIPTIVE_KEYS = [
  "companyName", "contactName", "contactRole", "websiteUrl", "source", "sourceUrl",
  "linkedinUrl", "instagramUrl", "facebookUrl", "email", "phone", "whatsappNumber",
  "country", "state", "city", "address", "buyerType", "industry", "companySizeBucket",
  "fitReason", "discoveredInfo", "relevancyReason", "personalizationNote",
] as const satisfies readonly (keyof Lead)[];

/**
 * The only keys a re-score may write back. `confidenceScore` is deliberately
 * not carried INTO the candidate - qualifyLead keeps a candidate's existing
 * confidence rather than recomputing it - but is written back, so a second
 * opinion can raise or lower it.
 */
export const RESCORE_WRITEBACK_KEYS = [
  "fitScore", "needScore", "reachabilityScore", "timingScore", "leadScore",
  "qualificationStatus", "confidenceScore", "fitReason", "relevancyReason", "scoreReason",
] as const satisfies readonly (keyof Lead)[];

/** Reduce a stored lead to something the scorer can be handed. */
export function leadToScoringCandidate(lead: Lead): ProspectingCandidate {
  const facts: Record<string, unknown> = {};
  for (const key of RESCORE_DESCRIPTIVE_KEYS) {
    const value = lead[key];
    // An empty string PRESENT as a key reads to the model as a fact ("this
    // company has no name") rather than as a gap. Leave it out entirely.
    if (value !== undefined && value !== null && String(value).trim() !== "") facts[key] = value;
  }
  const evidence = (lead.scoreReason?.evidence || {}) as Record<string, unknown>;
  const originalQuery = typeof evidence.searchQuery === "string" ? evidence.searchQuery.trim() : "";
  return {
    ...(facts as Partial<Lead>),
    // Provenance: if discovery recorded the query that found this company,
    // a re-score keeps it rather than replacing the trail with its own label.
    searchQuery: originalQuery || `Re-scoring an existing lead: ${lead.companyName || lead.id}`,
    searchMode: "existing_lead_rescore",
    sourceProvider: lead.source || "existing_lead",
  };
}

/** Keep only what a scoring pass is allowed to change on an existing lead. */
/**
 * The campaign a scoring pass may use as context, which is not always the one
 * the lead is attached to.
 *
 * WHY (2026-09-09, session 55). `qualifyLead` reads the goal, the target region
 * and the product focus off the campaign — that is how the model is told what
 * this business sells and to whom. A campaign built from an ICP the owner has
 * since retired still carries the OLD answers, and on the live demo it did:
 * asked to re-score a lead, the model reported
 *
 *   "The campaign targets US wholesale distribution companies for enterprise
 *    software..."
 *
 * for a workspace that sells zari and embroidery thread in Surat. Resolving the
 * ICP correctly was not enough, because the campaign contradicted it — the
 * model was handed two different descriptions of the same business and,
 * reasonably, used the more specific one.
 *
 * So a campaign is usable context only when it does not disagree with the ICP
 * being scored against. When it does, the caller falls back to a stand-in built
 * from the business profile and that ICP, which is the same thing a CSV import
 * with no campaign at all gets. A campaign with no ICP of its own contradicts
 * nothing and is kept.
 */
export function campaignForScoring(campaign: Campaign | undefined, icp?: ICP): Campaign | undefined {
  if (!campaign) return undefined;
  if (!icp || !campaign.icpId) return campaign;
  return campaign.icpId === icp.id ? campaign : undefined;
}

export function scoreFieldsFrom(qualified: Partial<Lead>): Partial<Lead> {
  const fields: Record<string, unknown> = {};
  for (const key of RESCORE_WRITEBACK_KEYS) {
    const value = qualified[key];
    if (value !== undefined) fields[key] = value;
  }
  return fields as Partial<Lead>;
}

export async function scrapeWebsiteContacts(websiteUrl: string): Promise<WebsiteContactInfo> {
  if (!/^https?:\/\//i.test(websiteUrl)) return { ...emptyContactInfo(), error: "Only HTTP and HTTPS websites are fetched." };
  try {
    // 2026-09-27 (break test L3): this fetched any address it was handed —
    // a lead's "website" of http://169.254.169.254/ or http://10.0.0.5/admin
    // was read and its contents stored on the lead. Every hop, redirects
    // included, is now checked by the SSRF guard before it is requested.
    const { response, url: finalUrl } = await safeFetch(websiteUrl, {
      headers: {
        "user-agent": "LeadCockpitProspecting/0.1 (+https://leadcockpit.local)",
        accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      },
    }, { timeoutMs: 8000 });
    websiteUrl = finalUrl;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const $ = cheerio.load(html);
    const title = ($("title").first().text() || "").trim().slice(0, 160);
    const description = ($('meta[name="description"]').attr("content") || $('meta[property="og:description"]').attr("content") || "").trim().slice(0, 360);
    const text = $("body").text();
    const hrefs = $("a").map((_, item) => String($(item).attr("href") || "")).get();
    const emails = unique((html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
      .filter((email) => !/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(email)));
    const phones = unique((text.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [])
      .map((phone) => phone.replace(/\s+/g, " ").trim())
      .filter((phone) => phone.replace(/\D/g, "").length >= 8));
    const socialUrls = unique(hrefs
      .filter((href) => /linkedin\.com|instagram\.com|facebook\.com/i.test(href))
      .map((href) => safeAbsoluteUrl(href, websiteUrl) || href));
    return {
      title,
      description,
      emails: emails.slice(0, 3),
      phones: phones.slice(0, 3),
      socialUrls: socialUrls.slice(0, 5),
      linkedinUrl: socialUrls.find((url) => /linkedin\.com/i.test(url)),
      instagramUrl: socialUrls.find((url) => /instagram\.com/i.test(url)),
      facebookUrl: socialUrls.find((url) => /facebook\.com/i.test(url)),
      fetched: true,
    };
  } catch (error) {
    return { ...emptyContactInfo(), error: error instanceof Error ? error.message : "Website fetch failed." };
  }
}

function emptyContactInfo(): WebsiteContactInfo {
  return { emails: [], phones: [], socialUrls: [], fetched: false };
}

async function fetchWithTimeout(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "LeadCockpitProspecting/0.1 (+https://leadcockpit.local)",
        accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function serpApiResultToCandidate(query: string, item: Record<string, unknown>): ProspectingCandidate {
  const address = String(item.address || "");
  const location = parseAddress(address);
  return {
    companyName: String(item.title || "Discovered business"),
    websiteUrl: typeof item.website === "string" ? item.website : undefined,
    phone: typeof item.phone === "string" ? item.phone : undefined,
    whatsappNumber: typeof item.phone === "string" ? item.phone : undefined,
    address,
    city: location.city,
    country: location.country,
    buyerType: typeof item.type === "string" ? item.type : "Company-level prospect",
    industry: Array.isArray(item.types) ? item.types.map(String).slice(0, 2).join(", ") : typeof item.type === "string" ? item.type : undefined,
    source: "serpapi_google_maps",
    sourceUrl: typeof item.place_id_search === "string" ? item.place_id_search : typeof item.website === "string" ? item.website : undefined,
    fitReason: `Found from Google Maps query "${query}". Review before outreach.`,
    discoveredInfo: [item.description, item.type, item.rating ? `Rating: ${item.rating}` : undefined, address].filter(Boolean).join(" | "),
    confidenceScore: 0.72,
    searchQuery: query,
    searchMode: "live_google_maps",
    sourceProvider: "serpapi",
  };
}

function demoCandidates(query: string, limit: number, campaign?: Campaign, icp?: ICP): ProspectingCandidate[] {
  const cleaned = query.replace(/\b(near|in)\b.*$/i, "").trim() || icp?.buyerType || "B2B buyer";
  const region = campaign?.targetRegion?.[0] || icp?.geography?.[0] || "target region";
  const buyer = icp?.buyerType || "B2B buyer";
  const industry = icp?.industries?.[0] || campaign?.productFocus?.[0] || "business";
  const suffixes = ["Collective", "Studio", "Supply Co", "Trade House", "Works", "Partners", "Market Link", "Distribution"];
  return Array.from({ length: limit }).map((_, index) => {
    const base = titleCase(cleaned.split(/\s+/).slice(0, 4).join(" "));
    const companyName = `${base} ${suffixes[index % suffixes.length]}`;
    const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const phone = `+1 555 01${String(index + 10).padStart(2, "0")}`;
    return {
      companyName,
      websiteUrl: `https://${slug}.example.com`,
      email: `sales@${slug}.example.com`,
      phone,
      whatsappNumber: phone,
      city: region,
      country: region,
      buyerType: buyer,
      industry,
      source: "llm_assisted_demo",
      sourceUrl: `https://www.google.com/maps/search/${encodeURIComponent(query)}`,
      fitReason: `${companyName} is a demo prospect shaped from "${query}" for the ${campaign?.name || "selected campaign"} target. Review before outreach.`,
      discoveredInfo: `Demo prospect for ${buyer}. Likely need: ${(icp?.likelyNeeds || campaign?.productFocus || ["supplier discovery"])[0]}.`,
      personalizationNote: `Likely relevant to ${campaign?.productFocus?.[0] || industry} based on the discovery query "${query}".`,
      confidenceScore: 0.58,
      searchQuery: query,
      searchMode: "llm_assisted_demo",
      sourceProvider: "mock",
    };
  });
}

function mergeCandidateContactInfo(candidate: ProspectingCandidate, info: WebsiteContactInfo): ProspectingCandidate {
  const description = info.description || info.title || candidate.rawContext || "";
  return {
    ...candidate,
    email: candidate.email || info.emails[0],
    phone: candidate.phone || info.phones[0],
    whatsappNumber: candidate.whatsappNumber || info.phones[0],
    linkedinUrl: candidate.linkedinUrl || info.linkedinUrl,
    instagramUrl: candidate.instagramUrl || info.instagramUrl,
    facebookUrl: candidate.facebookUrl || info.facebookUrl,
    discoveredInfo: [candidate.discoveredInfo, description, info.socialUrls.length ? `Social profiles: ${info.socialUrls.join(", ")}` : undefined].filter(Boolean).join("\n"),
  };
}


/**
 * 2026-09-27 (break test L2): this matched on the company name ALONE, so a
 * different "Balaji Textiles" (another city, its own website and phone) was
 * taken for the lead already held and its email written into it, and a name
 * written in Hindi had an empty key and never matched at all. The one shared
 * rule in src/lib/same-company.ts decides now.
 */
function findExistingLead(existing: Lead[], candidate: Partial<Lead>) {
  return existing.find((lead) => isSameCompany(lead, candidate));
}

/** Moved to src/lib/same-company.ts (2026-09-27); re-exported for existing importers. */
export { websiteKey };

/** Lead fields re-discovery may FILL when the lead has none. */
const REDISCOVERY_FILL_KEYS = [
  "companyName", "websiteUrl", "sourceUrl", "linkedinUrl", "instagramUrl", "facebookUrl", "email", "phone",
  "whatsappNumber", "country", "state", "city", "address", "buyerType", "industry", "discoveredInfo", "personalizationNote",
] as const satisfies readonly (keyof Lead)[];

/**
 * What finding an existing lead again may change: empty contact / company
 * fields are filled, and a real AI score replaces a lead that has none yet.
 * Nothing else — see the 2026-09-26 note in prospectForWorkspace.
 */
export function rediscoveryPatch(existing: Lead, found: Partial<Lead>): Partial<Lead> {
  const patch: Record<string, unknown> = {};
  for (const key of REDISCOVERY_FILL_KEYS) {
    const current = existing[key];
    const next = found[key];
    if ((current === undefined || current === null || String(current).trim() === "") && next !== undefined && next !== null && String(next).trim() !== "") {
      patch[key] = next;
    }
  }
  if (found.qualificationStatus && found.qualificationStatus !== "not_scored" && !isAiScored(existing)) {
    Object.assign(patch, scoreFieldsFrom(found));
  }
  return patch as Partial<Lead>;
}

function parseQueryOutput(output: Record<string, unknown>) {
  const raw = output.queries || output.searchQueries || output.googleMapsQueries;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") return raw.split(/\n|,/).map((item) => item.trim());
  return [];
}

function deterministicQueries(campaign: Campaign, icp?: ICP, region?: string) {
  const geo = region || campaign.targetRegion?.[0] || icp?.geography?.[0] || "near me";
  const buyer = icp?.buyerType || icp?.name || "B2B buyer";
  const product = campaign.productFocus?.[0] || campaign.offer || "supplier";
  return [
    `${buyer} ${geo}`,
    `${buyer} ${product} ${geo}`,
    `${icp?.industries?.[0] || product} companies ${geo}`,
    `${buyer} wholesale ${geo}`,
    `${buyer} contact email ${geo}`,
  ];
}

function parseAddress(address: string) {
  const parts = address.split(",").map((item) => item.trim()).filter(Boolean);
  return {
    city: parts.length >= 2 ? parts[parts.length - 3] || parts[0] : undefined,
    country: parts.length >= 1 ? parts[parts.length - 1] : undefined,
  };
}

function unique(values: Array<string | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function safeAbsoluteUrl(href: string, base: string) {
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

function titleCase(value: string) {
  return value.replace(/\w\S*/g, (item) => item.charAt(0).toUpperCase() + item.slice(1).toLowerCase());
}

/**
 * The ICP a lead should be SCORED against, which is not always the one it
 * carries.
 *
 * WHY (2026-09-09, session 55). Two ways a lead ends up pointing at nothing
 * usable, both found on the live demo:
 *
 *   - No ICP at all. Every CSV import and every manually added lead. Scoring
 *     against no ICP asks "does this fit us" with no answer to "who is us".
 *
 *   - An ARCHIVED ICP. The demo had a lead still attached to an ideal customer
 *     the owner had since archived, along with the campaign built from it, and
 *     the model was duly told the target market was one the business had
 *     abandoned months earlier. It scored the lead against that, correctly and
 *     uselessly. An archived ICP is the owner saying "this is not who we sell
 *     to any more"; continuing to judge leads by it is the one reading of the
 *     record that cannot be what they meant.
 *
 * Both fall back to the ICP the workspace has SELECTED, which is the operator's
 * current answer to that question. If nothing is selected the caller gets
 * undefined and scores without an ICP, as before — a workspace mid-setup should
 * not have its scoring blocked.
 */
export async function scoringIcpFor(repos: RepositoryBundle, workspaceId: string, lead: Lead) {
  const attached = lead.icpId ? await repos.icp.getById(workspaceId, lead.icpId) : undefined;
  if (attached && attached.status !== "archived") return attached;
  return (await repos.icp.listByWorkspace(workspaceId)).find((row) => row.status === "selected") || attached;
}

/**
 * 2026-09-25 (CEO decision: lead scoring is AI only). Score, with the AI, the
 * leads it has not scored yet — never scored, scored by the old rules, or
 * waiting because the AI was down. Used by "Score with AI" on the Leads screen
 * and by the daily scheduler, so both follow the same rules:
 *   - leads the AI already scored are never re-read (the drawer's "Ask the AI
 *     to score this again" is for that);
 *   - rejected and do-not-contact leads are skipped — scoring them costs money
 *     and changes nothing;
 *   - the first failure stops the pass: if the AI is down, calling it forty
 *     more times only repeats the failure. Nothing is overwritten on failure.
 */
export async function scoreLeadsAwaitingAi(
  repos: RepositoryBundle,
  workspaceId: string,
  options: { campaignId?: string; limit: number },
): Promise<{ aiScored: number; stillWaiting: number; limit: number; stoppedReason?: string }> {
  const leads = await repos.lead.listLeads(workspaceId, options.campaignId ? { campaignId: options.campaignId } : {});
  const waiting = leads.filter((lead) => !isAiScored(lead)
    && !lead.doNotContact
    && lead.reviewStatus !== "rejected"
    && !["do_not_contact", "invalid", "duplicate"].includes(lead.status));
  const prospecting = new ProspectingService(repos);
  let aiScored = 0;
  let stoppedReason: string | undefined;
  for (const lead of waiting.slice(0, options.limit)) {
    const icp = await scoringIcpFor(repos, workspaceId, lead);
    const result = await prospecting.rescoreLead(workspaceId, lead, icp);
    if (!result.aiScored) {
      stoppedReason = result.reason;
      break;
    }
    await repos.lead.updateLeadScore(workspaceId, lead.id, result.fields);
    aiScored += 1;
  }
  return { aiScored, stillWaiting: waiting.length - aiScored, limit: options.limit, stoppedReason };
}
