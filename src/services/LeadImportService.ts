/**
 * LeadImportService — bringing an owner's own list of leads in from a CSV
 * (moved out of the route 2026-09-24 so it can be tested by running it).
 *
 * The rules, each one met on a first real file rather than on a sample:
 *   - a row naming no company and no website is not a lead (skipped, counted);
 *   - re-importing a corrected file does not double the list (skipped, counted);
 *   - a phone number also reaches `whatsappNumber`, because inbound WhatsApp is
 *     matched on that field;
 *   - a contact on the permanent do-not-contact register is NOT recreated
 *     (skipped, counted). Discovery already refused to recreate them; the CSV
 *     path did not, so an old list re-uploaded after an erasure brought people
 *     who had opted out back as fresh prospects. Sending was still blocked
 *     downstream, but they were scored, researched and shown as leads.
 *
 * Size limits are checked before any row is written, and the whole file is
 * refused rather than half-imported.
 */
import Papa from "papaparse";
import type { Lead } from "@/lib/types";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { ManualLeadSourceProvider } from "@/lib/adapters";
import { isPermanentlyDoNotContact, normalizeEmail, registerLeadOnDoNotContact } from "@/lib/dnc-registry";
import { NeedsActionError } from "@/lib/user-errors";
import { CompanyMatcher } from "@/lib/same-company";

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 5000;

export type CsvImportResult = {
  created: number;
  duplicatesSkipped: number;
  emptyRowsSkipped: number;
  doNotContactSkipped: number;
  rowsRead: number;
  parseErrors: string[];
  leads: Lead[];
};

export type CsvImportRefusal = { refused: true; status: 413; code: "CSV_TOO_LARGE" | "CSV_TOO_MANY_ROWS"; message: string };

export function leadInputFromProspect(workspaceId: string, input: Partial<Lead>, campaignId?: string, icpId?: string): Partial<Lead> {
  return {
    workspaceId,
    campaignId,
    icpId,
    companyName: input.companyName,
    contactName: input.contactName,
    contactRole: input.contactRole,
    websiteUrl: input.websiteUrl,
    source: input.source || "manual",
    sourceUrl: input.sourceUrl,
    linkedinUrl: input.linkedinUrl,
    instagramUrl: input.instagramUrl,
    facebookUrl: input.facebookUrl,
    email: input.email,
    phone: input.phone,
    whatsappNumber: input.whatsappNumber,
    country: input.country,
    state: input.state,
    city: input.city,
    address: input.address,
    buyerType: input.buyerType,
    industry: input.industry,
    companySizeBucket: input.companySizeBucket || "unknown",
    fitReason: input.fitReason || "Candidate prospect; review before enrichment.",
    personalizationNote: input.personalizationNote,
    leadScore: 0,
    fitScore: 0,
    needScore: 0,
    reachabilityScore: 0,
    timingScore: 0,
    confidenceScore: input.confidenceScore || 0.55,
    qualificationStatus: "unqualified",
    scoreReason: {},
    status: "needs_review",
    enrichmentStatus: "not_started",
    reviewStatus: "pending",
    doNotContact: false,
    consentStatus: "none",
    assignedTo: "user_owner",
  };
}

const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "") || undefined;

