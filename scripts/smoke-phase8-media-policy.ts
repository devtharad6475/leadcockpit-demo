import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { defaultWorkspaceId, mutateData, timestamp, uid } from "@/lib/db";
import type { AppData, Lead } from "@/lib/types";
import { createRepositories } from "@/repositories";
import { MetaWhatsAppCloudProvider } from "@/providers/whatsapp/MetaWhatsAppCloudProvider";
import { approveAutoReplyLog } from "@/services/AutoReplyReviewService";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";
import { saveMediaCatalogItem } from "@/services/MediaCatalogService";
import { buildPolicyPdf, generatePolicyPdfForLead } from "@/services/PolicyPdfService";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function leadFixture(id: string): Lead {
  const now = timestamp();
  return {
    id,
    workspaceId: defaultWorkspaceId,
    companyName: "Phase 8 Media Buyer",
    contactName: "Media Buyer",
    whatsappNumber: "+919999000888",
    phone: "+919999000888",
    source: "phase8-smoke",
    buyerType: "B2B buyer",
    industry: "Generic B2B",
    fitReason: "Temporary Phase 8 lead for media and policy verification.",
    discoveredInfo: "Temporary Phase 8 smoke data.",
    relevancyReason: "Media sharing should remain under review.",
    personalizationNote: "Attach catalog only after owner review.",
    leadScore: 78,
    fitScore: 20,
    needScore: 20,
    reachabilityScore: 19,
    timingScore: 19,
    confidenceScore: 0.78,
    qualificationStatus: "qualified",
    scoreReason: {},
    status: "approved",
    enrichmentStatus: "completed",
    enrichmentResult: { status: "matched", validationNote: "Smoke verified.", enrichedAt: now },
    reviewStatus: "approved",
    doNotContact: false,
    consentStatus: "unknown",
    createdAt: now,
    updatedAt: now,
  };
}

