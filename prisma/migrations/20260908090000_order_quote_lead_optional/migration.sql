-- N-BUG (2026-09-08): an order or quote with no lead could not be created on
-- Postgres at all.
--
-- The API contract, stated in its own route comment, is that leadId may be
-- empty: "Empty leadId stays valid (order with no lead)" — a free sample or a
-- walk-in sale that is not attached to a CRM record. The route sent `""` for
-- that case. On the JSON substrate `""` is just a string and the order saved.
-- On Postgres lead_id was NOT NULL with a foreign key to leads(id), and `""`
-- is not NULL, so every such create died on:
--
--   Foreign key constraint violated on the constraint: `orders_lead_id_fkey`
--
-- and the operator was shown "Something went wrong on our side."
--
-- Making the column nullable lets the substrate express what the product
-- already promised. The domain type still uses "" for "no lead", so nothing
-- above the repository changes: the mapper reads NULL back as "".
ALTER TABLE "orders" ALTER COLUMN "lead_id" DROP NOT NULL;
ALTER TABLE "quotes" ALTER COLUMN "lead_id" DROP NOT NULL;
