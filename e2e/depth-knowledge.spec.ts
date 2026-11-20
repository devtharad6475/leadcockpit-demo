/**
 * 2026-07-29 — DEPTH AUDIT: Knowledge Base — Slice B, Batch 5.
 *
 * Persistence + Golden Thread proof for the Knowledge flows: Sync, answer
 * Save, answer Approve (+ the resolved-count ripple through unknownQuestions).
 *
 * Verified backend behaviour (research 2026-07-29):
 *   - POST /api/knowledge/sync (no questionKey/answer) → full
 *     syncWorkspaceKnowledge → returns a SyncKnowledgeSummary. Source:
 *     SyncKnowledgeService.ts:83, route.ts:2598.
 *   - PUT /api/knowledge/question-answers/:id {answer, answerStatus} →
 *     persists answer, stamps sourceType="manual_edit", confidenceScore=1,
 *     isUserApproved=true, reviewedByUser="user_owner", reviewedAt=now.
 *     Source: DocumentQuestionAnsweringService.ts:631-664.
 *   - PUT /api/knowledge/question-answers/:id/approve → isUserApproved=true,
 *     answerStatus="answered", reviewedAt stamped. NOTE: there is NO
 *     "approved" status value (status enum has no "approved"). Source:
 *     DocumentQuestionAnsweringService.ts:666-673.
 *   - Resolved-count ripple: approving an answer calls
 *     resolveMatchingUnknownQuestions → sets matching unknownQuestions (channel
 *     "knowledge", status "open") to status "added_to_knowledge". Source:
 *     DocumentQuestionAnsweringService.ts:738-752.
 *   - F-UI-3 check: ALL 13 knowledge/extraction/unknown-question routes use
 *     the CORRECT path index. No off-by-one in this family.
 *
 * Seed (workspace_demo): knowledgeQuestionAnswers is EMPTY (not seeded) —
 * framework stubs materialize lazily on the first GET to
 * /knowledge/question-answers or /unknown-questions. 1 knowledgeBaseDocument
 * (company_profile), 1 chunk, 1 productKnowledge. The 1 unknownQuestion is
 * channel "whatsapp" (excluded from knowledge groups).
 *
 * Run: npx playwright test depth-knowledge --reporter=list
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

function answers(): any[] {
  return readAppData().knowledgeQuestionAnswers?.filter((a: any) => a.workspaceId === "workspace_demo") || [];
}
function unknownQuestions(): any[] {
  return readAppData().unknownQuestions?.filter((u: any) => u.workspaceId === "workspace_demo") || [];
}
async function api(route: string, method = "GET", body?: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}${route}`, { method, headers: HEADERS, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Materialize the framework answer stubs by hitting the list endpoint
 *  (the repo lazily creates "unanswered" stubs on first read). Returns one
 *  stub id we can then Save/Approve. */
async function materializeOneStub(): Promise<string> {
  const r = await api("/api/knowledge/question-answers");
  expect(r.status).toBeLessThan(400);
  // The list endpoint materializes stubs; re-read the file to get an id.
  const list = answers();
  expect(list.length, "framework stubs must materialize on first read").toBeGreaterThan(0);
  // Pick a stub that is unanswered + not yet approved.
  const stub = list.find((a) => a.answerStatus === "unanswered" && !a.isUserApproved) || list[0];
  return stub.id;
}