/** "Company Name" / "companyName" / "company-name" → "company_name", plus common other names for a column. */
const HEADER_ALIASES: Record<string, string> = {
  company_name: "company_name", company: "company", business_name: "company_name", firm: "company_name",
  // 2026-09-27 (break test L5): how Indian lists (Tally, Busy, Excel) head these columns.
  // Dots, slashes, spaces and hyphens all separate words: "Mobile No." → mobile_no, "City/Town" → city_town.
  firm_name: "company_name", party_name: "company_name", party: "company_name", shop_name: "company_name",
  e_mail: "email", email_address: "email", mail: "email", email_id: "email", e_mail_id: "email", mail_id: "email",
  phone_number: "phone", mobile: "phone", mobile_number: "phone", contact_number: "phone",
  mobile_no: "phone", phone_no: "phone", contact_no: "phone", mob: "phone", mob_no: "phone", cell: "phone", cell_no: "phone",
  whats_app: "whatsapp", whats_app_number: "whatsapp_number", whatsapp_no: "whatsapp_number", whats_app_no: "whatsapp_number",
  website_url: "website_url", url: "website", web_site: "website",
  contact_person: "contact_name", person: "contact_name",
  town: "city", city_town: "city", city_or_town: "city",
  // Recognised so the column is not mistaken for anything else; a lead has no GST field, so it is ignored.
  gst_no: "gst_number", gstin: "gst_number", gst: "gst_number",
};
export function csvHeaderKey(header: string): string {
  const key = header.replace(/^\uFEFF/, "").trim().replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/[\s\-./]+/g, "_").replace(/^_+|_+$/g, "");
  return HEADER_ALIASES[key] || key;
}

export async function importLeadsFromCsv(
  workspaceId: string,
  csvText: string,
  options: { campaignId?: string; icpId?: string },
  repos: RepositoryBundle,
): Promise<CsvImportResult | CsvImportRefusal> {
  if (Buffer.byteLength(csvText, "utf8") > MAX_CSV_BYTES) {
    return { refused: true, status: 413, code: "CSV_TOO_LARGE", message: `That file is over ${Math.round(MAX_CSV_BYTES / 1024 / 1024)} MB. Split it into smaller files of up to ${MAX_CSV_ROWS.toLocaleString("en-IN")} rows each.` };
  }
  // 2026-09-26 (break test): a file headed "Company Name, Email" — how people
  // type it — imported nothing and called every row empty, because only the
  // exact spellings company_name / companyName were read. Headers are now
  // matched ignoring case, spaces, hyphens and camelCase, plus a few common
  // names for the same column.
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true, transformHeader: csvHeaderKey });
  if (parsed.data.length > MAX_CSV_ROWS) {
    return { refused: true, status: 413, code: "CSV_TOO_MANY_ROWS", message: `That file has ${parsed.data.length.toLocaleString("en-IN")} rows; up to ${MAX_CSV_ROWS.toLocaleString("en-IN")} can be imported at once. Split it into smaller files.` };
  }

  await assertCampaignInWorkspace(workspaceId, options.campaignId, repos);
  const provider = new ManualLeadSourceProvider();
  // 2026-09-27 (break test L4): duplicates are found by the one shared
  // same-company rule (website host, phone, email, or name in any script),
  // against the leads already held AND the rows already taken from this file.
  const seen = new CompanyMatcher<Partial<Lead>>(await repos.lead.listLeads(workspaceId));

  const leads: Lead[] = [];
  let emptyRowsSkipped = 0;
  let duplicatesSkipped = 0;
  let doNotContactSkipped = 0;
  for (const row of parsed.data) {
    const companyName = clean(row.company_name) || clean(row.company) || clean(row.companyName) || "";
    const websiteUrl = clean(row.website) || clean(row.website_url) || clean(row.websiteUrl) || "";
    if (!companyName && !websiteUrl) {
      emptyRowsSkipped += 1;
      continue;
    }
    const email = clean(row.email);
    const phone = clean(row.phone);
    // An explicit whatsapp column wins; otherwise the phone number is the
    // WhatsApp number, because inbound is matched on whatsappNumber.
    const whatsappNumber = clean(row.whatsapp) || clean(row.whatsapp_number) || phone;
    const city = clean(row.city);
    const identity = { companyName, websiteUrl, email, phone, whatsappNumber, city };
    if (seen.find(identity)) {
      duplicatesSkipped += 1;
      continue;
    }
    const optedOut =
      await isPermanentlyDoNotContact(workspaceId, { phone: whatsappNumber, email }, repos)
      || (phone !== whatsappNumber && await isPermanentlyDoNotContact(workspaceId, { phone }, repos))
      // 2026-09-28 (L10): a company on the register by its website alone.
      || Boolean(websiteUrl && await isPermanentlyDoNotContact(workspaceId, { website: websiteUrl }, repos));
    if (optedOut) {
      doNotContactSkipped += 1;
      continue;
    }
    seen.add(identity);
    leads.push(await repos.lead.createLead(leadInputFromProspect(workspaceId, provider.normalizeProspect({
      companyName,
      websiteUrl,
      email,
      phone,
      whatsappNumber,
      contactName: clean(row.contact_name) || clean(row.contact) || clean(row.contactName),
      city,
      country: clean(row.country),
      sourceUrl: clean(row.source_url),
      fitReason: clean(row.fit_reason),
    }), options.campaignId, options.icpId)));
  }

  return {
    created: leads.length,
    duplicatesSkipped,
    emptyRowsSkipped,
    doNotContactSkipped,
    rowsRead: parsed.data.length,
    // Papa reports malformed rows; an owner who uploads a file with a broken
    // quote should be told, not left wondering where the rows went.
    parseErrors: (parsed.errors || []).slice(0, 5).map((error) => `Row ${typeof error.row === "number" ? error.row + 1 : "?"}: ${error.message}`),
    leads,
  };
}

