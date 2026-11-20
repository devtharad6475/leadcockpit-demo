import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import { loginDemo } from "./helpers/login";
import { openTabByLabel } from "./helpers/nav";
import { restoreDemoData, waitForServerQuiescent } from "./helpers/demo-data-snapshot";
import { readAppData as readSnapshot } from "./helpers/app-data";
import type { AppData, Quote, Order } from "@/lib/types";
import { extractPdfText } from '@/lib/pdf-text';

const data = (): AppData => readSnapshot();
const headers = { cookie: "lc_demo=1" };
const proof = "docs/system-workflow/readiness-proof";
test.beforeEach(async () => { await waitForServerQuiescent(); restoreDemoData(); await waitForServerQuiescent(); });
test.afterEach(async ({ page }) => { await page.close(); await waitForServerQuiescent(); });

async function showOrder(page: Page, order: Order) {
  await page.getByRole("button", { name: `View details for order #${order.orderNumber}`, exact: true }).click();
  await expect(page.getByRole("dialog", { name: `Order #${order.orderNumber}`, exact: true })).toBeVisible();
}

test('multilingual quote downloads with readable text and unsupported text keeps the saved quote', async ({ page, request }) => {
  const product = 'श्री व्यापार क्षेत्र / ગુજરાતી ગુણવત્તા / Café';
  const response = await request.post('/api/quotes', { headers, data: { leadId: data().leads[0].id, lineItems: [{ productName: product, quantity: 2, unitPrice: 123.45 }], notes: 'विशेष विवरण: ' + 'LONGREFERENCE'.repeat(25) } });
  expect(response.ok()).toBe(true); const quote: Quote = await response.json();
  await loginDemo(page); await openTabByLabel(page, 'Quotes & Orders'); await page.getByRole('tab', { name: /Quotes/ }).click();
  await page.getByRole('button', { name: `View details for quote #${quote.quoteNumber}`, exact: true }).click();
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download quote PDF', exact: true }).click();
  const download = await event; expect(await download.failure()).toBe(null);
  const file = `${proof}/browser-multilingual-quote.pdf`; await download.saveAs(file);
  const text = await extractPdfText(fs.readFileSync(file));
  expect(text).toContain(product); expect(text).toContain('246.90'); expect(text).toContain('विशेष विवरण');
  await page.reload(); await openTabByLabel(page, 'Quotes & Orders'); await page.getByRole('tab', { name: /Quotes/ }).click();
  await page.getByRole('button', { name: `View details for quote #${quote.quoteNumber}`, exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(product);
  const unsupportedResponse = await request.post('/api/quotes', { headers, data: { leadId: quote.leadId, lineItems: [{ productName: 'Unsupported 客户', quantity: 1, unitPrice: 10 }] } });
  expect(unsupportedResponse.ok()).toBe(true); const unsupported: Quote = await unsupportedResponse.json();
  await page.reload(); await openTabByLabel(page, 'Quotes & Orders'); await page.getByRole('tab', { name: /Quotes/ }).click();
  await page.getByRole('button', { name: `View details for quote #${unsupported.quoteNumber}`, exact: true }).click();
  const refusal = page.waitForResponse(result => result.url().endsWith(`/api/quotes/${unsupported.id}/generate-pdf`) && result.request().method() === 'POST');
  await page.getByRole('button', { name: 'Download quote PDF', exact: true }).click();
  expect((await refusal).ok()).toBe(false);
  await expect(page.getByRole('dialog', { name: `Quote #${unsupported.quoteNumber}`, exact: true }).getByText(/language or a symbol that is not supported yet/)).toBeVisible();
  expect(data().quotes?.find(row => row.id === unsupported.id)?.lineItems[0].productName).toBe('Unsupported 客户');
  await page.screenshot({ path: `${proof}/document-unsupported-language.png`, fullPage: true });
});

test("quote edit → downloaded customer document → one converted order survives refresh", async ({ page, request }) => {
  const response = await request.post("/api/quotes", { headers, data: { leadId: data().leads[0].id,
    lineItems: [{ productName: "Precision quote item", quantity: 3, unitPrice: 101.015 }], notes: "Original agreed offer" } });
  expect(response.ok()).toBe(true); const original: Quote = await response.json();
  await loginDemo(page); await openTabByLabel(page, "Quotes & Orders"); await page.getByRole("tab", { name: /Quotes/ }).click();
  await page.getByRole("button", { name: `View details for quote #${original.quoteNumber}`, exact: true }).click();
  await page.getByRole("button", { name: "Revise prices and quantities", exact: true }).click();
  let form = page.getByRole("dialog", { name: `Revise quote #${original.quoteNumber}`, exact: true });
  await form.getByLabel("Revised unit price for Precision quote item", { exact: true }).fill("12.345");
  await form.getByLabel("Revised quantity for Precision quote item", { exact: true }).fill("2");
  await expect(form).toContainText("Revised total: ₹24.69");
  await form.getByRole("button", { name: "Keep existing quote" }).click();
  expect(data().quotes?.find(quote => quote.id === original.id)?.status).toBe("draft");
  expect(data().quotes?.filter(quote => quote.supersedesQuoteId === original.id)).toHaveLength(0);
  await page.getByRole("button", { name: `More actions for quote #${original.quoteNumber}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Revise (replace with new quote)" }).click();
  form = page.getByRole("dialog", { name: `Revise quote #${original.quoteNumber}`, exact: true });
  await form.getByLabel("Revised quantity for Precision quote item", { exact: true }).fill("2");
  await form.getByLabel("Revised unit price for Precision quote item", { exact: true }).fill("12.345");
  const revisedResponse = page.waitForResponse(result => result.url().endsWith(`/api/quotes/${original.id}/revise`) && result.request().method() === "POST");
  await form.getByRole("button", { name: "Save revised quote", exact: true }).click();
  const revised = await revisedResponse; expect(revised.ok()).toBe(true); const { quote }: { quote: Quote } = await revised.json();
  expect(quote.grandTotal).toBe(24.69); expect(quote.supersedesQuoteId).toBe(original.id);
  expect(data().quotes?.find(item => item.id === original.id)?.grandTotal).toBe(303.05);
  await expect(page.getByRole("dialog", { name: `Quote #${quote.quoteNumber}`, exact: true })).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download quote PDF", exact: true }).click();
  const download = await downloadEvent; expect(await download.failure()).toBe(null);
  await download.saveAs(`${proof}/journey-commercial-quote.pdf`);
  expect(fs.readFileSync(`${proof}/journey-commercial-quote.pdf`).subarray(0, 5).toString()).toBe("%PDF-");
  await page.getByLabel("Update quote status").selectOption("sent");
  await expect(page.getByRole("dialog").getByText("Sent", { exact: true })).toBeVisible();
  await page.getByLabel("Update quote status").selectOption("accepted");
  await expect(page.getByRole("dialog").getByText("Accepted", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: /Close/ }).click();
  await page.getByRole("button", { name: `More actions for quote #${quote.quoteNumber}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Convert to order", exact: true }).click();
  const convertedResponse = page.waitForResponse(result => result.url().endsWith(`/api/quotes/${quote.id}/convert`));
  await page.getByRole("dialog", { name: "Convert this quote?" }).getByRole("button", { name: "Convert to order", exact: true }).click();
  const converted = await convertedResponse; expect(converted.ok()).toBe(true); const { order }: { order: Order } = await converted.json();
  await expect(page.getByRole("dialog", { name: `Order #${order.orderNumber}`, exact: true })).toContainText("₹24.69");
  expect(data().orders?.filter(item => item.quoteId === quote.id)).toHaveLength(1);
  await page.reload(); await openTabByLabel(page, "Quotes & Orders"); await showOrder(page, order);
  await expect(page.getByRole("dialog")).toContainText("₹24.69");
  await page.screenshot({ path: `${proof}/journey-commercial-converted.png`, fullPage: true });
});

test("item dispatch and cancellation → completed delivery → full repeat draft without inherited cancellations", async ({ page, request }) => {
  const response = await request.post("/api/orders", { headers, data: { leadId: data().leads[0].id, status: "confirmed",
    lineItems: [{ productName: "Main spool", quantity: 10, unitPrice: 100 }, { productName: "Fractional sample", quantity: 0.3, unitPrice: 100 }] } });
  expect(response.ok()).toBe(true); const original: Order = await response.json();
  await loginDemo(page); await openTabByLabel(page, "Quotes & Orders"); await showOrder(page, original);

  async function dispatch(main: string, sample: string) {
    await page.getByRole("button", { name: "Record shipment", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Record item shipment", exact: true });
    await form.getByLabel("Total shipped for Main spool", { exact: true }).fill(main);
    await form.getByLabel("Total shipped for Fractional sample", { exact: true }).fill(sample);
    const saved = page.waitForResponse(result => result.url().endsWith(`/api/orders/${original.id}/status`) && result.request().method() === "POST");
    await form.getByRole("button", { name: "Save shipped quantities" }).click(); expect((await saved).ok()).toBe(true);
    await expect(page.getByRole("dialog", { name: `Order #${original.orderNumber}`, exact: true })).toBeVisible();
  }
  async function cancel(main: string, sample: string, reason: string) {
    await page.getByRole("button", { name: "Cancel item quantities", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Cancel item quantities", exact: true });
    await form.getByLabel("Cancel quantity for Main spool", { exact: true }).fill(main);
    await form.getByLabel("Cancel quantity for Fractional sample", { exact: true }).fill(sample);
    await form.getByLabel("Reason for cancellation", { exact: true }).fill(reason);
    const saved = page.waitForResponse(result => result.url().endsWith(`/api/orders/${original.id}/cancel`));
    await form.getByRole("button", { name: "Confirm quantity cancellation" }).click(); expect((await saved).ok()).toBe(true);
    await expect(page.getByRole("dialog", { name: `Order #${original.orderNumber}`, exact: true })).toBeVisible();
  }
  await dispatch("2", "0.1"); await cancel("3", "0", "Customer reduced requirement");
  await dispatch("4", "0.2"); await cancel("1", "0.1", "Remaining sample not required");
  await expect(page.getByRole("dialog")).toContainText("₹620.00");
  await dispatch("6", "0.2");
  const delivered = page.waitForResponse(result => result.url().endsWith(`/api/orders/${original.id}/status`));
  await page.getByLabel("Advance order status").selectOption("delivered"); expect((await delivered).ok()).toBe(true);
  await expect(page.getByRole("dialog").getByText("Delivered", { exact: true })).toBeVisible();
  const stored = data().orders?.find(item => item.id === original.id);
  expect(stored).toBeDefined();
  if (!stored) throw new Error("Delivered order was not persisted");
  expect(stored.cancelledQuantityByLine?.[stored.lineItems[0].id]).toBe(4);
  expect(stored.shippedQuantityByLine?.[stored.lineItems[0].id]).toBe(6);
  expect(stored.grandTotal).toBe(620);
  await page.getByRole("button", { name: "Repeat order as draft", exact: true }).click();
  const repeatedResponse = page.waitForResponse(result => result.url().endsWith(`/api/orders/${original.id}/reorder`));
  await page.getByRole("dialog", { name: "Repeat this order?" }).getByRole("button", { name: "Create repeat draft" }).click();
  const repeated = await repeatedResponse; expect(repeated.ok()).toBe(true); const draft: Order = await repeated.json();
  expect(draft.status).toBe("draft"); expect(draft.grandTotal).toBe(1030); expect(draft.reorderedFromOrderId).toBe(original.id);
  expect(draft.lineItems.map(item => item.quantity)).toEqual([10, 0.3]); expect(draft.cancelledQuantityByLine).toBeUndefined();
  await expect(page.getByRole("dialog", { name: `Order #${draft.orderNumber}`, exact: true })).toContainText("₹1,030.00");
  await page.reload(); await openTabByLabel(page, "Quotes & Orders"); await showOrder(page, draft);
  await expect(page.getByRole("dialog")).toContainText("₹1,030.00");
  await page.screenshot({ path: `${proof}/journey-commercial-repeat.png`, fullPage: true });
});
