/**
 * golden-lead-review-bar-is-a-fraction.ts — pin (2026-09-25).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * The Lead Review "auto-approve threshold" is a fraction (0.85 = 85% sure) but
 * nothing checked what was saved. The local demo workspace was found with the
 * bar saved as 80 — a bar of 8000% that no lead can ever clear — so automatic
 * approval had silently stopped, with no error anywhere. The screen now edits
 * a percentage and converts it; the server refuses anything out of range.
 *
 * HAND-COMPUTED CONTRACT
 *   CASE A — 80 (a percentage typed into a fraction box) is refused, and the
 *            stored settings are unchanged.
 *   CASE B — 0.85 and 1 and 0.5 are accepted and stored as given.
 *   CASE C — below 0.5 (0.3) is refused: that would approve leads the AI is
 *            less sure of than a coin toss.
 *   CASE D — daily limit must be a whole number 0..500 (-1, 2.5, 501 refused).
 *   CASE E — an update that does not touch the bar (mode only) still works.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import { getLeadReviewSettings, updateLeadReviewSettings } from "@/services/LeadReviewDecisionService";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

const repos = createJsonRepos();
let seq = 0;
async function workspace() {
  const workspaceId = `ws_review_bar_${Date.now()}_${seq++}`;
  await repos.workspace.create({ id: workspaceId, name: "Review bar golden", status: "active" });
  return workspaceId;
}
async function refused(p: Promise<unknown>) {
  try { await p; } catch (e) { return (e as Error).message; }
  throw new Error("expected the update to be refused, but it was saved");
}

test("CASE A — 80 (a percentage) is refused and nothing changes", async () => {
  const ws = await workspace();
  await updateLeadReviewSettings(ws, { autoApproveThreshold: 0.9 }, repos);
  const message = await refused(updateLeadReviewSettings(ws, { autoApproveThreshold: 80 }, repos));
  assert.ok(/cannot/.test(message), `message must be a 400-class "cannot" message, got: ${message}`);
  const after = await getLeadReviewSettings(ws, repos);
  assert.equal(after.autoApproveThreshold, 0.9);
});

test("CASE B — 0.85, 1 and 0.5 are stored as given", async () => {
  const ws = await workspace();
  for (const t of [0.85, 1, 0.5]) {
    const saved = await updateLeadReviewSettings(ws, { autoApproveThreshold: t }, repos);
    assert.equal(saved.autoApproveThreshold, t);
  }
});

test("CASE C — below 50% is refused", async () => {
  const ws = await workspace();
  await refused(updateLeadReviewSettings(ws, { autoApproveThreshold: 0.3 }, repos));
});

test("CASE D — daily limit must be a whole number from 0 to 500", async () => {
  const ws = await workspace();
  for (const n of [-1, 2.5, 501]) await refused(updateLeadReviewSettings(ws, { maxAutoApprovedPerDay: n }, repos));
  const saved = await updateLeadReviewSettings(ws, { maxAutoApprovedPerDay: 0 }, repos);
  assert.equal(saved.maxAutoApprovedPerDay, 0);
});

test("CASE E — a mode-only update still works", async () => {
  const ws = await workspace();
  const saved = await updateLeadReviewSettings(ws, { mode: "high_confidence_auto_approval" }, repos);
  assert.equal(saved.mode, "high_confidence_auto_approval");
  assert.equal(saved.allowAutoSend, false);
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  console.log("golden-lead-review-bar-is-a-fraction — the auto-approve bar can only be saved as a valid fraction\n");
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
  console.log(`lead-review-bar-is-a-fraction: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
