/**
 * golden-pending-settings-draft.ts — PendingSettingsDraft status machine (NEW, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   PendingSettingsDraftService had NO golden test (gap-analysis finding). It
 *   is the "pending review" gate: extracted settings land here as drafts and
 *   NEVER reach the live business profile until an owner approves them. If the
 *   status machine breaks, an extraction could (a) auto-apply without review
 *   (violates the "owner-approved only" rule) or (b) get stuck and never apply.
 *
 * HAND-COMPUTED CONTRACT (anti-cheat):
 *
 *   CASE A — savePendingSettingsDraft FORCES status="pending_review" even if
 *     the caller passes a different status. This is the chokepoint: no caller
 *     can smuggle a draft straight to "saved". Hand-computed:
 *       savePending({ status: "saved" })  → returned.status === "pending_review"
 *       savePending({ status: "discarded" }) → returned.status === "pending_review"
 *       savePending({}) → returned.status === "pending_review"
 *
 *   CASE B — markPendingSettingsDraftSaved flips status → "saved".
 *     save → pending_review → markSaved → "saved". Idempotent within the test.
 *
 *   CASE C — discardPendingSettingsDraft flips status → "discarded".
 *     A discarded draft must not reappear in the pending list.
 *
 *   CASE D — listPendingSettingsDrafts returns ONLY status="pending_review".
 *     Seed 3 drafts: 1 pending, 1 saved, 1 discarded.
 *     listPending → exactly the 1 pending one (not the saved/discarded).
 *     This is the load-bearing assertion: the review queue must show ONLY
 *     things awaiting review, never already-decided drafts.
 *
 * REAL PIPELINE: imports the REAL service functions + the REAL JSON repo. Each
 * case uses a unique timestamped workspace.
 *
 * Run: `npm run golden:pending-settings-draft`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  listPendingSettingsDrafts,
  savePendingSettingsDraft,
  markPendingSettingsDraftSaved,
  discardPendingSettingsDraft,
} from "@/services/PendingSettingsDraftService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_psd_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

// --- CASE A: savePending forces status=pending_review (the chokepoint) ------------
test("CASE A — savePendingSettingsDraft FORCES status=pending_review regardless of input", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  // Caller tries to smuggle "saved".
  const smuggled = await savePendingSettingsDraft(WS, { kind: "structured", status: "saved" }, repos);
  assert.strictEqual(smuggled.status, "pending_review", 'status "saved" in input must be overridden to pending_review');
  // Caller tries to smuggle "discarded".
  const smuggled2 = await savePendingSettingsDraft(WS, { kind: "structured", status: "discarded" }, repos);
  assert.strictEqual(smuggled2.status, "pending_review", 'status "discarded" in input must be overridden to pending_review');
  // No status passed → still pending_review.
  const plain = await savePendingSettingsDraft(WS, { kind: "structured" }, repos);
  assert.strictEqual(plain.status, "pending_review", "no status passed → defaults to pending_review");
});

// --- CASE B: markSaved flips to "saved" ------------------------------------------
test("CASE B — markPendingSettingsDraftSaved flips status → saved", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  const draft = await savePendingSettingsDraft(WS, { kind: "structured" }, repos);
  assert.strictEqual(draft.status, "pending_review", "freshly saved draft is pending_review");
  const saved = await markPendingSettingsDraftSaved(WS, draft.id, repos);
  assert.strictEqual(saved.status, "saved", "after markSaved → status is saved");
});

// --- CASE C: discard flips to "discarded" ----------------------------------------
test("CASE C — discardPendingSettingsDraft flips status → discarded", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  const draft = await savePendingSettingsDraft(WS, { kind: "structured" }, repos);
  const discarded = await discardPendingSettingsDraft(WS, draft.id, repos);
  assert.strictEqual(discarded.status, "discarded", "after discard → status is discarded");
});

// --- CASE D: listPending returns ONLY pending_review (the review queue gate) -----
test("CASE D — listPendingSettingsDrafts returns ONLY status=pending_review drafts", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("D");
  // Seed 3 drafts: pending, saved, discarded.
  const dPending = await savePendingSettingsDraft(WS, { kind: "structured", sourceTitle: "pending one" }, repos);
  const dToSave = await savePendingSettingsDraft(WS, { kind: "structured", sourceTitle: "will save" }, repos);
  const dToDiscard = await savePendingSettingsDraft(WS, { kind: "structured", sourceTitle: "will discard" }, repos);
  await markPendingSettingsDraftSaved(WS, dToSave.id, repos);
  await discardPendingSettingsDraft(WS, dToDiscard.id, repos);

  const pending = await listPendingSettingsDrafts(WS, repos);
  // Hand-computed: exactly 1 (the pending one). The saved + discarded must NOT appear.
  assert.strictEqual(pending.length, 1, "listPending returns exactly the 1 pending draft (not saved/discarded)");
  assert.strictEqual(pending[0].id, dPending.id, "the pending draft is the one we left pending");
  // Explicitly assert the saved/discarded are NOT in the list.
  const ids = pending.map((p) => p.id);
  assert.ok(!ids.includes(dToSave.id), "saved draft is NOT in the pending list");
  assert.ok(!ids.includes(dToDiscard.id), "discarded draft is NOT in the pending list");
  // Every returned row must be pending_review (the invariant, regardless of count).
  for (const p of pending) {
    assert.strictEqual(p.status, "pending_review", "every listPending row is pending_review");
  }
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`pending-settings-draft: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
