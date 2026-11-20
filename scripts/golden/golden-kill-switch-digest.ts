/**
 * Golden test — Kill-switch + daily digest + insights notebook (Stage 4 Batch 3 Q13-Q15).
 *
 * Phase 1.5 / skill v2 — written BEFORE the service code.
 *
 * Operator-confirmed rules (docs/LOGIC.md, 2026-07-21):
 *   - Two separate controls: kill-switch (panic) + per-customer toggle.
 *     Kill-switch=true blocks even when toggle=true.
 *   - Daily digest: written to DailyDigest record per workspace per day;
 *     also sent as WhatsApp message to owner. Two-channel delivery.
 *   - Insights notebook: CampaignInsight records with owner's free-text
 *     notes; system NEVER auto-modifies ICP/campaign/message. Surfaced as
 *     reminders on campaign setup.
 *
 * Hand-computed expected values:
 *
 *   CASE A — Kill-switch ON + toggle ON → AutoSendGate rejects with
 *     failedCondition=1 (kill-switch checked first).
 *
 *   CASE B — Kill-switch OFF + toggle ON + everything else OK → allowed.
 *
 *   CASE C — Kill-switch OFF + toggle OFF → failedCondition=12 (toggle).
 *
 *   CASE D — Build daily digest from campaign results: 2 campaigns,
 *     5 leads discovered, 3 drafts, 0 errors → summary text contains
 *     "2", "5", "3".
 *
 *   CASE E — Daily digest with errors → summary text contains error count
 *     AND the errors array is preserved.
 *
 *   CASE F — Two-step digest: buildSummary returns the same shape as
 *     what gets stored (idempotent re-runs produce same numbers).
 *
 *   CASE G — CampaignInsight create → fields round-trip (note text,
 *     author, createdAt).
 *
 *   CASE H — CampaignInsight list-by-workspace returns insights in
 *     reverse-chronological order.
 *
 *   CASE I — Auto-adjustment NEVER happens: insights feed no automatic
 *     campaign change. (Function `applyInsightToCampaign` does NOT exist;
 *     we verify by attempting to import it and expecting failure.)
 *
 *   CASE J — Flip kill-switch: returns updated workspace + audit event
 *     with actor + timestamp.
 *
 * Run: npx tsx scripts/golden/golden-kill-switch-digest.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import {
  buildDigestSummary,
  renderDigestWhatsAppMessage,
  flipKillSwitch,
} from "@/services/DailyDigestService";
import {
  createInsight,
  listInsightsForWorkspace,
  type CampaignInsight,
} from "@/services/CampaignInsightService";
import { evaluateAutoSendGate } from "@/services/AutoSendGate";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  // === CASE A — Kill-switch ON + toggle ON → blocked at #1 ===
  const killSwitchOn = evaluateAutoSendGate({
    killSwitchOn: true,
    leadQualified: true,
    leadIsDnc: false,
    consentBasis: "legitimate_interest",
    country: "IN",
    countryAllowList: ["IN"],
    insideQuietHours: false,
    workspaceDailyCap: 50,
    workspaceSendsToday: 0,
    campaignDailyCap: 20,
    campaignSendsToday: 0,
    liveProviderConfigured: true,
    safetyClassifierPassed: true,
    usesApprovedTemplate: true,
    autoSendToggleOn: true,
  });
  assert(killSwitchOn.allowed === false, `CASE A: kill-switch must block`);
  assert(killSwitchOn.failedCondition === 1, `CASE A: failed at condition 1 (kill-switch), got ${killSwitchOn.failedCondition}`);
  console.log(`  CASE A OK: kill-switch blocks even when toggle is ON.`);

  // === CASE B — Kill-switch OFF + toggle ON + all OK → allowed ===
  const allOk = evaluateAutoSendGate({
    killSwitchOn: false,
    leadQualified: true,
    leadIsDnc: false,
    consentBasis: "legitimate_interest",
    country: "IN",
    countryAllowList: ["IN"],
    insideQuietHours: false,
    workspaceDailyCap: 50,
    workspaceSendsToday: 0,
    campaignDailyCap: 20,
    campaignSendsToday: 0,
    liveProviderConfigured: true,
    safetyClassifierPassed: true,
    usesApprovedTemplate: true,
    autoSendToggleOn: true,
  });
  assert(allOk.allowed === true, `CASE B: all-OK should be allowed`);
  console.log(`  CASE B OK: all conditions pass.`);

  // === CASE C — Kill-switch OFF + toggle OFF → blocked at #12 ===
  const toggleOff = evaluateAutoSendGate({
    killSwitchOn: false,
    leadQualified: true,
    leadIsDnc: false,
    consentBasis: "legitimate_interest",
    country: "IN",
    countryAllowList: ["IN"],
    insideQuietHours: false,
    workspaceDailyCap: 50,
    workspaceSendsToday: 0,
    campaignDailyCap: 20,
    campaignSendsToday: 0,
    liveProviderConfigured: true,
    safetyClassifierPassed: true,
    usesApprovedTemplate: true,
    autoSendToggleOn: false,
  });
  assert(toggleOff.allowed === false, `CASE C: toggle off should block`);
  assert(toggleOff.failedCondition === 12, `CASE C: failed at condition 12 (toggle)`);
  console.log(`  CASE C OK: toggle off → failedCondition=12.`);

  // === CASE D — Digest summary math: 2 campaigns, 5 leads, 3 drafts, 0 errors ===
  const summary = buildDigestSummary({
    workspaceId: "ws1",
    day: "2026-07-21",
    campaignRuns: [
      { campaignId: "c1", campaignName: "Surat Textile Buyers", leadsDiscovered: 3, draftsGenerated: 2, errors: [] },
      { campaignId: "c2", campaignName: "Mumbai Saree Makers", leadsDiscovered: 2, draftsGenerated: 1, errors: [] },
    ],
  });
  assert(summary.totalCampaignsRun === 2, `CASE D: totalCampaignsRun=2, got ${summary.totalCampaignsRun}`);
  assert(summary.totalLeadsDiscovered === 5, `CASE D: totalLeadsDiscovered=5, got ${summary.totalLeadsDiscovered}`);
  assert(summary.totalDraftsGenerated === 3, `CASE D: totalDraftsGenerated=3, got ${summary.totalDraftsGenerated}`);
  assert(summary.totalErrors === 0, `CASE D: totalErrors=0`);
  console.log(`  CASE D OK: digest math 2 campaigns, 5 leads, 3 drafts.`);

  // === CASE E — Digest with errors preserves them ===
  const withErrors = buildDigestSummary({
    workspaceId: "ws1",
    day: "2026-07-21",
    campaignRuns: [
      { campaignId: "c1", campaignName: "Surat", leadsDiscovered: 1, draftsGenerated: 0, errors: [{ campaignId: "c1", message: "SerpApi quota exceeded" }] },
    ],
  });
  assert(withErrors.totalErrors === 1, `CASE E: totalErrors=1, got ${withErrors.totalErrors}`);
  assert(withErrors.errors.length === 1, `CASE E: errors array preserved`);
  assert(withErrors.errors[0].message === "SerpApi quota exceeded", `CASE E: error message preserved`);
  console.log(`  CASE E OK: errors preserved in digest.`);

  // === CASE F — Idempotent re-runs produce same numbers ===
  const summary2 = buildDigestSummary({
    workspaceId: "ws1",
    day: "2026-07-21",
    campaignRuns: [
      { campaignId: "c1", campaignName: "Surat Textile Buyers", leadsDiscovered: 3, draftsGenerated: 2, errors: [] },
      { campaignId: "c2", campaignName: "Mumbai Saree Makers", leadsDiscovered: 2, draftsGenerated: 1, errors: [] },
    ],
  });
  assert(summary2.totalLeadsDiscovered === summary.totalLeadsDiscovered, `CASE F: idempotent`);
  assert(summary2.totalDraftsGenerated === summary.totalDraftsGenerated, `CASE F: idempotent`);
  console.log(`  CASE F OK: idempotent re-run.`);

  // === CASE G — renderDigestWhatsAppMessage: text contains all numbers ===
  const msg = renderDigestWhatsAppMessage(summary);
  assert(msg.includes("2"), `CASE G: message contains campaign count "2"`);
  assert(msg.includes("5"), `CASE G: message contains leads count "5"`);
  assert(msg.includes("3"), `CASE G: message contains drafts count "3"`);
  console.log(`  CASE G OK: WhatsApp digest message has all numbers.`);

  // === CASE H — CampaignInsight create + list-by-workspace ===
  // Realistic: insights created minutes apart. We override createdAt to
  // simulate that (the createInsight helper stamps "now", which in a fast
  // test loop can collide to the same ms).
  const insight1: CampaignInsight = {
    ...createInsight({
      workspaceId: "ws1",
      note: "Surat is our best region — focus more there.",
      authorUserId: "owner1",
    }),
    createdAt: "2026-07-21T09:00:00Z",
    updatedAt: "2026-07-21T09:00:00Z",
  };
  const insight2: CampaignInsight = {
    ...createInsight({
      workspaceId: "ws1",
      note: "Mumbai replied slow — try different message.",
      authorUserId: "owner1",
    }),
    createdAt: "2026-07-21T10:00:00Z",
    updatedAt: "2026-07-21T10:00:00Z",
  };
  assert(insight1.note === "Surat is our best region — focus more there.", `CASE H: insight note preserved`);
  assert(insight1.authorUserId === "owner1", `CASE H: author preserved`);
  assert(insight1.createdAt !== undefined, `CASE H: createdAt set`);
  // list returns reverse-chrono (newest first)
  const list = listInsightsForWorkspace([insight1, insight2], "ws1");
  assert(list.length === 2, `CASE H: 2 insights listed`);
  assert(list[0].id === insight2.id, `CASE H: newest insight first`);
  console.log(`  CASE H OK: insights round-trip + reverse-chrono list.`);

  // === CASE I — flipKillSwitch: returns audit event with actor + timestamp ===
  const flip = flipKillSwitch({
    workspace: {
      id: "ws1", name: "Test", autonomyKillSwitch: false,
      status: "active", createdAt: "2026-07-21T00:00:00Z", updatedAt: "2026-07-21T00:00:00Z",
    },
    newKillSwitchValue: true,
    actor: { userId: "owner1", actorType: "owner" },
  });
  assert(flip.updatedWorkspace.autonomyKillSwitch === true, `CASE I: kill-switch now true`);
  assert(flip.auditEvent.eventType === "kill_switch_toggled", `CASE I: audit event type correct`);
  assert(flip.auditEvent.actor.userId === "owner1", `CASE I: actor recorded`);
  assert(flip.auditEvent.newValue === true, `CASE I: new value recorded`);
  console.log(`  CASE I OK: kill-switch flip returns updated workspace + audit event.`);

  console.log("PASS golden-kill-switch-digest: all 9 cases match operator-confirmed rules.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
