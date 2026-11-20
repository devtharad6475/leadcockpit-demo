/**
 * Golden test — a demo document whose STATUS says the work is finished must
 * carry the dates that status implies, in order, and none of them in the
 * future (N-UX-11, second half).
 *
 * WHY THIS EXISTS (2026-08-20, CEO-loop session 12)
 * ------------------------------------------------
 * N-UX-11's first half fixed the SCREEN: the order drawer now renders Shipped
 * and Delivered beside the Confirmed row it always had. That exposed the other
 * half immediately — there was nothing to render. Read straight out of the ship
 * database:
 *
 *     #1 confirmed  shipped_at=NULL  delivered_at=NULL
 *     #2 shipped    shipped_at=NULL  delivered_at=NULL
 *     #3 delivered  shipped_at=NULL  delivered_at=NULL
 *
 * The API path is correct — it stamps on every real transition (F7, N-DATA-11).
 * The SEEDER is what was wrong: it wrote the finished status directly into the
 * row and never went through the transition, so the demo shipped an order that
 * says "Delivered" and cannot say when, and a quote that says "Accepted" with
 * no accepted date. That is the exact thing the CEO's definition of done rules
 * out — the operator looks for the data and it is not there.
 *
 * A SECOND, SMALLER LIE fixed at the same time: every seeded document was
 * stamped with one `now`, so an order was confirmed, shipped and delivered in
 * the same millisecond. Non-null but meaningless — and it makes every "days
 * since" readout on the dashboard show zero.
 *
 * WHAT THIS GOLDEN PINS.
 *
 *   CASE A — every seeded ORDER carries every timestamp its status implies. A
 *     delivered order that never recorded a ship date describes goods that
 *     arrived without leaving.
 *
 *   CASE B — those timestamps are strictly ordered against each other and
 *     against createdAt, and none of them is in the future. This is what
 *     catches the all-stamped-with-one-`now` shortcut, which satisfies CASE A
 *     while still being unreadable.
 *
 *   CASE C — the same two rules for seeded QUOTES (sentAt / acceptedAt).
 *
 *   CASE D — the PRISMA seeder gets the same treatment. It builds its own rows
 *     rather than calling buildDemoData(), so nothing above can see it, and its
 *     `seed_order_2` was `delivered` with `deliveredAt` set and `shippedAt`
 *     never written at all. It cannot be executed here (it needs a live
 *     Postgres), so it is pinned as a source assertion — the same shape used
 *     for the drawer in golden-lifecycle-timestamps CASE D.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts \
 *        scripts/golden/golden-seed-lifecycle-dates.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildDemoData } from "../seed-demo";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

/**
 * What each status claims already happened. Read forward: reaching `delivered`
 * means the order was confirmed, then shipped, then delivered, so all three
 * dates must exist. Statuses that claim nothing (`draft`, `quoted`) are absent.
 */
const ORDER_REQUIRED: Record<string, readonly string[]> = {
  confirmed: ["confirmedAt"],
  in_progress: ["confirmedAt"],
  partial_shipped: ["confirmedAt", "shippedAt"],
  shipped: ["confirmedAt", "shippedAt"],
  delivered: ["confirmedAt", "shippedAt", "deliveredAt"],
  returned: ["confirmedAt", "shippedAt", "deliveredAt"],
};

const QUOTE_REQUIRED: Record<string, readonly string[]> = {
  sent: ["sentAt"],
  accepted: ["sentAt", "acceptedAt"],
  converted: ["sentAt", "acceptedAt"],
};

/** The order the dates must fall in, earliest first. */
const ORDER_SEQUENCE = ["createdAt", "confirmedAt", "shippedAt", "deliveredAt"] as const;
const QUOTE_SEQUENCE = ["createdAt", "sentAt", "acceptedAt"] as const;

type Row = Record<string, unknown>;

function checkRequired(kind: string, rows: Row[], required: Record<string, readonly string[]>) {
  for (const row of rows) {
    const status = String(row.status);
    for (const field of required[status] ?? []) {
      const value = row[field];
      assert(
        typeof value === "string" && value.length > 0,
        `${kind} ${row.id} is "${status}" but ${field} is ${value === undefined ? "missing" : JSON.stringify(value)}. ` +
        `${kind === "order" ? "An" : "A"} ${kind} whose status says the work is finished must be able to say WHEN — the drawer renders these ` +
        "fields now, and a blank beside a finished badge is what the operator reports as a bug.",
      );
    }
  }
}

