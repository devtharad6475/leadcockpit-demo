/**
 * Stage 5 / 2026-07-21 — Production-readiness gate additions.
 *
 * Per docs/LOGIC.md 2026-07-21:
 *   - Two new hard blockers (existing blockers unchanged):
 *     (a) at least one real LLM provider key configured (not all mock);
 *     (b) at least one real, verified WhatsApp number (not the test
 *         number).
 *   - Backup is NOT a gate (managed Postgres handles it per Q17).
 *
 * These pure helpers exist so the check-production-readiness script and
 * any other caller can use the same logic. The actual script wires them
 * into its `checks[]` array.
 *
 * Pinned by scripts/golden/golden-erasure-audit.ts (CASES H/I/J).
 */

/**
 * Returns true iff at least one real LLM provider key is configured.
 * "Real" means: not the placeholder string, not all-slots-on-mock.
 */
export function checkLlmKeyConfigured(input: { hasRealKey: boolean }): boolean {
  return input.hasRealKey === true;
}

/**
 * Returns true iff the workspace has a real, verified WhatsApp Business
 * number (not the Meta test number).
 */
export function checkWhatsAppNumberVerified(input: {
  isTestNumber: boolean;
  isVerified: boolean;
}): boolean {
  // Test numbers can be "verified" by Meta but are rate-limited and only
  // work with pre-approved test recipients — not suitable for production
  // customer outreach. Require BOTH: not test + verified.
  return !input.isTestNumber && input.isVerified;
}
