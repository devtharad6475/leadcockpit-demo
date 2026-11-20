import type { Lead } from "@/lib/types";
import { timestamp } from "@/lib/db";
import { canEnrichLead, shouldProtectQualifiedStatus } from "@/lib/lead-rules";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { AuditLogService } from "@/services/AuditLogService";
import { scrapeWebsiteContacts } from "@/services/ProspectingService";
import { emitEvent } from "@/events/EventDispatcher";
import { isContactBlocked } from "@/lib/dnc-registry";

export type LeadEnrichmentCandidate = {
  companyName?: string;
  websiteUrl?: string;
  sourceUrl?: string;
  source?: string;
  title?: string;
  description?: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
  industry?: string;
  buyerType?: string;
  email?: string;
  phone?: string;
  whatsappNumber?: string;
  linkedinUrl?: string;
  instagramUrl?: string;
  facebookUrl?: string;
};

export type LeadEnrichmentSummary = {
  lead: Lead;
  status: NonNullable<Lead["enrichmentResult"]>["status"];
  fieldsAdded: string[];
  matchedSource?: string;
  validationNote: string;
};

export async function enrichLead(
  workspaceId: string,
  leadId: string,
  options: { candidates?: LeadEnrichmentCandidate[] } = {},
  repos: RepositoryBundle = createRepositories(),
  actorUserId: string = "system",
): Promise<LeadEnrichmentSummary> {
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  if (!lead) throw new Error("Lead not found");
  if (!canEnrichLead(lead)) throw new Error("Only approved, contact-safe leads can be enriched.");
  const contact = await isContactBlocked(workspaceId, lead, repos);
  if (contact.blocked) throw new Error(contact.reason);

  const run = await repos.agentRun.create({
    workspaceId,
    agentName: "Lead Enrichment Agent",
    input: { leadId: lead.id, query: buildSearchQuery(lead) },
    status: "running",
    startedAt: timestamp(),
  });

  try {
    await repos.lead.updateLead(workspaceId, lead.id, { enrichmentStatus: "running" });
    // CP-18c (2026-08-02) — per-workspace SerpApi key overrides env.
    let workspaceSerpApiKey: string | undefined;
    try {
      const { IntegrationCredentialService } = await import("@/services/IntegrationCredentialService");
      workspaceSerpApiKey = await new IntegrationCredentialService(repos).resolveKey(workspaceId, "serpapi");
    } catch {
      workspaceSerpApiKey = undefined; // env fallback
    }
    const candidates = options.candidates || await findCandidates(lead, workspaceSerpApiKey);
    const decision = decideBestCandidate(lead, candidates);
    const now = timestamp();

    if (decision.status === "matched" && decision.candidate) {
      const fieldsAdded: string[] = [];
      const patch: Partial<Lead> = {
        enrichmentStatus: "completed",
        enrichmentResult: {
          status: "matched",
          matchedSource: candidateSource(decision.candidate),
          validationNote: decision.validationNote,
          enrichedAt: now,
        },
        status: !shouldProtectQualifiedStatus(lead.status) && ["approved", "enriching", "needs_review", "discovered"].includes(lead.status) ? "enriched" : lead.status,
        personalizationNote: lead.personalizationNote || "This business appears relevant to the selected campaign. Verify the fit before outreach.",
        sourceUrl: lead.sourceUrl || candidateSource(decision.candidate),
      };

      copyIfMissing(patch, lead, decision.candidate, "email", fieldsAdded);
      copyIfMissing(patch, lead, decision.candidate, "phone", fieldsAdded);
      copyIfMissing(patch, lead, decision.candidate, "whatsappNumber", fieldsAdded);
      copyIfMissing(patch, lead, decision.candidate, "linkedinUrl", fieldsAdded);
      copyIfMissing(patch, lead, decision.candidate, "instagramUrl", fieldsAdded);
      copyIfMissing(patch, lead, decision.candidate, "facebookUrl", fieldsAdded);
      patch.discoveredInfo = appendLine(lead.discoveredInfo, `Enriched from: ${candidateSource(decision.candidate) || "validated public source"}`);

      const updated = await repos.lead.updateLead(workspaceId, lead.id, patch);
      await repos.agentRun.update(workspaceId, run.id, {
        status: "completed",
        output: { leadId: lead.id, status: "matched", fieldsAdded, matchedSource: patch.enrichmentResult?.matchedSource },
        completedAt: now,
      });
      await new AuditLogService(repos).logAuditEvent({
        workspaceId,
      userId: actorUserId,
        action: "lead.enriched",
        entityType: "lead",
        entityId: lead.id,
        newValuesJson: { status: "matched", fieldsAdded, matchedSource: patch.enrichmentResult?.matchedSource },
      });
      await emitEvent({ eventType: "lead.enriched", workspaceId, entityType: "lead", entityId: lead.id, source: "backend", payload: { status: "matched", fieldsAdded } });
      return { lead: updated, status: "matched", fieldsAdded, matchedSource: patch.enrichmentResult?.matchedSource, validationNote: decision.validationNote };
    }

    const patch: Partial<Lead> = {
      enrichmentStatus: "completed",
      enrichmentResult: {
        status: decision.status,
        ambiguousCount: decision.status === "ambiguous" ? candidates.length : undefined,
        validationNote: decision.validationNote,
        enrichedAt: now,
      },
    };
    const updated = await repos.lead.updateLead(workspaceId, lead.id, patch);
    await repos.agentRun.update(workspaceId, run.id, {
      status: "completed",
      output: { leadId: lead.id, status: decision.status, validationNote: decision.validationNote },
      completedAt: now,
    });
    await new AuditLogService(repos).logAuditEvent({
      workspaceId,
      userId: actorUserId,
      action: "lead.enriched",
      entityType: "lead",
      entityId: lead.id,
      newValuesJson: { status: decision.status, validationNote: decision.validationNote },
    });
    await emitEvent({ eventType: "lead.enriched", workspaceId, entityType: "lead", entityId: lead.id, source: "backend", payload: { status: decision.status } });
    return { lead: updated, status: decision.status, fieldsAdded: [], validationNote: decision.validationNote };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Lead enrichment failed.";
    const updated = await repos.lead.updateLead(workspaceId, lead.id, {
      enrichmentStatus: "failed",
      enrichmentResult: { status: "failed", validationNote: message, enrichedAt: timestamp() },
    });
    await repos.agentRun.update(workspaceId, run.id, { status: "failed", errorMessage: message, completedAt: timestamp() });
    throw Object.assign(new Error(message), { lead: updated });
  }
}

