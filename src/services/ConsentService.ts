/**
 * Stage 4 / 2026-07-21 — Outreach consent service.
 *
 * Per docs/LOGIC.md 2026-07-21:
 *   - Default consent basis for new prospects = "none" (safest).
 *   - Workspace owner must explicitly upgrade basis to legitimate_interest
 *     / consent / inbound before any outreach.
 *   - Withdrawn consent blocks all future sends (until re-granted).
 *
 * This module exports PURE functions that construct/transform consent
 * records. The caller (repository / API layer) persists them. Keeping
 * these pure means the safety rules are fully testable without I/O.
 *
 * Also exports the message-safety classifier (basic mode, 4 categories):
 *   - prices (₹, $, Rs, "rs ", currency+number)
 *   - warranty / guarantee
 *   - delivery promises ("delivered in X days", "X-day delivery")
 *   - credit/financial commitments (credit, EMI, refund, contract, terms)
 *
 * Pinned by scripts/golden/golden-consent-safety.ts.
 */
import { NeedsActionError } from "@/lib/user-errors";
import { uid, timestamp } from "@/lib/db";
import type { OutreachConsent, OutreachConsentBasis } from "@/lib/types";

// ---------------------------------------------------------------------------
// Consent record constructors (pure).
// ---------------------------------------------------------------------------

/**
 * Create the default consent record for a newly-discovered prospect.
 * Per the operator rule, basis defaults to "none" — the workspace owner
 * must explicitly upgrade before any outreach happens.
 */
export function createDefaultConsent(input: {
  workspaceId: string;
  leadId: string;
  sourceChannel: string;
}): OutreachConsent {
  const now = timestamp();
  return {
    id: uid("consent"),
    workspaceId: input.workspaceId,
    leadId: input.leadId,
    basis: "none",
    sourceChannel: input.sourceChannel,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Upgrade a consent record's lawful basis. Records who decided, why
 * (evidence), and when. Returns a new record — does NOT mutate input.
 *
 * Throws if the new basis is invalid or the same as the current basis
 * with no new evidence (no-op upgrade is suspicious).
 */
export function upgradeConsentBasis(
  current: OutreachConsent,
  input: {
    basis: Exclude<OutreachConsentBasis, "none">;
    evidence: string;
    classifierVersion?: string;
  },
): OutreachConsent {
  if (!["inbound", "consent", "legitimate_interest"].includes(input.basis)) {
    throw new NeedsActionError(`Invalid consent basis "${input.basis}". Use withdrawConsent to revoke.`, 400);
  }
  if (!input.evidence || input.evidence.trim().length === 0) {
    throw new Error(`Cannot upgrade consent basis without evidence. Document how the basis was established.`);
  }
  return {
    ...current,
    basis: input.basis,
    evidence: input.evidence,
    classifierVersion: input.classifierVersion,
    grantedAt: timestamp(),
    withdrawnAt: undefined, // re-grant clears any prior withdrawal
    updatedAt: timestamp(),
  };
}

/**
 * Withdraw consent. Sets withdrawnAt; the record is no longer active for
 * sending. The basis field is preserved for audit ("they used to have
 * legitimate_interest, then withdrew on date X").
 */
export function withdrawConsent(
  current: OutreachConsent,
  input: { reason?: string },
): OutreachConsent {
  return {
    ...current,
    withdrawnAt: timestamp(),
    // Stash the reason in evidence for audit (append, don't overwrite).
    evidence: current.evidence
      ? `${current.evidence} | WITHDRAWN: ${input.reason || "no reason given"}`
      : `WITHDRAWN: ${input.reason || "no reason given"}`,
    updatedAt: timestamp(),
  };
}

/**
 * Is this consent record currently active (i.e. may the system send)?
 * Active = basis is not "none" AND withdrawnAt is unset.
 *
 * This is the single chokepoint every sender must call.
 */
export function isConsentActive(consent: OutreachConsent | undefined | null): boolean {
  if (!consent) return false;
  if (consent.basis === "none") return false;
  if (consent.withdrawnAt) return false;
  return Boolean(consent.grantedAt);
}

// ---------------------------------------------------------------------------
// Message safety classifier (basic mode — 4 categories).
// ---------------------------------------------------------------------------

export type SafetyCategory = "price" | "warranty" | "delivery_promise" | "credit_financial";

export type SafetyViolation = {
  category: SafetyCategory;
  /** The substring that triggered the violation, for the UI to highlight. */
  matched: string;
};

export type SafetyClassification = {
  passed: boolean;
  reasons: SafetyViolation[];
};

// Pattern library. Lowercased match against the message.
// Each entry: [category, regex]. The regex is anchored to be specific
// enough to avoid false positives but broad enough to catch variants.
const PATTERNS: ReadonlyArray<readonly [SafetyCategory, RegExp]> = [
  // Prices: currency symbol + number, OR currency word + number.
  // Matches: ₹450, $10, Rs 500, Rs. 450/kg, INR 1000, "rs 200", "price is 450".
  ["price", /(?:₹|rs\.?\s*|inr\s*|\$)\s*\d+/i],
  ["price", /\bprice\s+(?:is\s+)?(?:rs\.?\s*|₹|inr\s*)?\d+/i],
  ["price", /\b\d+\s*(?:per\s+)?(?:kg|piece|metre|meter|box|unit|lot|yard)\b/i],

  // Warranty / guarantee.
  ["warranty", /\b(?:warranty|guarantee|guaranteed)\b/i],

  // Delivery promises: "delivered in X days", "X-day delivery", "delivery within".
  ["delivery_promise", /\b(?:delivered|delivery|deliver)\s+(?:in|within|inside)\s+\d+/i],
  ["delivery_promise", /\b\d+\s*[-]?\s*day\s*delivery\b/i],
  ["delivery_promise", /\bdelivery\s+(?:in|within)\s+\d+/i],

  // Credit / financial commitments.
  ["credit_financial", /\b(?:credit|emi|refund|contract|legal\s+terms|payment\s+terms)\b/i],
];

/**
 * Classify a drafted first-outreach message for safety. Pure function.
 *
 * Returns { passed, reasons }. `passed=false` if ANY of the 4 dangerous
 * categories is present. Multiple violations all surface in `reasons`
 * so the operator sees everything wrong at once.
 */
export function classifyMessageSafety(message: string): SafetyClassification {
  const reasons: SafetyViolation[] = [];
  for (const [category, pattern] of PATTERNS) {
    const match = message.match(pattern);
    if (match) {
      // Avoid duplicate entries for the same category in one message.
      if (!reasons.some((r) => r.category === category)) {
        reasons.push({ category, matched: match[0] });
      }
    }
  }
  return {
    passed: reasons.length === 0,
    reasons,
  };
}
