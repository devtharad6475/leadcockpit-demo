/**
 * 2026-07-21 (Cluster A fix B3, session 16) — Golden Thread test:
 * Convert-to-Ticket endpoints.
 *
 * Math layer is pinned by `golden:convert-to-ticket-wiring`:
 *   - convertToTicket(UnknownQuestion) → Ticket with sourceEntityType=
 *     "unknown_question", sourceEntityId=source.id.
 *   - Double-convert throws.
 *
 * This test pins the API layer to the SAME rule. The same source.id that
 * goes in must come out as ticket.sourceEntityId.
 *
 * Golden numbers for this thread:
 *   - sourceEntityType: "unknown_question"
 *   - sourceEntityId:   the source UnknownQuestion's id
 *   - status:           "open"
 *   - HTTP 409 on double-convert (NOT 200, NOT 422)
 */
import { test, expect } from "@playwright/test";
import { E2E_BASE_URL } from "./helpers/e2e-target";

async function apiRaw(url: string, options?: RequestInit) {
  const res = await fetch(`${E2E_BASE_URL}${url}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
    cache: "no-store",
  });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, payload };
}

type UnknownQuestion = {
  id: string;
  questionText: string;
  status: string;
};

type Ticket = {
  id: string;
  sourceEntityType?: string;
  sourceEntityId?: string;
  status: string;
};

test.describe("Golden Thread — Convert-to-Ticket (API; math pinned by golden:convert-to-ticket-wiring)", () => {
  test("API: POST /unknown-questions/:id/convert creates a linked Ticket; double-convert returns 409", async () => {
    // Step 1 — find an existing UnknownQuestion (created by the WhatsApp
    // engine during demo data flow). The demo data normally has at least
    // one. If not, skip rather than fail — the math layer is separately
    // pinned by golden:convert-to-ticket-wiring.
    const listRes = await apiRaw("/api/unknown-questions");
    const list = (listRes.payload as unknown as { id: string }[]) || [];
    test.skip(!Array.isArray(list) || list.length === 0, "No UnknownQuestions in demo data; skipping");
    const source = list[0] as { id: string };

    // If this one is already converted (from a prior test run), the first
    // convert will return 409. We treat that as: skip the "creates" half
    // but still assert the 409 contract (which is the rule being pinned).
    const convertRes1 = await apiRaw(`/api/unknown-questions/${source.id}/convert`, {
      method: "POST",
      body: JSON.stringify({ type: "question", priority: "medium" }),
    });
    if (convertRes1.status === 200) {
      const ticket1 = convertRes1.payload as unknown as Ticket;
      expect(ticket1.id, "converted ticket must have an id").toBeTruthy();
      expect(ticket1.sourceEntityType, "Golden Thread: sourceEntityType must be 'unknown_question'").toBe("unknown_question");
      expect(ticket1.sourceEntityId, "Golden Thread: sourceEntityId must match the source id").toBe(source.id);
      expect(ticket1.status, "Golden Thread: new ticket status must be 'open'").toBe("open");
    } else {
      // Already converted by a prior run — the contract we still pin is
      // that re-converting returns 409 (the rule the math layer pins).
      expect([409], "first convert returned a non-200; must be 409 Conflict").toContain(convertRes1.status);
    }

    // Step 2 — double-convert must return 409 Conflict (idempotent refusal).
    const convertRes2 = await apiRaw(`/api/unknown-questions/${source.id}/convert`, {
      method: "POST",
      body: JSON.stringify({ type: "question", priority: "medium" }),
    });
    expect(convertRes2.status, "double-convert must return 409 (Conflict)").toBe(409);
  });
});
