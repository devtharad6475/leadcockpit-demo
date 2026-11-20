-- CP-24 (2026-08-02) — WhatsApp 24-hour customer-service window.
-- Adds lastInboundAt to Lead: the timestamp of the customer's LAST INBOUND
-- message. Distinct from lastContactedAt (= WE contacted them, outbound only).
-- Drives the window gate in AutoReplyReviewService: inside 24h → free-text OK;
-- outside 24h → pre-approved template required (Meta rule).
--
-- Column is nullable because all existing leads predate this field; they are
-- treated as "window closed / never messaged" until the customer messages in.

ALTER TABLE "leads" ADD COLUMN "last_inbound_at" TIMESTAMP(3);
