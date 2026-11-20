/**
 * 2026-07-21 — Golden Thread test: Orders + Quotes (Commercial).
 *
 * Math layer is pinned by `golden:order-cancel`:
 *   - createOrderDirect with [qty=10, unitPrice=450] → grandTotal = 4500
 *   - convertQuoteToOrder snapshots line items at quote prices
 *   - cancelOrder: nothing-shipped → "cancelled"; delivered → throws
 *
 * This test pins the API + UI to the SAME grandTotal (4500) and the
 * SAME status transitions.
 *
 * Golden numbers for this thread:
 *   - grandTotal: 4500  (10 × 450 = 4500; rounded)
 *   - lineTotal: 4500   (same; single line item)
 *   - quote status after convert: "converted"
 *   - order status after cancel: "cancelled"
 *
 * If a future change breaks OrderService, JsonOrderRepository, the API
 * glue, OR the Commercial screen rendering — exactly one screams.
 */
import { test, expect } from "@playwright/test";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel } from "./helpers/nav";
import { E2E_BASE_URL } from "./helpers/e2e-target";

const ORDERS_URL = "/api/orders";
const QUOTES_URL = "/api/quotes";

async function loginDemo(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: /Continue in Demo Mode/i }).click();
  // 2026-08-19 — was an <h1> reading "LeadCockpit". The 2026-08-17 nav redesign
  // moved that string into the sidebar brand (not a heading), so this matched
  // nothing and every test in this file failed at login. See e2e/helpers/login.ts.
  await expectAppShell(page);
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${E2E_BASE_URL}${url}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
    cache: "no-store",
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`API ${url} failed: ${res.status} ${JSON.stringify(payload)}`);
  return payload as T;
}

type Lead = { id: string };
type Order = {
  id: string;
  orderNumber: number;
  status: string;
  grandTotal: number;
  currencyCode: string;
  lineItems: Array<{ quantity: number; unitPrice: number; lineTotal: number }>;
  origin: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelReason?: string;
};
type Quote = {
  id: string;
  quoteNumber: number;
  status: string;
  grandTotal: number;
  lineItems: Array<{ quantity: number; unitPrice: number; lineTotal: number }>;
};

async function getDemoLeadId(): Promise<string> {
  const leads = await api<Lead[]>("/api/leads");
  if (!leads.length) throw new Error("No leads in demo workspace — seed first");
  return leads[0].id;
}

// 10 × 450 = 4500 (the golden number for this thread).
const GOLDEN_LINE_ITEMS = [
  { id: "li_gt1", productName: "Zari Thread", quantity: 10, unit: "kg", unitPrice: 450, currencyCode: "INR", lineTotal: 4500 },
];
const GOLDEN_GRAND_TOTAL = 4500;

test.describe("Golden Thread — Orders + Quotes (API + UI; math pinned by golden:order-cancel)", () => {
  // === LAYER 2: API — Orders ===
  test("API: POST /orders with qty=10 × ₹450 returns grandTotal=4500", async () => {
    const leadId = await getDemoLeadId();
    const order = await api<Order>(ORDERS_URL, {
      method: "POST",
      body: JSON.stringify({
        leadId,
        lineItems: GOLDEN_LINE_ITEMS,
        currencyCode: "INR",
      }),
    });
    expect(order.grandTotal, `grandTotal should be ${GOLDEN_GRAND_TOTAL} (10 × 450)`).toBe(GOLDEN_GRAND_TOTAL);
    expect(order.lineItems[0].lineTotal, "line item lineTotal should be 4500").toBe(4500);
    expect(order.status, "newly created order should be 'draft'").toBe("draft");
    expect(order.origin, "direct creation should have origin 'direct'").toBe("direct");
  });

  test("API: order persists in list with the same grandTotal", async () => {
    const leadId = await getDemoLeadId();
    const created = await api<Order>(ORDERS_URL, {
      method: "POST",
      body: JSON.stringify({ leadId, lineItems: GOLDEN_LINE_ITEMS, currencyCode: "INR" }),
    });
    const list = await api<Order[]>(ORDERS_URL);
    const ours = list.find((o) => o.id === created.id);
    expect(ours, "created order should be in the list").toBeDefined();
    expect(ours!.grandTotal, "list should show the same grandTotal").toBe(GOLDEN_GRAND_TOTAL);
  });

  test("API: cancel order (status=draft) → status becomes 'cancelled'", async () => {
    const leadId = await getDemoLeadId();
    const created = await api<Order>(ORDERS_URL, {
      method: "POST",
      body: JSON.stringify({ leadId, lineItems: GOLDEN_LINE_ITEMS, currencyCode: "INR" }),
    });
    const cancelled = await api<Order>(`/api/orders/${created.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ actor: "owner", reason: "Golden thread cancel test" }),
    });
    expect(cancelled.status, "cancelled order should have status 'cancelled'").toBe("cancelled");
    expect(cancelled.cancelledAt, "cancelledAt should be set").toBeTruthy();
  });

  // === LAYER 2: API — Quotes + convert ===
  test("API: quote → convert → order has snapshot prices; quote status 'converted'", async () => {
    const leadId = await getDemoLeadId();
    const quote = await api<Quote>(QUOTES_URL, {
      method: "POST",
      body: JSON.stringify({
        leadId,
        lineItems: GOLDEN_LINE_ITEMS,
        currencyCode: "INR",
        status: "sent", // ignored since 2026-09-26: a new quote is always a draft
      }),
    });
    expect(quote.grandTotal, "newly created quote should have grandTotal=4500").toBe(GOLDEN_GRAND_TOTAL);
    expect(quote.status, "a new quote starts as a draft, whatever the request says").toBe("draft");
    const sent = await api<Quote>(`/api/quotes/${quote.id}/status`, { method: "POST", body: JSON.stringify({ toStatus: "sent" }) });
    expect(sent.status, "the quote is sent through its own step").toBe("sent");

    const converted = await api<{ order: Order; quote: Quote }>(`/api/quotes/${quote.id}/convert`, { method: "POST" });
    expect(converted.order.grandTotal, "converted order should preserve the quote's grandTotal").toBe(GOLDEN_GRAND_TOTAL);
    expect(converted.order.lineItems[0].unitPrice, "converted order should snapshot the quote's unitPrice").toBe(450);
    expect(converted.quote.status, "quote status should be 'converted' after conversion").toBe("converted");
  });

  // === LAYER 3: UI (Playwright) — same golden values on screen ===
  test("UI: Commercial screen shows the order with ₹4,500 total", async ({ page }) => {
    // Seed an order via API.
    const leadId = await getDemoLeadId();
    const created = await api<Order>(ORDERS_URL, {
      method: "POST",
      body: JSON.stringify({ leadId, lineItems: GOLDEN_LINE_ITEMS, currencyCode: "INR" }),
    });

    await loginDemo(page);
    await openTabByLabel(page, "Commercial");
    await page.waitForTimeout(2000);

    // The Commercial Orders tab should show the order row.
    const orderRow = page.locator("tr").filter({ hasText: new RegExp(`#${created.orderNumber}`) });
    await expect(orderRow.first(), "order row should appear in the Orders tab").toBeVisible({ timeout: 10_000 });

    // The row should show the SAME golden total: ₹4,500.
    // (toLocaleString('en-IN') for 4500 = "4,500".)
    await expect(orderRow.first()).toContainText("4,500");
  });
});
