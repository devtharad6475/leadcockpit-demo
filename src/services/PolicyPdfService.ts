import type { Lead, PolicySettings, BusinessProfile } from "@/lib/types";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { saveMediaCatalogItem } from "@/services/MediaCatalogService";
// GAP-7 (2026-07-31): the hand-rolled PDF writer is now the shared
// `src/lib/pdf-writer.ts` chokepoint (one source of truth for every PDF —
// Policy, Quote, future). Previously this file owned the whole writer; it now
// only assembles the markdown-lines + delegates. A fix in pdf-writer fixes
// every PDF.
import { buildPdfFromLines, safeFilePart } from "@/lib/pdf-writer";

export type PolicyPdfInput = {
  workspaceId: string;
  leadId: string;
  title?: string;
  customClauses?: string;
};

export async function generatePolicyPdfForLead(input: PolicyPdfInput, repos: RepositoryBundle = createRepositories()) {
  const lead = await repos.lead.getLeadById(input.workspaceId, input.leadId);
  if (!lead) throw new Error("Lead not found.");
  const profile = await repos.businessProfile.getByWorkspace(input.workspaceId);
  const policies = await repos.policySettings.getByWorkspace(input.workspaceId);
  const title = input.title?.trim() || "Customer Policy Summary";
  const pdf = await buildPolicyPdf({
    title,
    lead,
    profile,
    policies,
    customClauses: input.customClauses,
  });
  const fileName = `${safeFilePart(lead.companyName || lead.contactName || "customer")}-${safeFilePart(title)}.pdf`;
  return saveMediaCatalogItem({
    workspaceId: input.workspaceId,
    fileName,
    fileType: "application/pdf",
    buffer: pdf,
    category: "policy_document",
    title: `${title} - ${lead.companyName || lead.contactName || "Customer"}`,
    caption: "Generated from the current CRM lead and saved policy settings. Owner review is recommended before sharing.",
    leadId: lead.id,
    folder: "policies",
  }, repos);
}

export async function buildPolicyPdf(input: { title: string; lead: Lead; profile?: BusinessProfile; policies?: PolicySettings; customClauses?: string }) {
  const lines = buildPolicyLines(input);
  return buildPdfFromLines(lines);
}

function buildPolicyLines(input: { title: string; lead: Lead; profile?: BusinessProfile; policies?: PolicySettings; customClauses?: string }) {
  const companyName = input.profile?.companyName || input.profile?.businessType || "Your business";
  const customer = input.lead.companyName || input.lead.contactName || "Customer";
  const lines = [
    `# ${input.title}`,
    `Prepared for: ${customer}`,
    `Prepared by: ${companyName}`,
    `Generated: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "## Customer Context",
    `Lead status: ${input.lead.status}`,
    `Buyer type: ${input.lead.buyerType || "Not specified"}`,
    `Location: ${[input.lead.city, input.lead.state, input.lead.country].filter(Boolean).join(", ") || "Not specified"}`,
    "",
    "## Policy Details",
    `Payment: ${input.policies?.paymentPolicy || "Confirm payment terms with the owner before committing."}`,
    `Credit: ${input.policies?.creditPolicy || "Credit terms are not confirmed yet."}`,
    `Shipping and delivery: ${input.policies?.shippingDeliveryPolicy || "Delivery terms should be confirmed before sharing."}`,
    `Returns and replacements: ${input.policies?.returnReplacementPolicy || "Return and replacement terms should be confirmed before sharing."}`,
    `Cancellation: ${input.policies?.cancellationPolicy || "Cancellation terms should be confirmed before sharing."}`,
    `Customization: ${input.policies?.customizationPolicy || "Customization terms should be confirmed before sharing."}`,
    `Samples: ${input.policies?.samplePolicy || "Sample terms should be confirmed before sharing."}`,
  ];
  if (input.customClauses?.trim()) {
    lines.push("", "## Additional Notes", input.customClauses.trim());
  }
  lines.push("", "## Review Note", "This document is generated from approved workspace settings and CRM context. Review it before sending to a customer.");
  return lines;
}