function checkOrdering(kind: string, rows: Row[], sequence: readonly string[]) {
  const nowMs = Date.now();
  for (const row of rows) {
    const stamped = sequence
      .map((field) => ({ field, value: row[field] }))
      .filter((s): s is { field: string; value: string } => typeof s.value === "string" && s.value.length > 0);

    for (const { field, value } of stamped) {
      const ms = Date.parse(value);
      assert(Number.isFinite(ms), `${kind} ${row.id}: ${field} is not a parseable date (${value})`);
      assert(
        ms <= nowMs + 60_000,
        `${kind} ${row.id}: ${field} (${value}) is in the FUTURE. A seeded history that has not happened yet ` +
        "makes every follow-up clock in the product negative.",
      );
    }

    for (let i = 1; i < stamped.length; i++) {
      const prev = stamped[i - 1];
      const cur = stamped[i];
      assert(
        Date.parse(cur.value) > Date.parse(prev.value),
        `${kind} ${row.id}: ${cur.field} (${cur.value}) is not AFTER ${prev.field} (${prev.value}). Every seeded ` +
        "row used to carry one identical `now`, so an order was confirmed, shipped and delivered in the same " +
        "millisecond — non-null, but it tells the operator nothing and makes every \"days since\" readout zero.",
      );
    }
  }
}

async function main() {
  const data = await buildDemoData();
  const orders = (data.orders ?? []) as unknown as Row[];
  const quotes = (data.quotes ?? []) as unknown as Row[];

  assert(orders.length > 0, "precondition: the demo dataset seeds no orders at all");
  assert(quotes.length > 0, "precondition: the demo dataset seeds no quotes at all");

  // ─── CASE A: a finished order carries the dates it claims ─────────────────
  {
    checkRequired("order", orders, ORDER_REQUIRED);
    const finished = orders.filter((o) => ORDER_REQUIRED[String(o.status)]);
    assert(
      finished.length > 0,
      "CASE A precondition: no seeded order is in a status that implies a date, so this case would pass vacuously " +
      "— the demo is supposed to show a realistic fulfilment pipeline",
    );
    console.log(`✅ CASE A — all ${finished.length} seeded orders in a finished status carry every date that status implies`);
  }

  // ─── CASE B: the dates are ordered, and none in the future ────────────────
  {
    checkOrdering("order", orders, ORDER_SEQUENCE);
    console.log("✅ CASE B — the order dates run created → confirmed → shipped → delivered, strictly increasing, none in the future");
  }

  // ─── CASE C: the same for quotes ──────────────────────────────────────────
  {
    checkRequired("quote", quotes, QUOTE_REQUIRED);
    checkOrdering("quote", quotes, QUOTE_SEQUENCE);
    const finished = quotes.filter((q) => QUOTE_REQUIRED[String(q.status)]);
    assert(finished.length > 0, "CASE C precondition: no seeded quote is sent or accepted");
    console.log(`✅ CASE C — all ${finished.length} seeded quotes carry sentAt/acceptedAt in order (quote #2 read "Accepted" with no accepted date)`);
  }

  // ─── CASE D: the Prisma seeder, which builds its own rows ─────────────────
  {
    const src = readFileSync(resolve("scripts/seed-demo-prisma.ts"), "utf8");
    const delivered = src.split("\n").find((l) => l.includes('status: "delivered"'));
    assert(delivered, "CASE D: seed-demo-prisma.ts no longer seeds a delivered order — re-derive this case rather than deleting it");
    assert(
      delivered.includes("shippedAt:"),
      "CASE D: the Prisma seeder's delivered order does not stamp shippedAt. It recorded a delivery date with no " +
      "ship date at all — goods that arrived without ever leaving. This seeder never calls buildDemoData(), so " +
      "CASES A–C cannot see it.",
    );
    assert(
      !/deliveredAt: NOW\b/.test(src) && !/confirmedAt: NOW\b/.test(src),
      "CASE D: a lifecycle timestamp in the Prisma seeder is back to a bare NOW, which dates the whole fulfilment " +
      "history to one instant.",
    );
    console.log("✅ CASE D — the Prisma seeder stamps an ordered history too, not one shared NOW with a hole in it");
  }

  console.log("\n✅✅✅ All seed lifecycle-date golden cases PASSED (A–D). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
