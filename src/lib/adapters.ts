import type { Lead, MessageTemplate } from "./types";

export type ProspectSearchInput = {
  query: string;
  region?: string;
  limit?: number;
  campaignId?: string;
  icpId?: string;
};

export type LeadSourceProvider = {
  name: string;
  searchProspects(input: ProspectSearchInput): Promise<Partial<Lead>[]>;
  normalizeProspect(raw: Record<string, unknown>): Partial<Lead>;
};

export type EnrichmentProvider = {
  name: string;
  enrichLead(lead: Lead): Promise<Partial<Lead> & { confidence?: Record<string, unknown> }>;
  verifyEmail(email?: string): Promise<boolean>;
  findContacts(lead: Lead): Promise<Partial<Lead>>;
};

export type OutreachProvider = {
  name: string;
  sendMessage(channel: string, recipient: string, message: MessageTemplate): Promise<{ status: "manual" | "sent_api"; url?: string }>;
  getMessageStatus(messageId: string): Promise<string>;
  receiveWebhook(payload: Record<string, unknown>): Promise<void>;
};

export class ManualLeadSourceProvider implements LeadSourceProvider {
  name = "manual_entry";

  async searchProspects(): Promise<Partial<Lead>[]> {
    return [];
  }

  normalizeProspect(raw: Record<string, unknown>): Partial<Lead> {
    // F-UI-6 (depth-audit 2026-07-29): map ALL contact + identity fields the
    // caller can send, not just a subset. Previously email/phone/whatsappNumber
    // + the social URLs + contactName/industry were dropped here — so a
    // manually-added lead silently lost its contact details (the operator
    // typed an email and it vanished). leadInputFromProspect reads these from
    // the prospect this returns, so they must survive normalization.
    return {
      companyName: String(raw.companyName || raw.company || "Untitled prospect"),
      contactName: raw.contactName ? String(raw.contactName) : undefined,
      contactRole: raw.contactRole ? String(raw.contactRole) : undefined,
      websiteUrl: raw.websiteUrl ? String(raw.websiteUrl) : undefined,
      source: "manual",
      sourceUrl: raw.sourceUrl ? String(raw.sourceUrl) : undefined,
      email: raw.email ? String(raw.email) : undefined,
      phone: raw.phone ? String(raw.phone) : undefined,
      whatsappNumber: raw.whatsappNumber ? String(raw.whatsappNumber) : undefined,
      linkedinUrl: raw.linkedinUrl ? String(raw.linkedinUrl) : undefined,
      instagramUrl: raw.instagramUrl ? String(raw.instagramUrl) : undefined,
      facebookUrl: raw.facebookUrl ? String(raw.facebookUrl) : undefined,
      city: raw.city ? String(raw.city) : undefined,
      country: raw.country ? String(raw.country) : undefined,
      state: raw.state ? String(raw.state) : undefined,
      address: raw.address ? String(raw.address) : undefined,
      buyerType: raw.buyerType ? String(raw.buyerType) : undefined,
      industry: raw.industry ? String(raw.industry) : undefined,
      personalizationNote: raw.personalizationNote ? String(raw.personalizationNote) : undefined,
      fitReason: raw.fitReason ? String(raw.fitReason) : "Added manually for human review.",
      confidenceScore: Number(raw.confidenceScore || 0.6),
    };
  }
}

export class CSVLeadSourceProvider extends ManualLeadSourceProvider {
  name = "csv_upload";
}

export class GenericWebSearchAdapter implements LeadSourceProvider {
  name = "generic_web_search_placeholder";

  async searchProspects(input: ProspectSearchInput): Promise<Partial<Lead>[]> {
    const region = input.region ? ` in ${input.region}` : "";
    return Array.from({ length: Math.min(input.limit || 5, 8) }).map((_, index) => ({
      companyName: `${input.query.replace(/\b(in|near)\b.*/i, "").trim()} prospect ${index + 1}`,
      source: "web_search_placeholder",
      sourceUrl: `https://www.google.com/search?q=${encodeURIComponent(`${input.query}${region}`)}`,
      buyerType: "Company-level prospect",
      fitReason: `Generated from search query "${input.query}" for review before enrichment.`,
      confidenceScore: 0.52,
      status: "needs_review",
      reviewStatus: "pending",
    }));
  }

  normalizeProspect(raw: Record<string, unknown>): Partial<Lead> {
    return {
      companyName: String(raw.companyName || "Search prospect"),
      source: "web_search_placeholder",
      sourceUrl: raw.sourceUrl ? String(raw.sourceUrl) : undefined,
      fitReason: "Normalized from web search placeholder.",
      confidenceScore: 0.5,
    };
  }
}

export class ManualOutreachProvider implements OutreachProvider {
  name = "manual_outreach";

  async sendMessage(channel: string, recipient: string, message: MessageTemplate) {
    if (channel.toLowerCase() === "whatsapp" && recipient) {
      const phone = recipient.replace(/[^\d]/g, "");
      return { status: "manual" as const, url: `https://wa.me/${phone}?text=${encodeURIComponent(message.body)}` };
    }
    if (channel.toLowerCase() === "email" && recipient) {
      return { status: "manual" as const, url: `mailto:${recipient}?subject=${encodeURIComponent(message.subject || "")}&body=${encodeURIComponent(message.body)}` };
    }
    return { status: "manual" as const };
  }

  async getMessageStatus() {
    return "requires_user_confirmation";
  }

  async receiveWebhook() {
    return undefined;
  }
}
