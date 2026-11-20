/**
 * Golden test — a customer who asks to be left alone stays left alone,
 * including in the list the operator reads.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found on the live demo. A lead sent:
 *
 *   "STOP. Do not message me again. Remove my number from your list. I do not
 *    want any more WhatsApp from you people."
 *
 * The engine handled it exactly right: category `unsubscribe`, reason
 * "Customer requested opt-out. Mark do_not_contact and stop automation.",
 * `doNotContact: true`, `status: "do_not_contact"`, and a two-line reply that
 * promised nothing.
 *
 * One message later — a price question sent to the same lead — the engine
 * again did the right thing at the gate ("Lead is marked do not contact", no
 * model call, draft held). And the lead came back from the API as:
 *
 *   status: "hot_lead"
 *
 * `nextStatus` protects mql, sql, hot_lead, opportunity and won from being
 * demoted by a later suggestion. do_not_contact was not in that list, which
 * made it the ONE status any later inbound message could overwrite — the exact
 * opposite of the guarantee it exists to give.
 *
 * The `doNotContact` flag survived, so nothing was sent and the automation gate
 * held. This is not a "messages went out" defect. It is worse in a quieter way:
 * `status` is what a human reads in the leads list, so the product spent one
 * message moving a customer who had just said STOP into the pile the operator
 * is told to go and chase.
 *
 *   CASE A — an opted-out lead is not moved by any later suggestion, including
 *     the promoting ones that are allowed to override a protected status.
 *
 *   CASE B — it is not moved by the absence of a suggestion either.
 *
 *   CASE C — arriving AT do_not_contact still works from anywhere. Making it
 *     terminal must not make it unreachable.
 *
 *   CASE D — every other status still behaves as it did. This fix is one early
 *     return; the promotion and demotion rules around it are not in scope and
 *     must not move.
 *
 * Substrate: the engine's own `nextStatus`, exercised directly. No repository,
 * no network, no AI.
 */
import "./_helpers/isolate-standalone";
import type { LeadStatus } from "@/lib/types";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const ENGINE = "src/services/WhatsAppConversationEngine.ts";

/**
 * `nextStatus` is module-private, which is right — it is one rule belonging to
 * one engine. Rather than widening its visibility for a test, this evaluates
 * the real function's source, so a rewrite that drops the guard fails here.
 */
function loadNextStatus(): (suggestion: LeadStatus | undefined, current: LeadStatus | undefined) => LeadStatus | undefined {
  const engine = readSource(ENGINE);
  const start = engine.indexOf("function nextStatus(");
  assert(start > 0, `setup: ${ENGINE} no longer defines nextStatus`);
  const end = engine.indexOf("\n}", start);
  assert(end > start, `setup: could not find the end of nextStatus in ${ENGINE}`);
  const body = engine
    .slice(start, end + 2)
    .replace(/: LeadStatus \| undefined/g, "")
    .replace(/: LeadStatus\[\]/g, "");
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return nextStatus;`)();
}

function main() {
  console.log("=== GOLDEN: an opt-out is not undone by the next message ===\n");

  const nextStatus = loadNextStatus();

  // ---------------------------------------------------------------- CASE A
  {
    // The three statuses nextStatus lets through even against a protected
    // current value — i.e. the ones with the most power to overwrite.
    for (const suggestion of ["hot_lead", "sql", "do_not_contact"] as LeadStatus[]) {
      assert(
        nextStatus(suggestion, "do_not_contact") === "do_not_contact",
        `CASE A: a "${suggestion}" suggestion moved an opted-out lead — this is the live defect`,
      );
    }
    // And the ordinary ones.
    for (const suggestion of ["replied", "mql", "opportunity", "won", "contacted"] as LeadStatus[]) {
      assert(
        nextStatus(suggestion, "do_not_contact") === "do_not_contact",
        `CASE A: a "${suggestion}" suggestion moved an opted-out lead`,
      );
    }
    console.log("✅ CASE A — no suggestion moves a lead off do_not_contact");
  }

  // ---------------------------------------------------------------- CASE B
  {
    assert(
      nextStatus(undefined, "do_not_contact") === "do_not_contact",
      "CASE B: an opted-out lead must survive a message that suggests nothing",
    );
    console.log("✅ CASE B — it survives a message with no suggestion");
  }

  // ---------------------------------------------------------------- CASE C
  {
    for (const current of [undefined, "new", "contacted", "replied", "hot_lead", "won"] as (LeadStatus | undefined)[]) {
      assert(
        nextStatus("do_not_contact", current) === "do_not_contact",
        `CASE C: a customer at "${current}" who asks to be left alone must reach do_not_contact`,
      );
    }
    console.log("✅ CASE C — an opt-out is still reachable from every status");
  }

  // ---------------------------------------------------------------- CASE D
  {
    // Protected statuses still resist demotion...
    assert(nextStatus("replied", "sql") === "sql", "CASE D: a protected status must still resist demotion");
    assert(nextStatus("contacted", "won") === "won", "CASE D: won must still resist demotion");
    // ...but still accept the promotions that were always allowed.
    assert(nextStatus("hot_lead", "mql") === "hot_lead", "CASE D: promotion to hot_lead must still work");
    assert(nextStatus("sql", "mql") === "sql", "CASE D: promotion to sql must still work");
    // Unprotected statuses still take whatever is suggested.
    assert(nextStatus("replied", "contacted") === "replied", "CASE D: an unprotected status must still follow the suggestion");
    assert(nextStatus(undefined, "contacted") === "contacted", "CASE D: no suggestion must still mean no change");
    console.log("✅ CASE D — every other transition is unchanged");
  }

  console.log("\n=== GOLDEN PASSED (A-D) ===");
}

main();
