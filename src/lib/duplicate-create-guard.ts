/**
 * Treat the same "create" sent twice within a few seconds as ONE create
 * (2026-09-27, sector review M6).
 *
 * A double-click on "Create order" (or "Create quote") sent two identical
 * requests and made two orders with consecutive numbers. The second request
 * now gets the first one's result instead of making another. "The same" is
 * decided by the caller's key (for orders and quotes: workspace, lead,
 * currency, status and the exact lines), so two genuinely different orders
 * are never merged, and an identical order made on purpose more than
 * `windowMs` later is made as normal.
 *
 * The first request's promise is stored before it resolves, so two requests
 * arriving together share it. A failed create is forgotten at once, so the
 * retry after an error is a real retry. Like one-at-a-time.ts this holds
 * within one server process, which is how the app runs today.
 */
const recent = new Map<string, { at: number; result: Promise<unknown> }>();

export const DUPLICATE_CREATE_WINDOW_MS = 10_000;

export async function onceWithin<T>(
  key: string,
  work: () => Promise<T>,
  windowMs: number = DUPLICATE_CREATE_WINDOW_MS,
): Promise<{ value: T; duplicate: boolean }> {
  const now = Date.now();
  for (const [k, entry] of recent) if (now - entry.at > windowMs) recent.delete(k);
  const hit = recent.get(key);
  if (hit) return { value: (await hit.result) as T, duplicate: true };
  const result = work();
  const entry = { at: now, result };
  recent.set(key, entry);
  try {
    return { value: await result, duplicate: false };
  } catch (error) {
    if (recent.get(key) === entry) recent.delete(key);
    throw error;
  }
}

/** The key for a create request: same lead, currency, status and lines → same key. */
export function createRequestKey(
  kind: "order" | "quote",
  workspaceId: string,
  input: {
    leadId?: string;
    currencyCode?: string;
    status?: string;
    notes?: string;
    validityNote?: string;
    sourceReplyId?: string;
    sourceInteractionId?: string;
    lineItems: ReadonlyArray<{ productId?: string; productVariantId?: string; productName?: string; quantity: number; unit?: string; unitPrice: number; currencyCode?: string; notes?: string }>;
  },
): string {
  const lines = input.lineItems.map((li) => [li.productId || "", li.productVariantId || "", (li.productName || "").trim(), li.quantity, li.unit || "", li.unitPrice, li.currencyCode || "", li.notes || ""]);
  return JSON.stringify([kind, workspaceId, input.leadId || "", input.currencyCode || "", input.status || "", input.notes || "", input.validityNote || "", input.sourceReplyId || "", input.sourceInteractionId || "", lines]);
}
