/**
 * 2026-07-26 (Cluster 6) — Atomicity: quote→order conversion + ticket conversion.
 *
 * Pins the Cluster-6 fixes from docs/AUDIT-FINDINGS-2026-07-26.md P1-6:
 *   - quote→order conversion is now ONE atomic transaction (order create +
 *     quote status update commit together or not at all).
 *   - unknown-question→ticket conversion is now ONE atomic transaction
 *     (ticket create + source update + creation event commit together).
 *
 * The math-layer contract is pinned by `golden:run-in-transaction` (6 cases
 * incl. the load-bearing rollback CASE B). This file proves the END-TO-END
 * effect through the real API: the conversions still work + produce the
 * expected linked records (regression check that the atomicity refactor
 * didn't break the happy path).
 *
 * Per build-right Phase 3b: a UI feature is NOT done just because the code
 * compiles. We boot the app, exercise the real flow, and assert the records
 * land in the right state.
 *
 * Run: npx playwright test cluster6-atomicity
 */
import { test, expect } from "@playwright/test";
import { expectAppShell } from "./helpers/login";
import { E2E_BASE_URL } from "./helpers/e2e-target";

async function loginDemo(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Continue in Demo Mode/i }).click();
  // 2026-08-19 — was an <h1> reading "LeadCockpit". The 2026-08-17 nav redesign
  // moved that string into the sidebar brand (not a heading), so this matched
  // nothing and every test in this file failed at login. See e2e/helpers/login.ts.
  await expectAppShell(page);
}

test.describe("Cluster 6 — atomicity (regression: conversions still work end-to-end)", () => {

  test("API: quote→order conversion is atomic — order created + quote marked converted together", async ({ request }) => {
    // 1. Create a fresh quote via the API.
    const base = E2E_BASE_URL;
    const wsBody = { workspaceId: "workspace_demo" };
    // 2026-08-19 (N-TEST-9) — this used to post `leadId: "lead_demo"`, a lead id
    // that exists in no seed. POST /api/quotes validates the lead against the
    // workspace (route.ts F6 check) and answers
    //   404 {"code":"LEAD_NOT_FOUND"}
    // so the test failed on `create quote must succeed / Received: false` and
    // read as if the ATOMICITY refactor had broken quote creation. It had not:
    // the request never reached the transaction. Resolve a real lead from the
    // API instead of naming one, so a seed rename can no longer masquerade as
    // an atomicity regression.
    const leadsResp = await request.get(`${base}/api/leads?workspaceId=workspace_demo`);
    expect(leadsResp.ok(), "leads list must be readable to pick a quote target").toBeTruthy();
    const leads = (await leadsResp.json()) as { id: string }[];
    expect(leads.length, "seed must contain at least one lead to quote against").toBeGreaterThan(0);
    const leadId = leads[0].id;
    const createQuote = await request.post(`${base}/api/quotes`, {
      data: { ...wsBody, leadId, status: "sent", lineItems: [{ productName: "Test Zari", quantity: 5, unitPrice: 100 }], grandTotal: 500, currencyCode: "INR" },
    });
    expect(
      createQuote.ok(),
      `create quote must succeed (HTTP ${createQuote.status()}: ${(await createQuote.text()).slice(0, 200)})`,
    ).toBeTruthy();
    const quote = (await createQuote.json()) as { id: string; status: string };
    expect(quote.id, "quote must have an id").toBeTruthy();
    // 2026-09-26: a new quote is always a draft (the status in the create body
    // is ignored), so mark it sent through its own step, as the product does.
    const sent = await request.post(`${base}/api/quotes/${quote.id}/status`, { data: { ...wsBody, toStatus: "sent" } });
    expect(sent.ok(), `marking the quote sent must succeed (HTTP ${sent.status()})`).toBeTruthy();

    // 2. Convert it. The Cluster 6 fix wraps order-create + quote-update in
    //    one transaction. If the refactor broke the happy path, this 500s.
    const convert = await request.post(`${base}/api/quotes/${quote.id}/convert`, { data: wsBody });
    expect(convert.ok(), "convert must succeed").toBeTruthy();
    const converted = (await convert.json()) as { order: { id: string; orderNumber: number; status: string }, quote: { id: string; status: string; orderId: string } };

    // 3. Assert BOTH records landed in the right state — proves atomicity
    //    didn't drop either write.
    expect(converted.order.id, "order must have an id").toBeTruthy();
    expect(converted.order.orderNumber, "order must have a number").toBeGreaterThan(0);
    expect(converted.quote.status, "quote must be marked 'converted' in the SAME transaction").toBe("converted");
    expect(converted.quote.orderId, "quote must link to the new order id").toBe(converted.order.id);

    // 4. Double-convert is idempotent (Cluster D fix preserved).
    const reconversion = await request.post(`${base}/api/quotes/${quote.id}/convert`, { data: wsBody });
    expect(reconversion.ok(), "double-convert returns the existing order (idempotency)").toBeTruthy();
    const reconverted = (await reconversion.json()) as { alreadyConverted?: boolean; order: { id: string } };
    expect(reconverted.order.id, "double-convert returns the SAME order id").toBe(converted.order.id);
  });
});
