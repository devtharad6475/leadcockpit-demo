/**
 * Golden test — a signed quote and a delivered order cannot be walked
 * backwards (N-DATA-12).
 *
 * WHY THIS EXISTS (2026-08-20, CEO-loop session 11)
 * ------------------------------------------------
 * Both status routes validated the TARGET status against the type union and
 * never looked at the status the document was already in. So the API accepted,
 * with HTTP 200:
 *
 *     quote: accepted  → draft
 *     order: delivered → draft
 *
 * and the detail drawer's dropdown offered every status except the current one,
 * so the operator was actively invited to make the move.
 *
 * The product already knew this was wrong — in a different route. `POST
 * /quotes/:id/revise` refuses with QUOTE_COMMITTED: "A quote the customer has
 * committed to can't be revised — create a new quote instead so the agreed
 * price stays on record." One route protected the agreed price while its
 * sibling let a dropdown edit it away.
 *
 * WHAT THIS GOLDEN PINS.
 *
 *   CASE A — an accepted quote refuses to become a draft, is UNCHANGED
 *     afterwards, and the refusal tells the operator what they CAN do.
 *
 *   CASE B — a delivered order refuses to become a draft, and is unchanged.
 *
 *   CASE C — the legal moves still work. A gate that blocks the real workflow
 *     is a worse bug than the one it fixes, so the forward path is exercised
 *     end to end on both documents.
 *
 *   CASE D — the DRAWER builds its dropdown from the same shared map the API
 *     validates against. The two drifting apart is the whole reason the screen
 *     could offer a move the server would later have to refuse, and no
 *     API-level assertion can see a hardcoded list in a .tsx.
 *
 *   CASE E — the map never offers a status that belongs to a dedicated route
 *     (converted / superseded / cancelled / partial_cancelled). Those carry
 *     linked work — creating the order, linking the replacement, recomputing
 *     cancelled totals — and reaching them through the generic status route is
 *     exactly what F-DATA-2 and F-DATA-5 were about.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts \
 *        scripts/golden/golden-status-transitions.ts
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
import type { QuoteStatus, OrderStatus } from "@/lib/types";
import {
  QUOTE_TRANSITIONS,
  ORDER_TRANSITIONS,
  nextQuoteStatuses,
  nextOrderStatuses,
} from "@/lib/status-transitions";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const WS = defaultWorkspaceId;

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
  return { status: response.status, body: await response.json() };
}

/** The message an operator would actually read, wherever the route put it. */
function messageOf(body: unknown): string {
  const b = body as { error?: { message?: unknown } | string; message?: string } | undefined;
  if (typeof b?.error === "string") return b.error;
  if (b?.error && typeof b.error === "object") return String((b.error as { message?: unknown }).message ?? JSON.stringify(b.error));
  return String(b?.message ?? JSON.stringify(body));
}

async function seedLead(repos: RepositoryBundle, companyName: string) {
  return repos.lead.createLead({
    workspaceId: WS,
    companyName,
    contactName: "Transition Buyer",
    source: "manual",
    status: "approved",
    reviewStatus: "approved",
    enrichmentStatus: "completed",
    doNotContact: false,
    consentStatus: "none",
  });
}

async function seedQuote(repos: RepositoryBundle, leadId: string, status: QuoteStatus) {
  // A-7 (2026-08-25): allocate the number the way the product does.
  // `quote.create()` defaults quoteNumber to 0, and quotes carry a unique index
  // on (workspace_id, quote_number) — so the SECOND quote this golden seeded
  // collided on Postgres. JSON has no unique index, so every seeded quote was
  // silently numbered 0 and nothing complained. Shipping routes use
  // createWithNextQuoteNumber; so does this now.
  return repos.quote.createWithNextQuoteNumber({
    workspaceId: WS,
    leadId,
    status,
    lineItems: [
      { id: "li_t1", productName: "Denim, 12 oz", quantity: 300, unit: "m", unitPrice: 260, currencyCode: "INR", lineTotal: 78000 },
    ],
    grandTotal: 78000,
    currencyCode: "INR",
  });
}

async function seedOrder(repos: RepositoryBundle, leadId: string, status: OrderStatus) {
  // Same as seedQuote above — orders carry the same shape of unique number.
  return repos.order.createWithNextOrderNumber({
    workspaceId: WS,
    leadId,
    status,
    origin: "direct",
    lineItems: [
      { id: "li_t2", productName: "Canvas, 400 gsm", quantity: 150, unit: "m", unitPrice: 310, currencyCode: "INR", lineTotal: 46500 },
    ],
    grandTotal: 46500,
    currencyCode: "INR",
  });
}