export async function bulkEnrichApproved(workspaceId: string, repos: RepositoryBundle = createRepositories()) {
  const leads = (await repos.lead.listLeads(workspaceId)).filter((lead) =>
    lead.reviewStatus === "approved" &&
    lead.enrichmentStatus === "not_started" &&
    canEnrichLead(lead)
  ).slice(0, 20);
  const results: LeadEnrichmentSummary[] = [];
  const failed: Array<{ leadId: string; message: string }> = [];

  for (const lead of leads) {
    try {
      results.push(await enrichLead(workspaceId, lead.id, {}, repos));
    } catch (error) {
      failed.push({ leadId: lead.id, message: error instanceof Error ? error.message : "Failed" });
    }
  }

  return {
    enriched: results.filter((item) => item.status === "matched").length,
    ambiguous: results.filter((item) => item.status === "ambiguous").length,
    noResults: results.filter((item) => item.status === "no_results").length,
    failed: failed.length,
    processed: results.length + failed.length,
    results,
    failures: failed,
  };
}

async function findCandidates(lead: Lead, workspaceKey?: string): Promise<LeadEnrichmentCandidate[]> {
  if (lead.websiteUrl) {
    const contact = await scrapeWebsiteContacts(lead.websiteUrl);
    if (contact.fetched) {
      return [{
        companyName: lead.companyName,
        websiteUrl: lead.websiteUrl,
        sourceUrl: lead.websiteUrl,
        title: contact.title,
        description: contact.description,
        city: lead.city,
        state: lead.state,
        country: lead.country,
        industry: lead.industry,
        buyerType: lead.buyerType,
        email: contact.emails[0],
        phone: contact.phones[0],
        whatsappNumber: contact.phones[0],
        linkedinUrl: contact.linkedinUrl,
        instagramUrl: contact.instagramUrl,
        facebookUrl: contact.facebookUrl,
      }];
    }
  }

  const key = (workspaceKey || process.env.PLATFORM_SERPAPI_API_KEY || process.env.SERPAPI_API_KEY || "").trim();
  if (!key) return [];

  try {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_maps");
    url.searchParams.set("type", "search");
    url.searchParams.set("q", buildSearchQuery(lead));
    url.searchParams.set("api_key", key);
    const response = await fetch(url.toString(), { headers: { "user-agent": "LeadCockpitEnrichment/0.1" } });
    if (!response.ok) return [];
    const payload = await response.json() as { local_results?: Array<Record<string, unknown>> };
    return (payload.local_results || []).slice(0, 6).map((item) => ({
      companyName: String(item.title || ""),
      websiteUrl: typeof item.website === "string" ? item.website : undefined,
      sourceUrl: typeof item.place_id_search === "string" ? item.place_id_search : typeof item.website === "string" ? item.website : undefined,
      source: "serpapi_google_maps",
      address: typeof item.address === "string" ? item.address : undefined,
      phone: typeof item.phone === "string" ? item.phone : undefined,
      whatsappNumber: typeof item.phone === "string" ? item.phone : undefined,
      industry: typeof item.type === "string" ? item.type : undefined,
      description: typeof item.description === "string" ? item.description : undefined,
    }));
  } catch {
    return [];
  }
}