/**
 * 2026-09-27 (break test L9): a campaignId from ANOTHER company was stored on
 * the lead as given — by manual add, CSV import and lead edit. A campaign the
 * workspace does not own is refused with a plain 400.
 */
export async function assertCampaignInWorkspace(workspaceId: string, campaignId: string | undefined | null, repos: RepositoryBundle): Promise<void> {
  if (!campaignId || !String(campaignId).trim()) return;
  const campaign = await repos.campaign.getById(workspaceId, String(campaignId));
  if (!campaign || campaign.workspaceId !== workspaceId) {
    throw new NeedsActionError("That campaign was not found in this company. Pick one of your own campaigns, or leave it empty.", 400);
  }
}

/**
 * Add one lead by hand.
 *
 * 2026-09-26 (break test): the form created whatever it was given. A number on
 * the do-not-contact register came back as a fresh, contactable lead (the CSV
 * import and discovery both refuse this), and a customer already in the list
 * typed as "+91-98250-22222" instead of "+91 98250 22222", or with a capital in
 * the email, became a second lead with its own history and drafts.
 */
export async function createManualLead(workspaceId: string, body: Record<string, unknown>, repos: RepositoryBundle): Promise<Lead> {
  const provider = new ManualLeadSourceProvider();
  const input = leadInputFromProspect(workspaceId, provider.normalizeProspect(body), clean(body.campaignId), clean(body.icpId));
  await assertCampaignInWorkspace(workspaceId, input.campaignId, repos);
  const phones = [input.phone, input.whatsappNumber].filter((value): value is string => Boolean(value && value.trim()));
  const email = normalizeEmail(input.email);
  for (const phone of phones.length ? phones : [undefined]) {
    if (await isPermanentlyDoNotContact(workspaceId, { phone, email: email || undefined }, repos)) {
      throw new NeedsActionError("This contact asked not to be contacted, so they cannot be added as a new lead.", 409);
    }
  }
  // 2026-09-28 (L10): a company on the register by its website alone.
  if (input.websiteUrl && await isPermanentlyDoNotContact(workspaceId, { website: input.websiteUrl }, repos)) {
    throw new NeedsActionError("This company is on your do-not-contact list, so it cannot be added as a new lead.", 409);
  }
  // 2026-09-27 (break test L6): the shared same-company rule — which also
  // catches the same company name typed again, in any script.
  const existing = new CompanyMatcher(await repos.lead.listLeads(workspaceId)).find(input);
  if (existing) {
    const name = existing.companyName || existing.contactName || "another lead";
    throw new NeedsActionError(`You already have this lead: ${name}. Open it there instead of adding it again.`, 409);
  }
  return repos.lead.createLead(input);
}

