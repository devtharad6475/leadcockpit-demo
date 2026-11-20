/**
 * enrichment-label.ts — what the lead list says about reaching a lead.
 *
 * ── THE DEFECT THIS EXISTS FOR (2026-09-08) ─────────────────────────────────
 * Found on the live pipeline. Five leads, identical contact data (a phone and
 * an email each). The ONE that had actually been enriched — the one with an
 * approved outreach draft waiting to go out — read "Contact missing". The four
 * that had never been enriched read "Contact found".
 *
 * The cause was one badge answering two different questions. `no_results` means
 * "the enrichment lookup could not confirm which company this is". It says
 * nothing about the phone number already sitting on the record. Rendering it as
 * "Contact missing" tells the operator to give up on the only lead that is
 * ready to contact, and to re-run an enrichment that will fail again.
 *
 * So the decision lives here, in one place, as a plain function — not because
 * page.tsx could not hold an if-statement, but because a claim this easy to get
 * backwards should be pinned by a test that reads like the screen does. See
 * golden-enrichment-contact-label.ts.
 */

/** The result of the enrichment lookup, when one has run. */
export type EnrichmentLookupStatus = "matched" | "ambiguous" | "no_results" | "failed" | undefined;

export type EnrichmentLabelInput = {
  /** `lead.enrichmentResult?.status` */
  result?: EnrichmentLookupStatus;
  /** `lead.enrichmentStatus` — the job state, not the lookup outcome. */
  jobStatus?: string;
  /** True when ANY channel is on file: email, phone or WhatsApp number. */
  contactReady: boolean;
};

/**
 * `compact` is the lead-table cell (a few characters wide); the long form is
 * the drawer, which has room to name the lookup outcome itself.
 */
export function enrichmentLabel(input: EnrichmentLabelInput, compact = false): string {
  const { result, jobStatus, contactReady } = input;

  if (result === "matched") {
    return compact ? (contactReady ? "Contact found" : "Matched, contact missing") : "Enriched: matched";
  }
  if (result === "ambiguous") {
    return compact ? "Verify contact" : "Multiple companies found";
  }
  if (result === "no_results") {
    // Contact details on file outrank a failed lookup. The lead IS reachable —
    // we just could not confirm the company — and saying which of the two it is
    // stops the operator re-running a lookup that already failed.
    return compact ? (contactReady ? "Contact unverified" : "Contact missing") : "No reliable match";
  }
  if (result === "failed") {
    return "Enrichment failed";
  }
  if (jobStatus === "running" || jobStatus === "pending") {
    return "Enriching";
  }
  return contactReady
    ? (compact ? "Contact found" : "Contact available")
    : (compact ? "Contact missing" : "Needs contact details");
}
