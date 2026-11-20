/**
 * Golden test — a commercial document that says "Sent" / "Accepted" /
 * "Shipped" / "Delivered" must be able to say WHEN (N-DATA-11, N-UX-11).
 *
 * WHY THIS EXISTS (2026-08-20, CEO-loop session 11)
 * ------------------------------------------------
 * Found by walking Quotes & Orders on the running app as an operator, not by
 * reading code. Quote #2 showed the badge "Accepted" and no accepted date. The
 * database agreed: accepted_at was NULL.
 *
 * TWO SEPARATE HALVES OF THE SAME DEFECT.
 *
 *   1. N-DATA-11 — the QUOTE status route never stamped anything. It did a
 *      bare `{ status }` update. `Quote.sentAt` and `Quote.acceptedAt` exist on
 *      the type and are persisted by BOTH substrates, but a repo-wide search
 *      found nothing that ever wrote them — no route, no service. So the
 *      drawer's `Accepted:` row in Commercial.tsx was an unreachable branch in
 *      production: it read a value nobody wrote. The audit trail was equally
 *      blind — it logged `{status}` only, while its ORDER sibling forty lines
 *      above logs the stamped times. "When did the customer say yes?" had no
 *      answer on screen OR in the trail.
 *
 *      This is the same defect that was already found and fixed for ORDERS as
 *      F7 (2026-08-04: "Previously this route did a bare status update with NO
 *      timestamp, so a delivered order had no deliveredAt"). The fix was never
 *      carried across to the sibling route in the same file.
 *
 *   2. N-UX-11 — the ORDER route stamped shippedAt/deliveredAt correctly and
 *      both substrates persisted them, but a grep for those two fields across
 *      every .tsx in the repo returned ZERO hits. The two dates a customer
 *      actually phones about — "when did it ship, when did it land" — were
 *      recorded and never shown anywhere in the product. The QUOTE drawer
 *      twenty lines below had rendered its Sent/Accepted analogues all along.
 *
 * WHAT THIS GOLDEN PINS.
 *
 *   CASE A — driving the REAL POST /quotes/:id/status handler through
 *     draft → sent → accepted stamps both timestamps, and acceptedAt is not
 *     earlier than sentAt. Pre-fix both were undefined.
 *
 *   CASE B — re-entering a status must NOT rewrite the original timestamp.
 *     A quote re-sent on Friday still records the Monday it first went out;
 *     history is not editable by repetition.
 *
 *   CASE C — the ORDER route still stamps confirmed/shipped/delivered. This
 *     guards F7 against a regression, since the two routes live in one file
 *     and this golden is the first thing to hold both to the same rule.
 *
 *   CASE D — Commercial.tsx must RENDER the order's shipped/delivered dates.
 *     A stamped-but-invisible timestamp is the N-UX-11 half, and it is
 *     invisible to every API-level assertion above, so it is pinned as a
 *     source assertion.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts \
 *        scripts/golden/golden-lifecycle-timestamps.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRepositories } from "@/repositories";
import { ensureWorkspace } from "./_helpers/fixtures";
import { defaultWorkspaceId } from "@/lib/db";
import type { RepositoryBundle } from "@/repositories/interfaces";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

/**
 * Drive the real route handler, not a service helper. The point of the fix is
 * that the HTTP path an operator's click actually travels does the stamping —
 * proving a helper in isolation would have proven nothing, because there was
 * no helper: the bare update lived inline in the route.
 */
async function postStatus(kind: "quotes" | "orders", id: string, toStatus: string) {
  const { POST } = await import("@/app/api/[[...path]]/route");
  const request = new Request(`http://localhost/api/${kind}/${id}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toStatus }),
  });
  const response = await POST(
    request as never,
    { params: Promise.resolve({ path: [kind, id, "status"] }) },
  );
  const payload = await response.json();
  assert(
    response.status < 400,
    `${kind}/${id}/status → ${toStatus} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
  );
  return payload;
}

// Mutations resolve to `defaultWorkspaceId` outside production auth mode
// (workspace-resolution.ts: "Demo mode: body workspaceId is IGNORED"), so the
// fixtures must be seeded there or the route would 404 on its own data.
const WS = defaultWorkspaceId;