async function main() {
  let before: AppData | undefined;
  const filesToRemove: string[] = [];
  await mutateData((data) => {
    before = structuredClone(data);
  });

  const repos = createRepositories("json");
  const leadId = uid("lead_phase8_media");
  const previousAccessToken = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  const previousPhoneNumberId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;
  const previousPublicOrigin = process.env.WHATSAPP_PUBLIC_ORIGIN;
  const originalFetch = globalThis.fetch;

  try {
    await mutateData((data) => {
      data.leads.push(leadFixture(leadId));
      data.policySettings ||= [];
      data.policySettings.push({
        id: uid("policy_phase8"),
        workspaceId: defaultWorkspaceId,
        paymentPolicy: "50% advance and balance before dispatch.",
        creditPolicy: "Credit is owner-approved only.",
        shippingDeliveryPolicy: "Dispatch timelines are confirmed after order details are reviewed.",
        returnReplacementPolicy: "Replacement is reviewed case by case for approved quality issues.",
        cancellationPolicy: "Cancellation terms are confirmed before production.",
        customizationPolicy: "Custom work requires final approval before production.",
        samplePolicy: "Samples can be discussed before bulk order.",
        createdAt: timestamp(),
        updatedAt: timestamp(),
      });
    });

    const catalog = await saveMediaCatalogItem({
      workspaceId: defaultWorkspaceId,
      fileName: "phase8-catalog.pdf",
      fileType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\nphase8 catalog\n%%EOF", "utf8"),
      category: "catalog",
      title: "Phase 8 Catalog",
      caption: "Temporary catalog for smoke verification.",
    }, repos);
    filesToRemove.push(catalog.storagePath);
    // 2026-09-29: since 2026-09-10 (session 55) the file is stored with its row,
    // not on the container's disk — so "reusable" means it can be read back.
    const bytes = await repos.mediaCatalog.getFileBytes(defaultWorkspaceId, catalog.id);
    assert(Boolean(bytes && bytes.length > 0) || existsSync(catalog.storagePath), "Catalog upload should keep a reusable file.");
    assert((await repos.mediaCatalog.listByWorkspace(defaultWorkspaceId)).some((item) => item.id === catalog.id), "Catalog should be listed in the media repository.");

    const pdf = await buildPolicyPdf({
      title: "Customer Policy Summary",
      lead: leadFixture(leadId),
      policies: { id: "policy", workspaceId: defaultWorkspaceId, paymentPolicy: "Advance payment.", createdAt: timestamp(), updatedAt: timestamp() },
    });
    assert(pdf.toString("utf8", 0, 8) === "%PDF-1.4", "Policy PDF builder should return a valid PDF header.");

    const policyMedia = await generatePolicyPdfForLead({
      workspaceId: defaultWorkspaceId,
      leadId,
      title: "Customer Policy Summary",
      customClauses: "Use owner-approved delivery dates only.",
    }, repos);
    filesToRemove.push(policyMedia.storagePath);
    assert(policyMedia.category === "policy_document", "Generated policy should be saved as a policy document.");
    assert(policyMedia.leadId === leadId, "Generated policy should stay linked to the CRM lead.");
    const policyBytes = await repos.mediaCatalog.getFileBytes(defaultWorkspaceId, policyMedia.id);
    assert(Boolean(policyBytes && policyBytes.length > 0) || existsSync(policyMedia.storagePath), "Generated policy PDF should be kept and readable.");

    const result = await handleIncomingWhatsAppMessage({
      workspaceId: defaultWorkspaceId,
      leadId,
      rawText: "Can you send your catalog PDF?",
    }, repos);
    assert(result.mediaAttachment?.id === catalog.id, "Catalog request should suggest the catalog attachment.");
    const log = await repos.autoReplyLog.getById(defaultWorkspaceId, result.autoReplyLogId);
    assert(log?.mediaAttachmentId === catalog.id, "Auto-reply log should record the suggested media attachment.");

    const approved = await approveAutoReplyLog(defaultWorkspaceId, result.autoReplyLogId, {
      body: "Sure, I am sharing the catalog for your review.",
      mediaAttachmentId: catalog.id,
    }, repos);
    assert(approved.mediaAttachmentId === catalog.id, "Approval should preserve selected media attachment.");
    const activities = await repos.outreachActivity.listByLead(defaultWorkspaceId, leadId);
    assert(activities.some((activity) => activity.mediaAttachmentId === catalog.id), "Outreach activity should audit the media attachment.");

    process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = "phase8-token";
    process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "phase8-phone";
    process.env.WHATSAPP_PUBLIC_ORIGIN = "https://example.com";
    let sentPayload: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sentPayload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.phase8" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const send = await new MetaWhatsAppCloudProvider().sendTextMessage({
      workspaceId: defaultWorkspaceId,
      to: "+919999000888",
      body: "Catalog attached.",
      mediaAttachmentUrl: catalog.url,
      mediaAttachmentMimeType: catalog.fileType,
      mediaAttachmentFilename: catalog.fileName,
    });
    assert(send.status === "sent", "Configured provider should accept media payload.");
    assert(sentPayload?.type === "document", "PDF catalog should be sent as a WhatsApp document payload.");

    const routeSource = readFileSync("src/app/api/[[...path]]/route.ts", "utf8");
    assert(routeSource.includes("/api/media") || routeSource.includes("match(path, [\"media\"]"), "Media API route should be wired.");
    const uiSource = readFileSync("src/app/page.tsx", "utf8");
    assert(readFileSync("src/app/sections/IntegrationsSection.tsx", "utf8").includes("Files the AI may send") && uiSource.includes("Policy PDF") && uiSource.includes("Attach catalog"), "UI should expose media gallery, policy PDF, and reply attachment controls.");

    console.log("PASS phase8-media-policy: media catalog, policy PDF, reply attachment, and WhatsApp media payload verified.");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = previousAccessToken;
    process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = previousPhoneNumberId;
    process.env.WHATSAPP_PUBLIC_ORIGIN = previousPublicOrigin;
    for (const file of filesToRemove) await rm(file, { force: true }).catch(() => undefined);
    if (before) {
      await mutateData((data) => {
        const restored = structuredClone(before) as AppData;
        Object.keys(data).forEach((key) => delete (data as unknown as Record<string, unknown>)[key]);
        Object.assign(data, restored);
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