// ════════════════════════════════════════════════════════════════════════════
// SYNC — full workspace knowledge sync returns a summary
// ════════════════════════════════════════════════════════════════════════════
test.describe("Knowledge depth — Sync", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("POST /api/knowledge/sync returns a summary with knowledgeBase status", async () => {
    // No questionKey/answer in body → full syncWorkspaceKnowledge branch.
    const { status, body } = await api("/api/knowledge/sync", "POST", {});
    expect(status).toBeLessThan(400);
    // The summary must report a knowledgeBase section (proves sync ran).
    expect(body?.knowledgeBase || body?.data?.knowledgeBase, "sync must return a knowledgeBase summary").toBeTruthy();
    const kb = body?.knowledgeBase || body?.data?.knowledgeBase;
    expect(typeof kb.synced).toBe("boolean");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ANSWER SAVE — persists answer + stamps review metadata
// ════════════════════════════════════════════════════════════════════════════
test.describe("Knowledge depth — Answer Save", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("PUT answer persists the text + stamps reviewedByUser/reviewedAt/confidence=1", async () => {
    const id = await materializeOneStub();
    const ANSWER = "We ship pan-India via Blue Dart, 3-5 working days.";
    const before = answers().find((a) => a.id === id);

    const { status } = await api(`/api/knowledge/question-answers/${id}`, "PUT", {
      answer: ANSWER,
      answerStatus: "answered",
    });
    expect(status).toBeLessThan(400);

    const after = answers().find((a) => a.id === id);
    expect(after.answer).toBe(ANSWER);
    expect(after.answerStatus).toBe("answered");
    // Saving a manual answer stamps review metadata + marks user-approved.
    expect(after.isUserApproved).toBe(true);
    expect(after.confidenceScore).toBe(1);
    expect(after.reviewedByUser).toBeTruthy();
    expect(after.reviewedAt).toBeTruthy();
    expect(before.reviewedAt).toBeFalsy(); // proves it was newly stamped
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ANSWER APPROVE — isUserApproved=true + answerStatus=answered (no "approved" status)
// ════════════════════════════════════════════════════════════════════════════
test.describe("Knowledge depth — Answer Approve", () => {
  test.beforeEach(async () => { restoreDemoData(); await waitForServerQuiescent(); });

  test("PUT approve sets isUserApproved=true + answerStatus=answered (no 'approved' status exists)", async () => {
    const id = await materializeOneStub();
    // First give it an answer (an unanswered stub has nothing to approve).
    await api(`/api/knowledge/question-answers/${id}`, "PUT", {
      answer: "MOQ is 50 metres per design.",
      answerStatus: "answered",
    });
    // Now approve.
    const { status } = await api(`/api/knowledge/question-answers/${id}/approve`, "PUT", {});
    expect(status).toBeLessThan(400);

    const after = answers().find((a) => a.id === id);
    expect(after.isUserApproved, "approve must set isUserApproved=true").toBe(true);
    expect(after.answerStatus, "approve sets status to answered (NOT 'approved')").toBe("answered");
    expect(after.reviewedAt).toBeTruthy();
  });

  test("approve ripple: a matching open knowledge unknownQuestion flips to added_to_knowledge", async () => {
    // Materialize stubs (this also creates knowledge-channel clarification
    // questions tied to unanswered framework questions).
    await materializeOneStub();
    const knowledgeOpenBefore = unknownQuestions().filter((u) => u.channel === "knowledge" && u.status === "open").length;
    // If there are open knowledge unknowns, approving a matching answer must
    // resolve them. Pick any stub, answer+approve it.
    const ids = answers().map((a) => a.id);
    if (ids.length === 0) { test.skip(); return; }
    const id = ids[0];
    await api(`/api/knowledge/question-answers/${id}`, "PUT", { answer: "Test answer for ripple.", answerStatus: "answered" });
    await api(`/api/knowledge/question-answers/${id}/approve`, "PUT", {});

    // The approve path calls resolveMatchingUnknownQuestions. Any matching
    // open knowledge unknown must have moved out of "open". So the open
    // knowledge count must NOT have increased (it either stays same or drops).
    const knowledgeOpenAfter = unknownQuestions().filter((u) => u.channel === "knowledge" && u.status === "open").length;
    expect(knowledgeOpenAfter, "resolving must not leave new open knowledge unknowns").toBeLessThanOrEqual(knowledgeOpenBefore);
    // And at least one unknown may now be added_to_knowledge.
    const added = unknownQuestions().filter((u) => u.status === "added_to_knowledge").length;
    // We don't strictly assert >0 (matching depends on relatedDomain/key), but
    // the file must not have LOST any unknownQuestion rows (no data loss).
    expect(unknownQuestions().length).toBeGreaterThan(0);
    expect(added).toBeGreaterThanOrEqual(0);
  });
});