async function seedLead(repos: RepositoryBundle, companyName: string) {
  return repos.lead.createLead({
    workspaceId: WS,
    companyName,
    contactName: "Lifecycle Buyer",
    source: "manual",
    status: "approved",
    reviewStatus: "approved",
    enrichmentStatus: "completed",
    doNotContact: false,
    consentStatus: "none",
  });
}

async function seedQuote(repos: RepositoryBundle, leadId: string) {
  // A-7 (2026-08-25): allocate the number the product's own way. Bare
  // create() defaults quoteNumber to 0 and (workspace_id, quote_number) is
  // unique, so the second seeded quote collided on Postgres while JSON
  // silently numbered every quote 0.
  return repos.quote.createWithNextQuoteNumber({
    workspaceId: WS,
    leadId,
    status: "draft",
    lineItems: [
      {
        id: "li_case_a",
        productName: "Cotton twill, 240 gsm",
        quantity: 500,
        unit: "m",
        unitPrice: 180,
        currencyCode: "INR",
        lineTotal: 90000,
      },
    ],
    grandTotal: 90000,
    currencyCode: "INR",
  });
}

async function main() {
  const repos = createRepositories();
  // A-7 (2026-08-25): the tenant this golden hangs its rows off has to
  // actually exist. JSON has no foreign keys so it never had to; Postgres
  // refuses on the first write. One row, declared here, not assumed.
  await ensureWorkspace(repos, WS, "Lifecycle Timestamps Golden");

  // ─── CASE A: the quote route stamps both transitions ──────────────────────
  {
    const lead = await seedLead(repos, "Case A Textiles");
    const quote = await seedQuote(repos, lead.id);

    assert(!quote.sentAt && !quote.acceptedAt, "CASE A precondition: a fresh draft carries neither timestamp");

    await postStatus("quotes", quote.id, "sent");
    const afterSent = await repos.quote.getById(WS, quote.id);
    assert(afterSent, "CASE A: the quote disappeared after the sent transition");
    assert(
      afterSent.status === "sent",
      `CASE A: status is "${afterSent.status}", expected "sent"`,
    );
    assert(
      typeof afterSent.sentAt === "string" && afterSent.sentAt.length > 0,
      "CASE A: sentAt was NOT stamped. This is the defect: the route wrote a bare {status} update, so a quote " +
      "could read \"Sent\" with no send date anywhere in the app or the audit trail.",
    );

    await postStatus("quotes", quote.id, "accepted");
    const afterAccepted = await repos.quote.getById(WS, quote.id);
    assert(afterAccepted, "CASE A: the quote disappeared after the accepted transition");
    assert(
      afterAccepted.status === "accepted",
      `CASE A: status is "${afterAccepted.status}", expected "accepted"`,
    );
    assert(
      typeof afterAccepted.acceptedAt === "string" && afterAccepted.acceptedAt.length > 0,
      "CASE A: acceptedAt was NOT stamped. Quote #2 on the running app showed exactly this — the badge " +
      "\"Accepted\" beside an empty date, because the drawer's `Accepted:` row reads a field nobody wrote.",
    );
    assert(
      Date.parse(afterAccepted.acceptedAt!) >= Date.parse(afterAccepted.sentAt!),
      `CASE A: acceptedAt (${afterAccepted.acceptedAt}) is EARLIER than sentAt (${afterAccepted.sentAt}) — ` +
      "a customer cannot accept a quote before it was sent",
    );

    // The audit trail must carry the stamps too, matching what the ORDER route
    // already logs. Without this the answer to "when did they say yes?" exists
    // on the row but not in the history the row's changes are reconstructed from.
    // The persisted shape is { eventType, payload: { newValuesJson } } — the
    // route's call-site names (action / newValuesJson) are AuditLogService's
    // input vocabulary, not the row's.
    const audits = await repos.auditLog.listByWorkspace(WS);
    const acceptedAudit = audits.find((a) => {
      const payload = a.payload as { newValuesJson?: { status?: string } } | undefined;
      return a.eventType === "quote.status_change"
        && a.entityId === quote.id
        && payload?.newValuesJson?.status === "accepted";
    });
    assert(acceptedAudit, "CASE A: no quote.status_change audit row was written for the accepted transition");
    const acceptedNewValues = (acceptedAudit.payload as { newValuesJson?: { acceptedAt?: string } }).newValuesJson;
    assert(
      acceptedNewValues?.acceptedAt === afterAccepted.acceptedAt,
      "CASE A: the audit row records the new status but not the timestamp that came with it, so the trail " +
      `still cannot answer when the customer accepted (audit: ${acceptedNewValues?.acceptedAt}, row: ${afterAccepted.acceptedAt})`,
    );

    console.log("✅ CASE A — draft → sent → accepted stamps sentAt and acceptedAt, in order, on the row and in the audit trail");
  }

  // ─── CASE B: repetition does not rewrite history ──────────────────────────
  {
    const lead = await seedLead(repos, "Case B Weaving");
    const quote = await seedQuote(repos, lead.id);

    await postStatus("quotes", quote.id, "sent");
    const first = await repos.quote.getById(WS, quote.id);
    assert(first?.sentAt, "CASE B precondition: the first send must stamp sentAt");

    // A real operator does this: sends, gets no reply, re-sends. The record of
    // when the quote FIRST went out is the thing the follow-up clock is
    // measured from, so it must survive.
    await new Promise((r) => setTimeout(r, 5));
    await postStatus("quotes", quote.id, "sent");
    const second = await repos.quote.getById(WS, quote.id);
    assert(
      second?.sentAt === first.sentAt,
      `CASE B: re-sending rewrote sentAt (${first.sentAt} → ${second?.sentAt}). The `
      + "`!quote.sentAt` guard exists so a repeated transition never edits history.",
    );
    console.log("✅ CASE B — re-entering a status leaves the original timestamp untouched");
  }

  // ─── CASE C: the order route still stamps (guards F7) ─────────────────────
  {
    const lead = await seedLead(repos, "Case C Mills");
    const order = await repos.order.createWithNextOrderNumber({
      workspaceId: WS,
      leadId: lead.id,
      status: "draft",
      origin: "direct",
      lineItems: [
        { id: "li_case_c", productName: "Poplin, 120 gsm", quantity: 200, unit: "m", unitPrice: 95, currencyCode: "INR", lineTotal: 19000 },
      ],
      grandTotal: 19000,
      currencyCode: "INR",
    });

    for (const step of ["confirmed", "shipped", "delivered"] as const) {
      await postStatus("orders", order.id, step);
    }
    const after = await repos.order.getById(WS, order.id);
    assert(after, "CASE C: the order disappeared");
    assert(after.confirmedAt, "CASE C: confirmedAt missing — F7 has regressed");
    assert(after.shippedAt, "CASE C: shippedAt missing — F7 has regressed");
    assert(after.deliveredAt, "CASE C: deliveredAt missing — F7 has regressed");
    assert(
      Date.parse(after.deliveredAt!) >= Date.parse(after.shippedAt!)
      && Date.parse(after.shippedAt!) >= Date.parse(after.confirmedAt!),
      `CASE C: the order timestamps are out of order (confirmed ${after.confirmedAt}, shipped ${after.shippedAt}, delivered ${after.deliveredAt})`,
    );
    console.log("✅ CASE C — the order route still stamps confirmed / shipped / delivered, in order (F7 held)");
  }

  // ─── CASE D: the stamped order dates are actually on screen ───────────────
  {
    const src = readFileSync(resolve("src/app/sections/Commercial.tsx"), "utf8");
    for (const field of ["detailOrder.shippedAt", "detailOrder.deliveredAt"]) {
      assert(
        src.includes(field),
        `CASE D: Commercial.tsx does not render ${field}. The API stamps it and both substrates persist it, ` +
        "but before N-UX-11 no .tsx in the repo read either field — so the two dates a customer actually calls " +
        "about were recorded and never shown. A timestamp nobody can see is not a fix.",
      );
    }
    console.log("✅ CASE D — the order drawer renders the shipped and delivered dates it has always been storing");
  }

  console.log("\n✅✅✅ All lifecycle-timestamp golden cases PASSED (A–D). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
