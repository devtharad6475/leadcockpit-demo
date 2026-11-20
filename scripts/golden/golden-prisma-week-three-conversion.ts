// PRISMA_GOLDEN
import "./_helpers/readiness-prisma-environment";
import { readinessFixtureCleanup } from "./_helpers/readiness-fixture-cleanup";
import assert from "node:assert/strict";
import { createRepositories } from "@/repositories";
import { prisma } from "@/lib/prisma";
import { checkWeekThreeConversions } from "./_helpers/week-three-conversion-contract";
import { convertPersistedQuoteToOrder } from "@/services/QuoteConversionService";

const fixtures = readinessFixtureCleanup();
async function main() {
  const repos = createRepositories("prisma");
  fixtures.attach(repos);
  const { workspaceId, makeQuote } = await checkWeekThreeConversions(repos);
  const quote = await makeQuote();
  const revisionOriginal = await makeQuote();
  const before = (await repos.order.listByWorkspace(workspaceId)).length;
  const quotesBefore = (await repos.quote.listByWorkspace(workspaceId)).length;
  // Fault after the order INSERT, at the quote-link UPDATE: the transaction
  // must roll back both writes, rather than reset status and retain an order.
  await prisma.$executeRawUnsafe("CREATE FUNCTION readiness_reject_quote_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status IN ('converted', 'superseded') AND OLD.status <> NEW.status THEN RAISE EXCEPTION 'Injected quote link failure'; END IF; RETURN NEW; END $$");
  await prisma.$executeRawUnsafe("CREATE TRIGGER readiness_quote_link_failure BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION readiness_reject_quote_link()");
  try {
    await assert.rejects(convertPersistedQuoteToOrder(workspaceId, quote.id, undefined, repos), /Injected quote link failure/);
    assert.equal((await repos.order.listByWorkspace(workspaceId)).length, before);
    assert.equal((await repos.quote.getById(workspaceId, quote.id))?.status, "sent");
    assert.equal((await repos.quote.getById(workspaceId, quote.id))?.orderId ?? undefined, undefined);
    await assert.rejects(repos.quote.reviseAtomically(workspaceId, revisionOriginal.id, async current => ({
      workspaceId, leadId: current.leadId, status: "draft", lineItems: current.lineItems,
      grandTotal: current.grandTotal, currencyCode: current.currencyCode, supersedesQuoteId: current.id,
    })), /Injected quote link failure/);
    assert.equal((await repos.quote.listByWorkspace(workspaceId)).length, quotesBefore);
    assert.equal((await repos.quote.getById(workspaceId, revisionOriginal.id))?.status, "sent");
  } finally {
    await prisma.$executeRawUnsafe("DROP TRIGGER readiness_quote_link_failure ON quotes");
    await prisma.$executeRawUnsafe("DROP FUNCTION readiness_reject_quote_link()");
  }
  const retried = await convertPersistedQuoteToOrder(workspaceId, quote.id, undefined, repos);
  const repeated = await convertPersistedQuoteToOrder(workspaceId, quote.id, undefined, repos);
  assert.equal(retried?.order.id, repeated?.order.id);
  assert.equal((await repos.order.listByWorkspace(workspaceId)).length, before + 1);
  console.log("PASS failure at quote link UPDATE rolls back the inserted order; retry stays idempotent");
  console.log("PASS failure retiring a revised quote rolls back its replacement too");
  console.log("Week three atomic quote conversion PostgreSQL: PASS");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { try { await fixtures.cleanup(); } finally { await prisma.$disconnect(); } });
