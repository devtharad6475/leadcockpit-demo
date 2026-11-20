/**
 * Break test, part 7 (2026-09-26): quotes and orders with numbers no real
 * quote has. Each must be refused with a readable answer (4xx), never saved.
 * Against the throwaway server ("leadgen-break", port 3020).
 *
 *   BREAK_BASE_URL=http://127.0.0.1:3020 npx tsx scripts/probes/break-money.ts
 */
const BASE = process.env.BREAK_BASE_URL || "http://127.0.0.1:3020";
const H = { "content-type": "application/json", origin: BASE };
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${BASE}/api/${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text: text.slice(0, 200).replace(/\s+/g, " ") };
};

(async () => {
  const lead = await post("leads/manual", { companyName: `Money test ${Date.now()}`, email: `money.${Date.now()}@break.example` });
  const leadId = String(lead.json.id);
  const line = (over: Record<string, unknown>) => ({ leadId, lineItems: [{ productName: "Zari thread", quantity: 10, unitPrice: 250, ...over }] });
  const bad: Array<[string, unknown]> = [
    ["negative quantity", line({ quantity: -5 })],
    ["zero quantity", line({ quantity: 0 })],
    ["negative price", line({ unitPrice: -250 })],
    ["quantity as text", line({ quantity: "ten" })],
    ["price is not a number", line({ unitPrice: "NaN" })],
    ["infinite quantity", line({ quantity: 1e309 })],
    ["absurd quantity (10^15)", line({ quantity: 1e15 })],
    ["no line items", { leadId, lineItems: [] }],
    ["line with no product name", line({ productName: "" })],
    ["a lead that does not exist", { leadId: "lead_nope", lineItems: [{ productName: "x", quantity: 1, unitPrice: 1 }] }],
  ];
  let failed = 0;
  for (const [label, body] of bad) {
    const r = await post("quotes", body);
    const refused = r.status >= 400 && r.status < 500;
    if (!refused) failed++;
    console.log(`${refused ? "OK  " : "FAIL"} quote with ${label} → ${r.status} ${refused ? "" : r.text}`);
  }
  // Fields a quote does not have (discount, tax, a chosen status) are ignored,
  // never applied: the total stays 10 × 250 and the quote starts as a draft.
  const good = await post("quotes", { ...line({ discountPercent: 150, taxPercent: 400 }), status: "accepted" });
  const total = (good.json as { grandTotal?: number }).grandTotal;
  const status = (good.json as { status?: string }).status;
  const fine = good.status === 200 && total === 2500 && status === "draft";
  console.log(`${fine ? "OK  " : "FAIL"} a normal quote (10 × ₹250) with made-up discount, tax and status → ${good.status}, total ${total}, ${status}`);
  if (!fine) failed++;
  console.log(`\n${failed ? `${failed} FAILED` : "ALL OK"}`);
})().catch((error) => { console.error(error); process.exit(1); });

export {};