/**
 * Edit a lead's details (the generic lead PUT).
 *
 * 2026-09-27 (break test L8 / L9):
 *   - changing a lead's phone, WhatsApp number or email to one on the
 *     do-not-contact register left the lead contactable — the register was
 *     only consulted when a lead was CREATED. The lead is now marked
 *     do-not-contact, and that is written to the audit log;
 *   - a campaignId belonging to another company was stored as given; it is
 *     refused with a plain 400.
 */
export async function updateLeadDetails(
  workspaceId: string,
  leadId: string,
  patch: Partial<Lead>,
  repos: RepositoryBundle,
  actorUserId = "system",
): Promise<Lead> {
  await assertCampaignInWorkspace(workspaceId, patch.campaignId, repos);
  const before = await repos.lead.getLeadById(workspaceId, leadId);
  const updated = await repos.lead.updateLead(workspaceId, leadId, patch);
  // 2026-09-28 — won / lost / opted out are real results the system learns from.
  const { recordLeadChangeOutcome } = await import("@/services/OutcomeSignalService");
  await recordLeadChangeOutcome(workspaceId, before, updated, repos);
  const contactFields = (["phone", "whatsappNumber", "email", "websiteUrl"] as const).filter((key) => key in patch);
  if (!contactFields.length || updated.doNotContact) return updated;
  const values: Array<{ phone?: string; email?: string; website?: string }> = [
    { phone: updated.phone },
    { phone: updated.whatsappNumber },
    { email: updated.email },
    // 2026-09-28 (L10): the website host is a register key too.
    { website: updated.websiteUrl },
  ].filter((value) => Object.values(value).some((item) => item && String(item).trim()));
  for (const value of values) {
    if (!(await isPermanentlyDoNotContact(workspaceId, value, repos))) continue;
    const marked = await repos.lead.updateLead(workspaceId, leadId, { doNotContact: true, status: "do_not_contact" });
    try {
      await repos.auditLog.create({
        workspaceId,
        eventType: "lead.do_not_contact_matched",
        actorUserId,
        entityType: "lead",
        entityId: leadId,
        payload: {
          reason: "The lead was edited to a phone number, email or website on the do-not-contact register.",
          previousStatus: updated.status,
          changedFields: contactFields,
        },
      });
    } catch (error) {
      // The lead is already blocked; a failed audit write must not undo that.
      console.error(`[LeadImportService] audit write failed for do-not-contact match on lead ${leadId}: ${error instanceof Error ? error.message : error}`);
    }
    return marked;
  }
  return updated;
}

/**
 * 2026-09-28 (L10) — the owner puts a lead on the permanent do-not-contact
 * register (POST /api/consent/:leadId/add-dnc; the way off it is remove-dnc).
 *
 * Every number, the email and the website host go on the register, so a
 * company known only by its website can be registered (before, the register
 * needed a phone or an email). The lead is marked do-not-contact and the
 * action is written to the audit log with the owner's reason.
 */
export async function putLeadOnDoNotContact(
  workspaceId: string,
  leadId: string,
  reason: string,
  repos: RepositoryBundle,
  actorUserId = "system",
): Promise<{ lead: Lead; registered: number }> {
  const text = String(reason || "").trim();
  if (text.length < 3) throw new NeedsActionError("Write a short reason, for example \"asked us to stop\".", 400);
  const lead = await repos.lead.getLeadById(workspaceId, leadId);
  if (!lead) throw new NeedsActionError("That lead was not found.", 404);
  const registered = await registerLeadOnDoNotContact(workspaceId, lead, text, repos);
  const marked = await repos.lead.updateLead(workspaceId, leadId, { doNotContact: true, status: "do_not_contact" });
  try {
    await repos.auditLog.create({
      workspaceId,
      eventType: "dnc_added",
      actorUserId,
      entityType: "lead",
      entityId: leadId,
      payload: { reason: text, registryEntries: registered, previousStatus: lead.status },
    });
  } catch (error) {
    console.error(`[LeadImportService] audit write failed for dnc_added on lead ${leadId}: ${error instanceof Error ? error.message : error}`);
  }
  return { lead: marked, registered };
}
