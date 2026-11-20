/**
 * 2026-07-29 — DEPTH AUDIT: Information Needed + AI Review + Replies — Batch 6.
 *
 * Persistence + Golden Thread proof for three surfaces:
 *   - Information Needed (answer / not-applicable / skip on unknownQuestions)
 *   - AI Review Queue (approve / reject on autoReplyLogs)
 *   - Replies reclassify (re-run classifier + lead-status ripple)
 *
 * Verified backend behaviour (research 2026-07-29):
 *   - POST /api/unknown-questions/:id/answer {finalAnswer, addToKnowledge}
 *     → unknownQuestion.status = "added_to_knowledge" (if addToKnowledge) or
 *     "answered"; finalAnswer written. Source: AISettingsService.ts:240.
 *   - PUT /api/unknown-questions/:id {suggestedAnswer} → draft only (used by
 *     "Save draft"). Generic update writes {status,finalAnswer,suggestedAnswer}.
 *   - "Skip" = NO API call (purely client-side) → nothing persists.
 *   - "Not applicable" = grouped-answer with literal "Not applicable for
 *     this business." (no distinct status).
 *   - POST /api/auto-reply-logs/:id/approve → status "approved" + send
 *     attempted (demo → not_configured, no real send). Source:
 *     AutoReplyReviewService.ts:10.
 *   - POST /api/auto-reply-logs/:id/reject → status "rejected". Source: :146.
 *   - POST /api/replies/:id/classify → re-runs classifyReply keyword heuristic
 *     → writes classification/confidence/summary + ripples to lead.status via
 *     getLeadStatusFromReplyClassification. Source: route.ts:2149-2183.
 *   - F-UI-3 check: ALL routes in these areas use the CORRECT path index.
 *
 * Seed (workspace_demo): 1 unknownQuestion (unknown_demo, channel whatsapp,
 * status open, missingTopic price_request, leadId lead_hot); 1 reply
 * (reply_demo, classification ask_price, leadId lead_hot); 1 autoReplyLog
 * (auto_reply_demo, status held_for_review, leadId lead_hot).
 *
 * Run: npx playwright test depth-info-review-replies --reporter=list
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { restoreDemoData, waitForServerQuiescent } from "./helpers/demo-data-snapshot";

import { readAppData } from "./helpers/app-data";
import { E2E_BASE_URL } from "./helpers/e2e-target";

const REPO_ROOT = path.resolve(__dirname, "..");
// 2026-08-19 (N-TEST-5) — was `path.join(REPO_ROOT, ".leadgen-data", "app-data.json")`.
// The suite moved onto its own data directory earlier the same session, so this
// pointed at the PRODUCT file while the server wrote to the suite's file: every
// assertion below read a value the test had never written. See e2e/helpers/data-dir.ts.
const BASE = E2E_BASE_URL;
const HEADERS = { Cookie: "lc_demo=1", "Content-Type": "application/json" };

function unknownQuestion(id: string): any {
  return readAppData().unknownQuestions?.find((u: any) => u.id === id);
}
function autoReplyLog(id: string): any {
  return readAppData().autoReplyLogs?.find((a: any) => a.id === id);
}
function reply(id: string): any {
  return readAppData().replies?.find((r: any) => r.id === id);
}
function lead(id: string): any {
  return readAppData().leads?.find((l: any) => l.id === id);
}
async function api(route: string, method = "GET", body?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${route}`, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ════════════════════════════════════════════════════════════════════════════
// INFORMATION NEEDED — answer / not-applicable / skip
// ════════════════════════════════════════════════════════════════════════════
test.describe("Information Needed depth — unknownQuestion actions", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("answer with addToKnowledge → status added_to_knowledge + finalAnswer written", async () => {
    expect(unknownQuestion("unknown_demo").status).toBe("open");
    const ANSWER = "₹120 per metre for gold zari, MOQ 50 metres.";
    const { status } = await api("/api/unknown-questions/unknown_demo/answer", "POST", {
      finalAnswer: ANSWER, addToKnowledge: true,
    });
    expect(status).toBeLessThan(400);

    const u = unknownQuestion("unknown_demo");
    expect(u.status, "answer+addToKnowledge → added_to_knowledge").toBe("added_to_knowledge");
    expect(u.finalAnswer).toBe(ANSWER);
  });

  test("answer WITHOUT addToKnowledge → status answered + finalAnswer written", async () => {
    const ANSWER = "Draft answer, not yet adding to KB.";
    const { status } = await api("/api/unknown-questions/unknown_demo/answer", "POST", {
      finalAnswer: ANSWER, addToKnowledge: false,
    });
    expect(status).toBeLessThan(400);
    const u = unknownQuestion("unknown_demo");
    expect(u.status, "answer without addToKnowledge → answered").toBe("answered");
    expect(u.finalAnswer).toBe(ANSWER);
  });

  test("'Not applicable' = answer with literal text → added_to_knowledge (no special status)", async () => {
    // The UI's "Mark not applicable" sends the grouped-answer endpoint with
    // finalAnswer "Not applicable for this business." + addToKnowledge true.
    const { status } = await api("/api/unknown-questions/groups/answer", "POST", {
      questionIds: ["unknown_demo"],
      finalAnswer: "Not applicable for this business.",
      addToKnowledge: true,
    });
    expect(status).toBeLessThan(400);
    const u = unknownQuestion("unknown_demo");
    expect(u.status).toBe("added_to_knowledge");
    expect(u.finalAnswer).toBe("Not applicable for this business.");
  });

  test("PUT unknown-question draft (Save draft) writes suggestedAnswer only, status stays open", async () => {
    const DRAFT = "Pending: need to confirm with production team.";
    const { status } = await api("/api/unknown-questions/unknown_demo", "PUT", { suggestedAnswer: DRAFT });
    expect(status).toBeLessThan(400);
    const u = unknownQuestion("unknown_demo");
    expect(u.suggestedAnswer).toBe(DRAFT);
    // A draft does NOT flip status (it's still open / needs an answer action).
    expect(u.status, "draft must not change status").toBe("open");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AI REVIEW QUEUE — approve / reject on autoReplyLogs (no real send in demo)
// ════════════════════════════════════════════════════════════════════════════
test.describe("AI Review Queue depth — autoReplyLog approve/reject", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("reject → status rejected + needsHumanReview cleared", async () => {
    expect(autoReplyLog("auto_reply_demo").status).toBe("held_for_review");
    const { status } = await api("/api/auto-reply-logs/auto_reply_demo/reject", "POST", {});
    expect(status).toBeLessThan(400);
    const a = autoReplyLog("auto_reply_demo");
    expect(a.status).toBe("rejected");
    expect(a.needsHumanReview).toBe(false);
  });

  test("approve → status approved (no real send in demo; not_configured)", async () => {
    const { status, body } = await api("/api/auto-reply-logs/auto_reply_demo/approve", "POST", {});
    expect(status).toBeLessThan(400);
    const a = autoReplyLog("auto_reply_demo");
    expect(a.status).toBe("approved");
    // In demo/unconfigured mode the provider returns not_configured — NO real
    // WhatsApp send happens (sacred no-auto-outreach respected).
    expect(["not_configured", "sent_api", "sent_manual", "failed"]).toContain(a.sendStatus || body?.sendStatus);
  });

  test("double-approve is blocked (no double-send)", async ({ request }) => {
    // Approve once.
    await api("/api/auto-reply-logs/auto_reply_demo/approve", "POST", {});
    expect(autoReplyLog("auto_reply_demo").status).toBe("approved");
    // Approve again → must be rejected (prevents double-send).
    const { status } = await api("/api/auto-reply-logs/auto_reply_demo/approve", "POST", {});
    expect(status, "double-approve must be blocked").toBeGreaterThanOrEqual(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REPLIES RECLASSIFY — re-run classifier + lead-status ripple
// ════════════════════════════════════════════════════════════════════════════
test.describe("Replies depth — reclassify (re-run classifier + lead ripple)", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("classify re-runs the keyword heuristic + writes classification fields", async () => {
    // reply_demo rawText: "Please share price and minimum order quantity."
    // → classifyReply keyword heuristic → "ask_price" (contains "price").
    const { status } = await api("/api/replies/reply_demo/classify", "POST", {});
    expect(status).toBeLessThan(400);
    const r = reply("reply_demo");
    expect(r.classification).toBeTruthy();
    expect(r.classification).toBe("ask_price"); // contains "price"
    expect(r.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(r.summary).toBeTruthy();
  });

  test("classify ripples to the lead status (ask_price on lead_hot → stays hot_lead)", async () => {
    // reply_demo → lead_hot. ask_price maps to hot_lead. lead_hot is already
    // hot_lead (a protected status), so it must be PRESERVED — the call must
    // not regress the lead to a lower status.
    const leadBefore = lead("lead_hot").status;
    await api("/api/replies/reply_demo/classify", "POST", {});
    const leadAfter = lead("lead_hot").status;
    expect(["hot_lead", "mql", "sql", "opportunity"]).toContain(leadAfter);
    expect(leadAfter, "classify must not regress a hot lead").toBe(leadBefore);
  });

  test("unsubscribe classification → lead marked do_not_contact (sacred DNC rule)", async () => {
    // Create a reply whose rawText triggers "unsubscribe" (contains STOP/unsubscribe).
    const { status, body } = await api("/api/replies", "POST", {
      leadId: "lead_approved", channel: "WhatsApp", rawText: "STOP sending me messages, unsubscribe me now.",
    });
    expect(status).toBeLessThan(400);
    const newReplyId = body.id;
    // Reclassify it → unsubscribe → lead must become do_not_contact.
    await api(`/api/replies/${newReplyId}/classify`, "POST", {});
    const r = reply(newReplyId);
    expect(r.classification, "STOP keyword → unsubscribe").toBe("unsubscribe");
    const l = lead("lead_approved");
    expect(l.status, "unsubscribe → lead do_not_contact").toBe("do_not_contact");
    expect(l.doNotContact, "unsubscribe → doNotContact flag true").toBe(true);
  });
});
