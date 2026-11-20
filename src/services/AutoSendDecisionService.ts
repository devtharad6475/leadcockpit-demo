/**
 * Stage 4 / 2026-07-21 (R3) — Auto-send decision service.
 *
 * THE single chokepoint that gathers all 11 AutoSendGate inputs from real
 * data + drafts the message + runs the safety classifier + calls the gate.
 *
 * Per docs/LOGIC.md:
 *   - Auto-send is OFF by default. Both the workspace kill-switch AND the
 *     per-workspace auto-send toggle must be in the right state.
 *   - Even when the gate says "allowed", this service returns the decision;
 *     it does NOT itself perform the WhatsApp send. The caller (a future
 *     send step) does the actual send, after this service says allowed.
 *   - The default consent basis is "none" (operator decision Q11). The
 *     gate fails closed unless consent is upgraded.
 *
 * Pure-ish: takes a repos bundle + lead + campaign + draft message, returns
 * a decision. No mutations. The caller persists any "blocked" reason into
 * the audit log if it wants visibility.
 *
 * Pinned indirectly by golden:auto-send-gate (which tests the gate itself)
 * + golden:consent-safety (which tests the classifier).
 */
import { evaluateAutoSendGate, type AutoSendGateInput, type AutoSendGateResult } from "@/services/AutoSendGate";
import { classifyMessageSafety } from "@/services/ConsentService";
import type { Lead, Workspace } from "@/lib/types";
import { todayIstIsoDate } from "@/lib/time";
import type { RepositoryBundle } from "@/repositories/interfaces";

export type AutoSendDecisionInput = {
  workspace: Workspace;
  lead: Lead;
  /** The drafted first-outreach message body to safety-check. */
  draftMessage: string;
  /** The campaign's country allow-list + caps. */
  countryAllowList: string[];
  campaignDailyCap: number;
  campaignSendsToday: number;
  /** Has the workspace configured a live WhatsApp provider (not mock)? */
  liveProviderConfigured: boolean;
  /** Does the drafted message use an approved Meta template? */
  usesApprovedTemplate: boolean;
};

export type AutoSendDecisionResult = AutoSendGateResult & {
  /** The classifier result (passed/failed + reasons). Surfaced for audit. */
  safetyClassification: { passed: boolean; reasons: Array<{ category: string; matched: string }> };
};

/**
 * Gather all 11 inputs from real data + make the auto-send decision.
 *
 * Reads from repos:
 *   - workspace.autonomyKillSwitch + autoSendToggle
 *   - lead.consentStatus (default "none")
 *   - lead.doNotContact / DNC registry
 *   - workspace send-count-today (via audit log)
 *
 * Computes:
 *   - leadQualified = lead.reviewStatus === "approved" && lead.confidenceScore >= 0.85
 *     (0.85 = strict bar per docs/LOGIC.md 2026-07-21 Batch 5 Q1. The
 *     0.7 here previously was an unconfirmed assumption; the operator
 *     chose 0.85 to keep most leads in manual review at L1.)
 *   - safetyClassifierPassed = classifyMessageSafety(draftMessage).passed
 *   - insideQuietHours = based on IST 21:00–09:00 (the LOGIC.md default)
 */
export async function decideAutoSend(
  input: AutoSendDecisionInput,
  repos: RepositoryBundle,
): Promise<AutoSendDecisionResult> {
  const { workspace, lead, draftMessage } = input;

  // 1. Kill-switch + toggle.
  const killSwitchOn = Boolean(workspace.autonomyKillSwitch);
  const autoSendToggleOn = Boolean(workspace.autoSendToggle);

  // 2. Lead qualified (fit + confidence). 0.85 = strict bar per
  //    docs/LOGIC.md 2026-07-21 Batch 5 Q1. A 0.78 lead does NOT auto-send.
  const leadQualified = lead.reviewStatus === "approved" && (lead.confidenceScore ?? 0) >= 0.85;

  // 3. DNC.
  const leadIsDnc = lead.doNotContact || lead.status === "do_not_contact";

  // 4. Consent basis. Default "none" per operator decision Q11.
  //    Stored on lead.consentStatus (added by the Compliance screen).
  const consentBasis = ((lead as { consentStatus?: string }).consentStatus || "none") as AutoSendGateInput["consentBasis"];

  // 5. Country allow-list.
  const country = lead.country || "IN";

  // 6. Quiet hours: 21:00–09:00 IST. IST = UTC + 5:30.
  //    21:00 IST = 15:30 UTC; 09:00 IST = 03:30 UTC.
  //    So quiet hours in UTC are 15:30–23:59 + 00:00–03:30.
  const nowUtcMinutes = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const startUtc = 15 * 60 + 30; // 15:30 UTC
  const endUtc = 3 * 60 + 30;    // 03:30 UTC
  const insideQuietHours = nowUtcMinutes >= startUtc || nowUtcMinutes < endUtc;

  // 7. Workspace daily send cap (default 50 per LOGIC.md) + sends today.
  //    Count today's auto_send_succeeded audit events. Event name per
  //    docs/LOGIC.md 2026-07-21 Batch 5 Q3.
  const workspaceDailyCap = 50;
  // S6 D-7: was UTC date (toISOString().slice) — 5.5h off IST. A send at
  // 19:00 UTC (= 00:30 IST next day) was counted against the wrong IST day,
  // letting ~50 extra sends slip in the 18:30–24:00 IST window. Now IST date.
  const todayIso = todayIstIsoDate();
  const audit = await repos.auditLog.listByWorkspace(workspace.id);
  const workspaceSendsToday = audit.filter(
    (e) => e.eventType === "auto_send_succeeded" && e.createdAt.startsWith(todayIso),
  ).length;

  // 8. Campaign daily cap (passed in).
  // 9. Live provider (passed in).
  // 10. Safety classifier — the real classification.
  const safety = classifyMessageSafety(draftMessage);
  // 11. Approved template (passed in).

  const gateResult = evaluateAutoSendGate({
    killSwitchOn,
    leadQualified,
    leadIsDnc,
    consentBasis,
    country,
    countryAllowList: input.countryAllowList,
    insideQuietHours,
    workspaceDailyCap,
    workspaceSendsToday,
    campaignDailyCap: input.campaignDailyCap,
    campaignSendsToday: input.campaignSendsToday,
    liveProviderConfigured: input.liveProviderConfigured,
    safetyClassifierPassed: safety.passed,
    usesApprovedTemplate: input.usesApprovedTemplate,
    autoSendToggleOn,
  });

  return {
    ...gateResult,
    safetyClassification: safety,
  };
}