function decideBestCandidate(lead: Lead, candidates: LeadEnrichmentCandidate[]) {
  if (!candidates.length) {
    return {
      status: "no_results" as const,
      validationNote: "No reliable public match was found. Add contact details manually or try enrichment again after adding a website.",
    };
  }
  const scored = candidates.map((candidate) => ({ candidate, confidence: scoreCandidate(lead, candidate) }))
    .sort((a, b) => b.confidence - a.confidence);
  const top = scored[0];
  const closeMatches = scored.filter((item) => top.confidence - item.confidence < 20 && item.confidence >= 40);

  if (top.confidence >= 70 && closeMatches.length <= 1) {
    return {
      status: "matched" as const,
      candidate: top.candidate,
      validationNote: `Matched with ${top.confidence}/100 confidence using company, location, industry, website, or phone signals.`,
    };
  }

  if (candidates.length > 1) {
    return {
      status: "ambiguous" as const,
      validationNote: `Found ${candidates.length} possible companies for ${lead.companyName || "this lead"}. Contact details were not changed because the match was not confident enough.`,
    };
  }

  return {
    status: "no_results" as const,
    validationNote: "One possible result was found, but it did not pass the required confidence check. Contact details were not changed.",
  };
}

function scoreCandidate(lead: Lead, candidate: LeadEnrichmentCandidate) {
  let score = 0;
  const leadName = normalizeText(lead.companyName);
  const candidateName = normalizeText(candidate.companyName || candidate.title);
  if (leadName && candidateName && (candidateName.includes(leadName) || leadName.includes(candidateName))) score += 15;
  else if (leadName && candidateName) score -= 30;

  const leadLocation = normalizeText([lead.city, lead.state].filter(Boolean).join(" "));
  const candidateLocation = normalizeText([candidate.city, candidate.state, candidate.address].filter(Boolean).join(" "));
  if (leadLocation && candidateLocation) score += overlap(leadLocation, candidateLocation) ? 30 : -40;

  const leadIndustry = normalizeText([lead.industry, lead.buyerType].filter(Boolean).join(" "));
  const candidateIndustry = normalizeText([candidate.industry, candidate.buyerType, candidate.description].filter(Boolean).join(" "));
  if (leadIndustry && candidateIndustry) score += overlap(leadIndustry, candidateIndustry) ? 25 : -20;

  const leadDomain = domainKey(lead.websiteUrl);
  const candidateDomain = domainKey(candidate.websiteUrl || candidate.sourceUrl);
  if (leadDomain && candidateDomain) score += domainsOverlap(leadDomain, candidateDomain) ? 50 : -50;

  const leadPhone = phoneKey(lead.phone || lead.whatsappNumber);
  const candidatePhone = phoneKey(candidate.phone || candidate.whatsappNumber);
  if (leadPhone && candidatePhone && leadPhone === candidatePhone) score += 60;

  return Math.max(0, Math.min(100, score));
}

function copyIfMissing<K extends keyof Lead & keyof LeadEnrichmentCandidate>(
  patch: Partial<Lead>,
  lead: Lead,
  candidate: LeadEnrichmentCandidate,
  key: K,
  fieldsAdded: string[],
) {
  const value = candidate[key];
  if (!lead[key] && typeof value === "string" && value.trim()) {
    patch[key] = value as Lead[K];
    fieldsAdded.push(String(key));
  }
}

function buildSearchQuery(lead: Lead) {
  return [lead.companyName, lead.city || lead.state, lead.industry || lead.buyerType, "contact"].filter(Boolean).join(" ");
}

function candidateSource(candidate: LeadEnrichmentCandidate) {
  return candidate.sourceUrl || candidate.websiteUrl || candidate.source || "public search result";
}

function appendLine(existing: string | undefined, line: string) {
  return [existing, line].filter(Boolean).join("\n");
}

function normalizeText(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function overlap(a: string, b: string) {
  const bWords = new Set(b.split(/\s+/).filter((word) => word.length > 2));
  return a.split(/\s+/).filter((word) => word.length > 2).some((word) => bWords.has(word));
}

function domainKey(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`).hostname.replace(/^www\./, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  } catch {
    return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  }
}

function domainsOverlap(a: string, b: string) {
  return a === b || a.includes(b) || b.includes(a);
}

function phoneKey(value: unknown) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}
