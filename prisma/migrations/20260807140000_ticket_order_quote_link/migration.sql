-- N-P1-2 (2026-08-07, docs/OPEN-ISSUES.md) — a ticket can now reference the
-- order/quote it complains about. The New Ticket form's own placeholder text
-- has always said "complaint for Order #4" with no field to hold that
-- reference until now.
--
-- Both nullable: most tickets aren't about a specific order or quote, and
-- every existing ticket predates this field.

ALTER TABLE "tickets" ADD COLUMN "order_id" TEXT;
ALTER TABLE "tickets" ADD COLUMN "quote_id" TEXT;
CREATE INDEX "tickets_order_id_idx" ON "tickets"("order_id");
CREATE INDEX "tickets_quote_id_idx" ON "tickets"("quote_id");
