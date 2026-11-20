/**
 * Break test, part 2 (2026-09-26): the same action fired several times at the
 * same instant — a double-click, two tabs, a retry. Counts what was created.
 *
 *   BREAK_BASE_URL=http://127.0.0.1:3020 npx tsx scripts/probes/break-races.ts
 *
 * Only actions that never reach a customer are fired. Creates one test lead
 * and quote (clearly named), which stay in that server's data.
 */
const RACE_BASE = process.env.BREAK_BASE_URL || "http://127.0.0.1:3020";
const H = { "content-type": "application/json", origin: RACE_BASE };
const call = async (path: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${RACE_BASE}/api/${path}`, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json: json as Record<string, unknown> };
};
const TIMES = 5;

(async () => {
  const health = (await call("health")).json as { persistenceProvider?: string };
  console.log(`Server ${RACE_BASE} on ${health.persistenceProvider}. Each action fired ${TIMES} times at once.\n`);
  const results: string[] = [];

  // 1. Quote → order.
  const lead = await call("leads/manual", "POST", { companyName: `Race test ${Date.now()}`, email: `race.${Date.now()}@example.invalid` });
  const leadId = String(lead.json.id);
  const quote = await call("quotes", "POST", { leadId, lineItems: [{ productName: "Race test item", quantity: 1, unitPrice: 100 }] });
  const quoteId = String((quote.json.quote as { id?: string } | undefined)?.id || quote.json.id);
  await call(`quotes/${quoteId}/status`, "POST", { toStatus: "sent" });
  const converts = await Promise.all(Array.from({ length: TIMES }, () => call(`quotes/${quoteId}/convert`, "POST", {})));
  const orders = ((await call("orders")).json as unknown as Array<{ quoteId?: string }> | { orders?: Array<{ quoteId?: string }> });
  const list = Array.isArray(orders) ? orders : orders.orders || [];
  const made = list.filter((order) => order.quoteId === quoteId).length;
  results.push(`${made === 1 ? "OK  " : "FAIL"} quote → order: ${made} order(s) created (answers: ${converts.map((c) => c.status).join(", ")})`);

  // 2. New conversation — a double-click makes two empty chats?
  const before = ((await call("copilot/conversations?list=1")).json as unknown as unknown[]).length;
  await Promise.all(Array.from({ length: TIMES }, () => call("copilot/conversations", "POST", {})));
  const after = ((await call("copilot/conversations?list=1")).json as unknown as unknown[]).length;
  results.push(`${after - before <= 1 ? "OK  " : "NOTE"} new conversation: ${after - before} created by ${TIMES} clicks`);

  // 3. Lead approve — the audit trail and status after a burst.
  const approves = await Promise.all(Array.from({ length: TIMES }, () => call(`leads/${leadId}/approve`, "POST", {})));
  results.push(`INFO lead approve: answers ${approves.map((a) => a.status).join(", ")}`);

  // 4. Turn one customer question into a ticket, five times at once.
  const questions = (await call("unknown-questions")).json as unknown as Array<{ id: string; convertedToTicketId?: string }> | { items?: Array<{ id: string; convertedToTicketId?: string }> };
  const open = (Array.isArray(questions) ? questions : questions.items || []).find((q) => !q.convertedToTicketId);
  if (open) {
    const converts = await Promise.all(Array.from({ length: TIMES }, () => call(`unknown-questions/${open.id}/convert`, "POST", {})));
    const tickets = (await call("tickets")).json as unknown as Array<{ sourceEntityId?: string }> | { tickets?: Array<{ sourceEntityId?: string }> };
    const madeTickets = (Array.isArray(tickets) ? tickets : tickets.tickets || []).filter((t) => t.sourceEntityId === open.id).length;
    results.push(`${madeTickets === 1 ? "OK  " : "FAIL"} question → ticket: ${madeTickets} ticket(s) (answers: ${converts.map((c) => c.status).join(", ")})`);
  } else {
    results.push("SKIP question → ticket: no unconverted question in this data");
  }

  for (const line of results) console.log(line);
})().catch((error) => { console.error(error); process.exit(1); });

export {};
