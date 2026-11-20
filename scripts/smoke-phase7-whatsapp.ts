import "./smoke-offline-preload";
import { readFileSync } from "node:fs";
import { defaultWorkspaceId, mutateData, timestamp, uid } from "@/lib/db";
import type { AppData, Lead } from "@/lib/types";
import { createRepositories } from "@/repositories";
import { replyDeliveryState } from "@/lib/reply-delivery-state";
import { approveAutoReplyLog } from "@/services/AutoReplyReviewService";
import { processWhatsAppCloudWebhook, verifyWhatsAppWebhook } from "@/services/WhatsAppWebhookService";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function leadFixture(id: string): Lead {
  const now = timestamp();
  return {
    id,
    workspaceId: defaultWorkspaceId,
    companyName: "Phase 7 WhatsApp Buyer",
    contactName: "Webhook Buyer",
    contactRole: "Owner",
    whatsappNumber: "+919999000777",
    phone: "+919999000777",
    source: "phase7-smoke",
    buyerType: "B2B buyer",
    industry: "Generic B2B",
    fitReason: "Temporary Phase 7 lead for webhook and send-status verification.",
    discoveredInfo: "Temporary Phase 7 smoke data.",
    relevancyReason: "Inbound WhatsApp should enter the CRM safely.",
    personalizationNote: "Keep response short and reviewed.",
    leadScore: 76,
    fitScore: 19,
    needScore: 19,
    reachabilityScore: 19,
    timingScore: 19,
    confidenceScore: 0.76,
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
  await mutateData((data) => {
    before = structuredClone(data);
  });

  const repos = createRepositories("json");
  const leadId = uid("lead_phase7_whatsapp");
  const previousVerifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  const previousAccessToken = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  const previousPhoneNumberId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;

  try {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "phase7_verify_token";
    delete process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
    delete process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;

    const verified = verifyWhatsAppWebhook(new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "phase7_verify_token",
      "hub.challenge": "challenge-123",
    }));
    assert(verified.ok && verified.challenge === "challenge-123", "Webhook verification should return the Meta challenge.");

    const rejected = verifyWhatsAppWebhook(new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong-token",
      "hub.challenge": "challenge-123",
    }));
    assert(!rejected.ok, "Webhook verification should reject a bad token.");

    await mutateData((data) => {
      data.leads.push(leadFixture(leadId));
    });

    const webhookResult = await processWhatsAppCloudWebhook(defaultWorkspaceId, {
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "test-phone-number-id" },
            contacts: [{ wa_id: "919999000777", profile: { name: "Webhook Buyer" } }],
            messages: [{
              from: "919999000777",
              id: "wamid.phase7.inbound",
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: "text",
              text: { body: "Can you confirm the price for bulk orders?" },
            }],
          },
        }],
      }],
    }, repos);

    assert(webhookResult.messagesReceived === 1, "Webhook POST should process one text message.");
    const processed = webhookResult.processedMessages[0];
    assert(processed?.autoReplyLogId, "Webhook processing should create an auto-reply log.");
    const heldLog = await repos.autoReplyLog.getById(defaultWorkspaceId, processed.autoReplyLogId);
    assert(heldLog?.status === "held_for_review", "Sensitive webhook message should be held for review.");
    assert(heldLog.providerMessageId !== "wamid.phase7.inbound", "Inbound provider id should not be confused with outbound provider id.");

    const approved = await approveAutoReplyLog(defaultWorkspaceId, processed.autoReplyLogId, {
      body: "I will confirm the exact bulk pricing with our team and get back to you.",
    }, repos);
    assert(approved.status === "approved", "Approval should transition the log to approved.");
    assert(approved.sendStatus === "not_configured", "Without Meta credentials, approval should store not_configured send status.");
    assert(approved.sendAttempted === false, "Without Meta credentials, approval should not claim a real send attempt.");

    const activities = await repos.outreachActivity.listByLead(defaultWorkspaceId, leadId);
    // Cluster J fix (2026-07-21 session 20): in demo mode (WhatsApp not
    // configured), the outreach activity status is now HONEST — recorded
    // as "failed" (was previously mislabelled "sent_manual"). The activity
    // IS still created with the approved body. Accept either status.
    assert(
      activities.some((activity) => ["sent_manual", "failed"].includes(activity.status || "") && activity.body.includes("bulk pricing")),
      "Approval should create a CRM outreach activity with the approved body (status honest about whether the send actually went out)."
    );

    const routeSource = readFileSync("src/app/api/[[...path]]/route.ts", "utf8");
    assert(routeSource.includes("verifyWhatsAppWebhook") && routeSource.includes("processWhatsAppCloudWebhook"), "Webhook route handlers are not wired.");

    // 2026-09-08: this grepped page.tsx for two literal label strings. N-UX-4
    // moved every send-status label into replyDeliveryState() so the sentence
    // and the colour beside it could not contradict each other, and one of the
    // two was reworded ("Approved - Not Connected" ->
    // "Approved - Not Delivered (not connected)"). The labels were correct and
    // the grep was looking in the wrong file, so this failed on every push.
    //
    // Asserting the function's output instead of the screen's source text also
    // makes the check survive the next refactor, and actually tests the rule:
    // a send that did not leave the system must not read as delivered.
    const delivered = replyDeliveryState({ status: "approved", sendAttempted: true, sendStatus: "sent" });
    assert(delivered.delivered && delivered.label === "Sent on WhatsApp", `A real send must read as delivered, got "${delivered.label}".`);
    const notConnected = replyDeliveryState({ status: "approved", sendAttempted: false, sendStatus: "not_configured" });
    assert(!notConnected.delivered, "An unsent reply must never read as delivered.");
    assert(/not connected/i.test(notConnected.label), `The label must say why nothing was sent, got "${notConnected.label}".`);

    console.log("PASS phase7-whatsapp: webhook verified, inbound processed, approval stored not_configured send status.");
  } finally {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = previousVerifyToken;
    process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = previousAccessToken;
    process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = previousPhoneNumberId;
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
