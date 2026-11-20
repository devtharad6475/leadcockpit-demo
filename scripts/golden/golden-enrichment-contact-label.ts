/**
 * golden-enrichment-contact-label.ts — N-BUG pin (2026-09-08).
 *
 * THE DEFECT THIS PINS
 * --------------------
 * Walking the live pipeline screen: five leads, every one of them holding a
 * phone number and an email address. The ONE that had actually been enriched —
 * the one at "Message ready" with an approved outreach draft waiting — read
 *
 *     Contact missing
 *
 * while the four that had never been enriched read "Contact found" off
 * identical data.
 *
 * One badge was answering two different questions. `no_results` means the
 * enrichment lookup could not confirm which company this is; it says nothing
 * about the phone number already on the record. Rendered as "Contact missing"
 * it tells the operator to give up on the only lead that is ready to contact,
 * and to re-run a lookup that already failed.
 *
 * HAND-COMPUTED CONTRACT:
 *
 *   CASE A — the exact live row. Enrichment found no company, contact details
 *   are on file: the badge must not claim the contact is missing.
 *
 *   CASE B — and it must still say "Contact missing" when it genuinely is.
 *   A fix that simply stopped ever saying it would be worse than the bug.
 *
 *   CASE C — one channel is enough. Email alone, phone alone, or a WhatsApp
 *   number alone all mean the lead is reachable.
 *
 *   CASE D — the branches that were already right stay right. This is a
 *   correction to one branch, not a rewrite of the badge.
 *
 *   CASE E — the long form names the LOOKUP outcome, because the drawer has
 *   room to and the operator needs to know which of the two things happened.
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { enrichmentLabel } from "@/lib/enrichment-label";

type Case = { name: string; fn: () => void };
const cases: Case[] = [];
function test(name: string, fn: () => void) { cases.push({ name, fn }); }

const compact = (input: Parameters<typeof enrichmentLabel>[0]) => enrichmentLabel(input, true);
const full = (input: Parameters<typeof enrichmentLabel>[0]) => enrichmentLabel(input, false);

test("CASE A — the live row: no company match, but we can still reach them", () => {
  const label = compact({ result: "no_results", jobStatus: "completed", contactReady: true });
  assert.notStrictEqual(label, "Contact missing",
    "this lead has a phone number and an email and an approved draft waiting — the screen told the operator to give up on it");
  assert.strictEqual(label, "Contact unverified",
    "it must still be clear the LOOKUP failed, or the operator re-runs an enrichment that cannot succeed");
});

test("CASE B — it still says Contact missing when the contact really is missing", () => {
  assert.strictEqual(compact({ result: "no_results", contactReady: false }), "Contact missing",
    "a fix that never says 'Contact missing' hides the leads that genuinely cannot be reached");
  assert.strictEqual(compact({ result: undefined, contactReady: false }), "Contact missing");
});

test("CASE C — any one channel means reachable", () => {
  // The screen reads one boolean; these are the three ways it becomes true.
  const channels = [
    { email: "sales@example.com", phone: undefined, whatsappNumber: undefined },
    { email: undefined, phone: "+1 555 0110", whatsappNumber: undefined },
    { email: undefined, phone: undefined, whatsappNumber: "+1 555 0110" },
  ];
  const wrong = channels
    .map((lead) => ({
      lead,
      label: compact({ result: "no_results", contactReady: Boolean(lead.email || lead.phone || lead.whatsappNumber) }),
    }))
    .filter((row) => row.label === "Contact missing");
  assert.deepStrictEqual(wrong, [], "one usable channel is enough to contact someone");
});

test("CASE D — the branches that were already right are untouched", () => {
  assert.strictEqual(compact({ result: "matched", contactReady: true }), "Contact found");
  assert.strictEqual(compact({ result: "matched", contactReady: false }), "Matched, contact missing");
  assert.strictEqual(compact({ result: "ambiguous", contactReady: true }), "Verify contact");
  assert.strictEqual(compact({ result: "failed", contactReady: true }), "Enrichment failed");
  assert.strictEqual(compact({ jobStatus: "running", contactReady: true }), "Enriching");
  assert.strictEqual(compact({ jobStatus: "pending", contactReady: false }), "Enriching");
  assert.strictEqual(compact({ contactReady: true }), "Contact found");
});

test("CASE E — the long form names the lookup outcome", () => {
  assert.strictEqual(full({ result: "matched", contactReady: true }), "Enriched: matched");
  assert.strictEqual(full({ result: "ambiguous", contactReady: true }), "Multiple companies found");
  assert.strictEqual(full({ result: "no_results", contactReady: true }), "No reliable match",
    "the drawer has room to say what actually happened, and this wording was already correct");
  assert.strictEqual(full({ contactReady: true }), "Contact available");
  assert.strictEqual(full({ contactReady: false }), "Needs contact details");
});

// --- RUNNER ---------------------------------------------------------------------
(() => {
  console.log("golden-enrichment-contact-label — N-BUG (a reachable lead must not read 'Contact missing')\n");
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`enrichment-contact-label: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
