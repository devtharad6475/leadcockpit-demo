import { readFileSync } from "node:fs";
import { defaultWorkspaceId, mutateData, timestamp, uid } from "@/lib/db";
import type { AppData, Lead } from "@/lib/types";
import { createRepositories } from "@/repositories";
import { shouldProtectQualifiedStatus } from "@/lib/lead-rules";
import { handleIncomingWhatsAppMessage } from "@/services/WhatsAppConversationEngine";
import { approveAutoReplyLog } from "@/services/AutoReplyReviewService";
import { getLeadActivityTimeline } from "@/services/OutreachQueueService";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function leadFixture(id: string, name: string, whatsappNumber: string): Lead {
  const now = timestamp();
  return {
    id,
    workspaceId: defaultWorkspaceId,
    companyName: name,
    contactName: "Reply Reviewer",
    contactRole: "Owner",
    whatsappNumber,
    source: "phase6-smoke",
    buyerType: "B2B buyer",
    industry: "Generic B2B",
    companySizeBucket: "small company",
    fitReason: "Generic smoke lead for reply safety.",
    discoveredInfo: "Temporary Phase 6 smoke data.",
    relevancyReason: "Reply handling must be reviewed safely.",
    personalizationNote: "Keep response short and reviewed.",
    leadScore: 80,
    fitScore: 20,
    needScore: 20,
    reachabilityScore: 20,
    timingScore: 20,
    confidenceScore: 0.8,
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
  const optOutLeadId = uid("lead_phase6_optout");
  const reviewLeadId = uid("lead_phase6_review");

  try {
    await mutateData((data) => {
      // R1 audit fix: each lead needs a UNIQUE phone number. Previously both
      // leads shared +910000000099, so when the opt-out registered DNC by
      // phone, the review lead was also blocked — masking the real intent of
      // the test (which is to verify approve+send works for a NON-DNC lead).
      data.leads.push(leadFixture(optOutLeadId, "Phase 6 Opt Out Lead", "+910000000099"));
      data.leads.push(leadFixture(reviewLeadId, "Phase 6 Review Lead", "+910000000199"));
    });

    const optOut = await handleIncomingWhatsAppMessage({
      workspaceId: defaultWorkspaceId,
      leadId: optOutLeadId,
      rawText: "Stop, unsubscribe me",
    }, repos);
    assert(optOut.blocked, "Unsubscribe should be blocked by the safety gate.");
    const optOutLead = await repos.lead.getLeadById(defaultWorkspaceId, optOutLeadId);
    assert(optOutLead?.doNotContact === true && optOutLead.status === "do_not_contact", "Unsubscribe should mark the lead do-not-contact.");
    const optOutLog = await repos.autoReplyLog.getById(defaultWorkspaceId, optOut.autoReplyLogId);
    assert(optOutLog?.status === "blocked", "Unsubscribe auto-reply log should be blocked.");

    const sensitive = await handleIncomingWhatsAppMessage({
      workspaceId: defaultWorkspaceId,
      leadId: reviewLeadId,
      rawText: "What is the price of zari lace?",
    }, repos);
    assert(sensitive.needsHumanReview && !sensitive.canAutoSend, "Sensitive price question must need human review.");
    const heldLog = await repos.autoReplyLog.getById(defaultWorkspaceId, sensitive.autoReplyLogId);
    assert(heldLog?.status === "held_for_review", "Sensitive price question should create a held-for-review log.");

    const approved = await approveAutoReplyLog(defaultWorkspaceId, sensitive.autoReplyLogId, { body: "I will confirm the exact price with our team and get back to you." }, repos);
    assert(approved.status === "approved", "Approval should transition the log to approved.");
    assert(approved.generatedReply?.includes("confirm the exact price"), "Approval should preserve the edited response text.");
    const activities = await repos.outreachActivity.listByLead(defaultWorkspaceId, reviewLeadId);
    assert(activities.some((activity) => activity.body.includes("confirm the exact price")), "Approval should create a manual sent outreach activity.");
    const reviewLead = await repos.lead.getLeadById(defaultWorkspaceId, reviewLeadId);
    // 2026-09-08: this asserted `status === "contacted"`, which the product
    // stopped doing on purpose. The F1 audit fix (2026-08-04) stopped the
    // approve+send path demoting a qualified lead — mql/sql/hot_lead/
    // opportunity/won — back to "contacted" just because a reply went out; the
    // inbound engine and the outbound-log route already had that guard and this
    // path was the only one missing it.
    //
    // The message this smoke sends is a price question, which promotes the lead
    // to hot_lead before the approval runs. So the correct expectation is that
    // the contact time is refreshed and the hard-won status is NOT thrown away.
    // Measured here: status hot_lead, lastContactedAt set.
    assert(Boolean(reviewLead?.lastContactedAt), "Approval should stamp lastContactedAt.");
    assert(
      reviewLead?.status === "contacted" || shouldProtectQualifiedStatus(reviewLead?.status),
      `Approval must either mark the lead contacted or preserve a qualified status, got ${reviewLead?.status}.`,
    );

    // R1 audit fix regression check: a contact on the PERMANENT DNC registry
    // cannot be sent to even via the human-approved path. The opt-out lead
    // above is on the registry; approving its auto-reply log MUST throw.
    // (Previously this path only checked the lead flag, missing contacts whose
    // flag was cleared but who are still permanently DNC.)
    let dncSendBlocked = false;
    try {
      await approveAutoReplyLog(defaultWorkspaceId, optOut.autoReplyLogId, { body: "should not send" }, repos);
    } catch (error) {
      dncSendBlocked = error instanceof Error && /do.?not.?contact|blocked/i.test(error.message);
    }
    assert(dncSendBlocked, "R1 regression: human-approved send to a permanent-DNC contact must be blocked.");

    const timeline = await getLeadActivityTimeline(defaultWorkspaceId, reviewLeadId, repos);
    assert(timeline.events.some((event) => event.label === "Reply received"), "Timeline should include the incoming reply event.");
    assert(timeline.events.some((event) => event.label.includes("WhatsApp reply")), "Timeline should include WhatsApp agent log events.");
    // Cluster J fix (2026-07-21 session 20): the outreach activity status
    // is now HONEST. In demo mode (WhatsApp not configured), the send
    // returns status="not_configured" which is recorded as "failed" (was
    // previously mislabelled "sent_manual"). The activity IS still created
    // — that's what this assertion verifies. Look for either label so the
    // test passes in both real-send (sent_manual) and demo (failed) modes.
    assert(
      timeline.events.some((event) => event.label.includes("marked sent") || event.label.includes("failed") || event.label.includes("not_configured")),
      "Timeline should include the outreach activity for the approved reply (status honest about send outcome)."
    );

    const routeSource = readFileSync("src/app/api/[[...path]]/route.ts", "utf8");
    assert(routeSource.includes("approveAutoReplyLog") && routeSource.includes("rejectAutoReplyLog"), "Phase 6 approve/reject routes are not wired to the backend service.");

    console.log(`PASS phase6-replies: opt-out blocked, ${heldLog.status} reviewed, ${timeline.events.length} timeline events.`);
  } finally {
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
  console.error(error);
  process.exit(1);
});
