-- Session 55 (2026-09-09): who a workspace does NOT sell to.
--
-- `ICP.exclusions` was added to the domain type and to the Ideal Customers
-- screen, and nothing persisted it: there was no column. The screen saved, the
-- API answered 200, and the value was gone on the next read — on the substrate
-- production runs on. The JSON substrate stores whole objects, which is why
-- every test passed.
ALTER TABLE "icps" ADD COLUMN "exclusions_json" JSONB;
