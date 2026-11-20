/**
 * QuotePdfService — generate a real Quote PDF (GAP-7, 2026-07-31).
 *
 * Authority: docs/planning/CAPABILITY_GAP_AUDIT.md GAP-7. The audit found that
 * only Policy + Knowledge-Questionnaire PDFs existed — Quotes (a core CRM
 * object) had no PDF at all. This closes that gap by reusing the shared
 * pdf-writer chokepoint (`src/lib/pdf-writer.ts`).
 *
 * What it does: reads a Quote + its Lead + the workspace business profile,
 * assembles a markdown-ish line array (title, customer, line items, totals,
 * validity, notes, review note), builds a real PDF byte buffer, and saves it
 * as a `quote` media-catalog item linked to the lead.
 *
 * The PDF uses bundled fonts and measured multilingual layout. Unsupported
 * characters refuse generation rather than silently losing customer facts.
 * The grand total is the Quote's stored `grandTotal` snapshot (NOT a
 * recompute), so it always agrees with what the owner approved.
 */
import type { BusinessProfile, Lead, Quote } from "@/lib/types";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { saveMediaCatalogItem } from "@/services/MediaCatalogService";
import { buildPdfFromLines, safeFilePart, sanitizePdfText } from "@/lib/pdf-writer";
import { NeedsActionError } from "@/lib/user-errors";
import { formatUnitPriceNumber } from "@/lib/money";

export type QuotePdfInput = {
  workspaceId: string;
  quoteId: string;
  title?: string;
};

export async function generateQuotePdf(input: QuotePdfInput, repos: RepositoryBundle = createRepositories()) {
  const quote = await repos.quote.getById(input.workspaceId, input.quoteId);
  if (!quote) throw new NeedsActionError("Quote not found.", 404);
  const lead = await repos.lead.getLeadById(input.workspaceId, quote.leadId);
  if (!lead) throw new NeedsActionError("Link this quote to a customer before generating its PDF.", 400);
  const profile = await repos.businessProfile.getByWorkspace(input.workspaceId);
  const title = input.title?.trim() || `Quotation #${quote.quoteNumber}`;

  const lines = buildQuoteLines({ title, quote, lead, profile });
  const pdf = await buildPdfFromLines(lines);

  const customerName = lead.companyName || lead.contactName || "Customer";
  const fileName = `${safeFilePart(customerName, "customer")}-${safeFilePart(title, "quote")}.pdf`;
  return saveMediaCatalogItem(
    {
      workspaceId: input.workspaceId,
      fileName,
      fileType: "application/pdf",
      buffer: pdf,
      category: "other",
      title: `${title} - ${customerName}`,
      caption: `Quotation #${quote.quoteNumber} generated from the CRM. Total ${formatMoney(quote.grandTotal, quote.currencyCode)}. Owner review is recommended before sending.`,
      leadId: lead.id,
      folder: "policies",
    },
    repos,
  );
}

function buildQuoteLines(input: {
  title: string;
  quote: Quote;
  lead: Lead;
  profile?: BusinessProfile;
}): string[] {
  const { title, quote, lead, profile } = input;
  const businessName = profile?.companyName || profile?.businessType || "Your business";
  const customerName = lead.companyName || lead.contactName || "Customer";
  const lines: string[] = [
    `# ${title}`,
    `Prepared for: ${customerName}`,
    `Prepared by: ${businessName}`,
    `Generated: ${new Date().toISOString().slice(0, 10)}`,
    `Quote status: ${quote.status}`,
    "",
    "## Line Items",
  ];

  for (const item of quote.lineItems) {
    const qty = formatNumber(item.quantity);
    const price = sanitizePdfText(`${quote.currencyCode} ${formatUnitPriceNumber(item.unitPrice)}`);
    const lineTotal = formatMoney(item.lineTotal, quote.currencyCode);
    lines.push(`${item.productName} - ${qty}${item.unit ? ` ${item.unit}` : ""} x ${price} = ${lineTotal}`);
    if (item.notes?.trim()) lines.push(`  Note: ${item.notes.trim()}`);
  }

  lines.push("", "## Totals", `Grand total: ${formatMoney(quote.grandTotal, quote.currencyCode)}`, `Currency: ${quote.currencyCode}`);
  if (quote.validityNote?.trim()) lines.push(`Validity: ${quote.validityNote.trim()}`);
  if (quote.notes?.trim()) lines.push("", "## Notes", quote.notes.trim());

  lines.push(
    "",
    "## Review Note",
    "This quotation is generated from CRM data. Review the line items, totals, and terms before sending to the customer. Do not commit to prices, delivery, or terms the owner has not approved.",
  );
  return lines;
}

function formatMoney(amount: number, currencyCode: string): string {
  // Two decimals, thousands separator; preserve the stored currency code.
  const safe = Number.isFinite(amount) ? amount : 0;
  const formatted = safe.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return sanitizePdfText(`${currencyCode} ${formatted}`);
}

function formatNumber(value: number): string {
  return sanitizePdfText(String(Number.isFinite(value) ? value : 0));
}
