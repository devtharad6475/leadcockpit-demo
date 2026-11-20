/**
 * Golden test — the demo data must not contradict itself on screen (N-DATA-9).
 *
 * WHY THIS EXISTS (2026-08-20)
 * ----------------------------
 * The Replies screen showed Zayna Wedding Couture asking "Can you confirm exact
 * price for 500 meters?" and, directly underneath, a red banner reading
 * "Customer hasn't messaged you yet — the 24-hour window is not open. A
 * pre-approved template is required to send." Both statements were on one
 * screen and they could not both be true.
 *
 * The demo data held 4 customer replies and `lastInboundAt` on 0 of 15 leads,
 * and isWithin24hWindow(undefined) correctly reports the window closed. The
 * production path was never at fault — WhatsAppConversationEngine stamps the
 * field on every inbound message — it was the SEEDERS, which created replies
 * without ever stamping the lead they belong to.
 *
 * It is not cosmetic: `lastInboundAt` gates real sending (CP-24), so on the
 * demo data every WhatsApp reply was refused as out-of-window. It is also why
 * golden-whatsapp-outbound-send had to seed the field by hand to test a send.
 *
 *   CASE A — the derivation rule itself: latest reply wins, email replies are
 *     excluded (they do not open Meta's WhatsApp window), leads with no reply
 *     are left alone.
 *
 *   CASE B — the JSON seeder's output: every lead with an inbound WhatsApp
 *     reply carries a lastInboundAt at least as recent as that reply. This is
 *     the check that fails if somebody adds a reply to the seed data and
 *     forgets the lead, which is exactly how the defect arrived.
 *
 *   CASE C — the reverse direction: no lead may claim an inbound message it has
 *     no reply for. A stamped lead with no reply behind it would tell the
 *     operator the 24-hour window is open when nothing has arrived.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts \
 *        scripts/golden/golden-demo-data-coherence.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { lastInboundByLead } from "@/lib/last-inbound";
import { buildDemoData } from "../seed-demo";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main() {
  // ─── CASE A: the rule ─────────────────────────────────────────────────────
  {
    const map = lastInboundByLead([
      { leadId: "l1", channel: "WhatsApp", createdAt: "2026-08-01T00:00:00.000Z" },
      { leadId: "l1", channel: "whatsapp", createdAt: "2026-08-03T00:00:00.000Z" },
      { leadId: "l1", channel: "WhatsApp", createdAt: "2026-08-02T00:00:00.000Z" },
      { leadId: "l2", channel: "Email", createdAt: "2026-08-09T00:00:00.000Z" },
    ]);
    assert(map.get("l1") === "2026-08-03T00:00:00.000Z", `CASE A: the LATEST inbound WhatsApp reply must win, got ${map.get("l1")}`);
    assert(map.get("l2") === undefined, "CASE A: an email reply must NOT open the WhatsApp 24-hour window — Meta's rule is channel-specific, and stamping it would tell the operator they may send when Meta would refuse");
    assert(map.size === 1, `CASE A: only leads with an inbound WhatsApp reply may be stamped, got ${map.size} entries`);
    console.log("✅ CASE A — latest WhatsApp reply wins; email replies excluded; silent leads untouched");
  }

  const data = await buildDemoData();
  const replies = data.replies ?? [];
  const leads = data.leads ?? [];
  const inbound = lastInboundByLead(replies);

  // ─── CASE B: every customer who wrote is recorded as having written ───────
  {
    assert(replies.length > 0, "CASE B: the demo data has no replies at all — this golden would pass vacuously");
    const missing: string[] = [];
    for (const [leadId, at] of inbound) {
      const lead = leads.find((l) => l.id === leadId);
      assert(lead, `CASE B: reply references lead ${leadId}, which is not in the demo data`);
      if (!lead.lastInboundAt || lead.lastInboundAt < at) {
        missing.push(`${leadId} (${lead.companyName || "unnamed"}): lastInboundAt=${lead.lastInboundAt ?? "unset"}, reply at ${at}`);
      }
    }
    assert(
      missing.length === 0,
      `CASE B: ${missing.length} seeded lead(s) have a customer's WhatsApp reply on file but no matching lastInboundAt:\n    ${missing.join("\n    ")}\n` +
      "  The Replies screen would show the customer's message above a banner saying they have never written, and the CP-24 " +
      "window gate would refuse every send to them. Derive it in the seeder via lastInboundByLead().",
    );
    console.log(`✅ CASE B — all ${inbound.size} lead(s) with an inbound WhatsApp reply carry a lastInboundAt at least as recent`);
  }

  // ─── CASE C: nobody claims a message they never received ──────────────────
  {
    const phantom = leads.filter((l) => l.lastInboundAt && !inbound.has(l.id));
    assert(
      phantom.length === 0,
      `CASE C: ${phantom.length} lead(s) carry a lastInboundAt with no inbound WhatsApp reply behind it: ` +
      `[${phantom.map((l) => `${l.id}=${l.lastInboundAt}`).join(", ")}]. That opens the 24-hour window on a conversation ` +
      "that never happened, which is the same defect pointing the other way.",
    );
    console.log(`✅ CASE C — no lead claims an inbound message it has no reply for (${leads.length} leads checked)`);
  }

  console.log("\n✅✅✅ All demo-data-coherence golden cases PASSED (A–C). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