async function main() {
  const repos = createRepositories();
  // A-7 (2026-08-25): say out loud what this golden needs. It hangs leads,
  // quotes and orders off `WS`, and on JSON that worked because a file has no
  // foreign keys — the tenant never had to exist. Postgres refuses with
  // leads_workspace_id_fkey. One row, created here rather than assumed.
  await ensureWorkspace(repos, WS, "Status Transitions Golden");

  // ─── CASE A: an accepted quote cannot become a draft ──────────────────────
  {
    const lead = await seedLead(repos, "Backwards Quote Traders");
    const quote = await seedQuote(repos, lead.id, "accepted");

    const res = await postStatus("quotes", quote.id, "draft");
    assert(
      res.status >= 400,
      `CASE A: accepted → draft returned HTTP ${res.status}. A quote the customer signed must not be walked ` +
      "back to a draft — /quotes/:id/revise already refuses exactly this in writing (QUOTE_COMMITTED).",
    );
    const message = messageOf(res.body);
    assert(
      message.includes("accepted") && message.includes("draft"),
      `CASE A: the refusal must name where the quote is and what was asked for. Got: ${message}`,
    );
    assert(
      /rejected/.test(message),
      "CASE A: the refusal must tell the operator what they CAN do from here, or they will click every " +
      `option to find out. Got: ${message}`,
    );

    const after = await repos.quote.getById(WS, quote.id);
    assert(
      after?.status === "accepted",
      `CASE A: the quote is now "${after?.status}". A refused transition must leave the record alone.`,
    );
    console.log("✅ CASE A — an accepted quote refuses to become a draft, stays accepted, and says what is possible instead");
  }

  // ─── CASE B: a delivered order cannot become a draft ──────────────────────
  {
    const lead = await seedLead(repos, "Backwards Order Mills");
    const order = await seedOrder(repos, lead.id, "delivered");

    const res = await postStatus("orders", order.id, "draft");
    assert(
      res.status >= 400,
      `CASE B: delivered → draft returned HTTP ${res.status}. Goods that reached the customer cannot un-happen.`,
    );
    const after = await repos.order.getById(WS, order.id);
    assert(
      after?.status === "delivered",
      `CASE B: the order is now "${after?.status}". A refused transition must leave the record alone.`,
    );
    console.log("✅ CASE B — a delivered order refuses to become a draft and stays delivered");
  }

  // ─── CASE C: the legal path still works ───────────────────────────────────
  {
    const lead = await seedLead(repos, "Forward Path Weaves");

    const quote = await seedQuote(repos, lead.id, "draft");
    for (const step of ["sent", "accepted"] as const) {
      const res = await postStatus("quotes", quote.id, step);
      assert(res.status < 400, `CASE C: the LEGAL quote move → ${step} was refused with HTTP ${res.status}: ${messageOf(res.body)}`);
    }
    const q = await repos.quote.getById(WS, quote.id);
    assert(q?.status === "accepted", `CASE C: quote ended at "${q?.status}", expected "accepted"`);

    const order = await seedOrder(repos, lead.id, "draft");
    for (const step of ["confirmed", "in_progress", "shipped", "delivered"] as const) {
      const res = await postStatus("orders", order.id, step);
      assert(res.status < 400, `CASE C: the LEGAL order move → ${step} was refused with HTTP ${res.status}: ${messageOf(res.body)}`);
    }
    const o = await repos.order.getById(WS, order.id);
    assert(o?.status === "delivered", `CASE C: order ended at "${o?.status}", expected "delivered"`);
    console.log("✅ CASE C — the whole forward workflow still runs: draft → sent → accepted, and draft → confirmed → in_progress → shipped → delivered");
  }

  // ─── CASE D: the drawer reads the same map the API enforces ───────────────
  {
    const src = readFileSync(resolve("src/app/sections/Commercial.tsx"), "utf8");
    for (const fn of ["nextOrderStatuses(detailOrder.status)", "nextQuoteStatuses(detailQuote.status)"]) {
      assert(
        src.includes(fn),
        `CASE D: Commercial.tsx does not build its dropdown from ${fn}. A screen with its own idea of which ` +
        "moves exist is how the drawer came to invite an operator to walk a delivered order back to Draft.",
      );
    }
    assert(
      !/\["quoted", "confirmed", "in_progress"/.test(src) && !/\["draft", "sent", "accepted", "rejected", "expired"\]/.test(src),
      "CASE D: a hardcoded status list is back in Commercial.tsx. The list must come from the shared map so " +
      "the screen cannot offer what the API refuses.",
    );
    console.log("✅ CASE D — both dropdowns are generated from the shared transition map, not from their own hardcoded lists");
  }

  // ─── CASE E: statuses owned by dedicated routes are unreachable here ──────
  {
    const quoteStatuses: QuoteStatus[] = ["draft", "sent", "accepted", "rejected", "expired", "superseded", "converted"];
    const orderStatuses: OrderStatus[] = ["draft", "quoted", "confirmed", "in_progress", "partial_shipped", "shipped", "delivered", "cancelled", "partial_cancelled", "returned"];

    for (const s of quoteStatuses) {
      assert(QUOTE_TRANSITIONS[s] !== undefined, `CASE E: QUOTE_TRANSITIONS has no entry for "${s}" — a status with no entry has no rules`);
    }
    for (const s of orderStatuses) {
      assert(ORDER_TRANSITIONS[s] !== undefined, `CASE E: ORDER_TRANSITIONS has no entry for "${s}"`);
    }

    for (const s of quoteStatuses) {
      for (const banned of ["converted", "superseded"] as const) {
        assert(
          !nextQuoteStatuses(s).includes(banned),
          `CASE E: "${s}" offers "${banned}". That status is set ONLY by /convert or /revise, which create and ` +
          "link the related record — reaching it here produces a converted quote with no order (F-DATA-2) or a " +
          "retired quote with no successor (F-DATA-5).",
        );
      }
    }
    for (const s of orderStatuses) {
      for (const banned of ["cancelled", "partial_cancelled"] as const) {
        assert(
          !nextOrderStatuses(s).includes(banned),
          `CASE E: "${s}" offers "${banned}". Cancellation is owned by /orders/:id/cancel, the only path that ` +
          "enforces the delivered guard and recomputes the cancelled totals.",
        );
      }
    }
    console.log("✅ CASE E — every status has rules, and none of them lead to a status a dedicated route owns");
  }

  console.log("\n✅✅✅ All status-transition golden cases PASSED (A–E). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
