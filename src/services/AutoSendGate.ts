/**
 * Stage 4 / 2026-07-20 — Auto-send gate for the daily prospecting loop.
 *
 * Per operator decisions (docs/LOGIC.md 2026-07-20):
 *   - ALL 11 conditions must pass for any single auto-send.
 *   - ANY one failing → lead stays in Review queue unsent. Fail closed.
 *   - Auto-send itself is a per-workspace toggle, default OFF (CASE 12).
 *
 * Pinned by scripts/golden/golden-auto-send-gate.ts (baseline + 12 cases).
 */

export type AutoSendConsentBasis = "inbound" | "consent" | "legitimate_interest" | "none";

export type AutoSendGateInput = {
  /** 1. Workspace kill-switch — owner can stop everything instantly. */
  killSwitchOn: boolean;
  /** 2. Lead passed qualification threshold (fit + confidence). */
  leadQualified: boolean;
  /** 3. Lead is NOT on DNC (and not on the permanent registry, per existing isContactBlocked). */
  leadIsDnc: boolean;
  /** 4. Lead has OutreachConsent with basis != "none" (or documented legitimate-interest). */
  consentBasis: AutoSendConsentBasis;
  /** 5. Country in the campaign's allow-list. */
  country: string;
  countryAllowList: string[];
  /** 6. Current time OUTSIDE quiet hours (default 21:00–09:00 IST). */
  insideQuietHours: boolean;
  /** 7. Workspace daily send cap not yet hit (default 50). */
  workspaceDailyCap: number;
  workspaceSendsToday: number;
  /** 8. Per-campaign daily cap not yet hit. */
  campaignDailyCap: number;
  campaignSendsToday: number;
  /** 9. Workspace has a LIVE WhatsApp/email provider configured + healthy (not mock). */
  liveProviderConfigured: boolean;
  /** 10. First-message safety classifier passed (not abusive, not promising price/delivery). */
  safetyClassifierPassed: boolean;
  /** 11. The message uses an approved Meta template (no free-form cold text). */
  usesApprovedTemplate: boolean;
  /** Per-workspace toggle — auto-send ON/OFF. Default OFF per operator decision. */
  autoSendToggleOn: boolean;
};

export type AutoSendGateResult = {
  allowed: boolean;
  reason?: string;
  /** Which condition number failed (1-11) or 12 (toggle off). Useful for audit/digest. */
  failedCondition?: number;
};

/**
 * Evaluate the 11-condition auto-send gate. Pure function — caller
 * gathers the inputs from the repos + provider state.
 *
 * Order of checks matters for the audit/digest: the most fundamental
 * blocks first (kill-switch, DNC) so the reason field is meaningful.
 */
export function evaluateAutoSendGate(input: AutoSendGateInput): AutoSendGateResult {
  // F-LOGIC-1 (2026-08-04 build-right audit): LOGIC.md "Two separate outreach
  // controls" says the KILL-SWITCH is checked FIRST (if true, the gate fails
  // immediately with reason "kill-switch engaged"), THEN the toggle. The order
  // was reversed (toggle → kill-switch), so the reported `reason` /
  // `failedCondition` didn't match the documented rule. Security outcome is
  // identical (both return allowed:false, fail-closed); only the reported
  // reason differed. Swapped to match LOGIC.
  if (input.killSwitchOn) {
    return { allowed: false, reason: "Workspace kill-switch is ON — all outreach paused.", failedCondition: 1 };
  }
  if (!input.autoSendToggleOn) {
    return { allowed: false, reason: "Auto-send toggle is OFF for this workspace. The owner must opt in.", failedCondition: 12 };
  }
  if (input.leadIsDnc) {
    return { allowed: false, reason: "Lead is on the do-not-contact list. Cannot send.", failedCondition: 3 };
  }
  if (!input.leadQualified) {
    return { allowed: false, reason: "Lead did not pass the qualification threshold.", failedCondition: 2 };
  }
  if (input.consentBasis === "none") {
    return { allowed: false, reason: "Lead has no OutreachConsent on record (basis = none). Cannot auto-send without a lawful basis.", failedCondition: 4 };
  }
  if (!input.countryAllowList.includes(input.country)) {
    return { allowed: false, reason: `Lead country (${input.country}) is not in the campaign's allow-list (${input.countryAllowList.join(", ")}).`, failedCondition: 5 };
  }
  if (input.insideQuietHours) {
    return { allowed: false, reason: "Current time is inside quiet hours (default 21:00–09:00 IST). No sends.", failedCondition: 6 };
  }
  if (input.workspaceSendsToday >= input.workspaceDailyCap) {
    return { allowed: false, reason: `Workspace daily send cap (${input.workspaceDailyCap}) already reached.`, failedCondition: 7 };
  }
  if (input.campaignSendsToday >= input.campaignDailyCap) {
    return { allowed: false, reason: `Campaign daily send cap (${input.campaignDailyCap}) already reached.`, failedCondition: 8 };
  }
  if (!input.liveProviderConfigured) {
    return { allowed: false, reason: "No live WhatsApp/email provider configured (or provider is unhealthy/mock). Cannot send.", failedCondition: 9 };
  }
  if (!input.safetyClassifierPassed) {
    return { allowed: false, reason: "First-message safety classifier FAILED (abusive language, price/delivery promise, or deceptive content detected).", failedCondition: 10 };
  }
  if (!input.usesApprovedTemplate) {
    return { allowed: false, reason: "Message does not use an approved Meta template. Free-form cold text is not allowed for business-initiated messages.", failedCondition: 11 };
  }
  return { allowed: true };
}
