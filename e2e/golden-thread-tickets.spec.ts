/**
 * 2026-07-21 — Golden Thread test: Tickets.
 *
 * Math layer is already pinned by `golden:ticket-lifecycle`:
 *   - displayTicketStatus("open") === "Open"
 *   - displayTicketPriority("high") === "High"
 *   - displayTicketPriorityTone("high") === "warning"
 *
 * This test pins the API + UI layers to the SAME values.
 *
 * Golden numbers for this thread:
 *   - ticketNumber: 1 (the first manually-created ticket)
 *   - status: "open"  → displayLabel: "Open"
 *   - priority: "high" → displayLabel: "High" + tone "warning" (amber)
 *
 * If a future change breaks the ticket repo, the label map, OR the
 * Tickets screen rendering — exactly one of these layers screams.
 */
import { test, expect } from "@playwright/test";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel } from "./helpers/nav";
import { E2E_BASE_URL } from "./helpers/e2e-target";

const TICKETS_URL = "/api/tickets";
const GOLDEN_SUBJECT = "Golden thread ticket";

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

type Ticket = {
  id: string;
  ticketNumber: number;
  status: string;
  priority: string;
  subject: string;
  sourceChannel: string;
  type: string;
};

test.describe("Golden Thread — Tickets (API + UI; math pinned by golden:ticket-lifecycle)", () => {
  // === LAYER 2: API ===
  test("API: list returns the manually-created ticket with the golden values", async () => {
    // Ensure a ticket exists with our known shape.
    await api(TICKETS_URL, {
      method: "POST",
      body: JSON.stringify({
        subject: GOLDEN_SUBJECT,
        description: "Golden thread fixture",
        type: "complaint",
        priority: "high",
        sourceChannel: "manual",
      }),
    });

    const list = await api<Ticket[]>(TICKETS_URL);
    expect(list.length, "list should have at least 1 ticket").toBeGreaterThan(0);

    const ours = list.find((t) => t.subject === GOLDEN_SUBJECT);
    expect(ours, "our golden-thread ticket should be in the list").toBeDefined();
    expect(ours!.priority, "priority field should be 'high'").toBe("high");
    expect(ours!.status, "status field should be 'open' (default for a new ticket)").toBe("open");
    expect(ours!.sourceChannel, "sourceChannel should be 'manual'").toBe("manual");
    expect(typeof ours!.ticketNumber, "ticketNumber should be a number").toBe("number");
  });

  test("API: status transition persists (open → in_progress)", async () => {
    const created = await api<Ticket>(TICKETS_URL, {
      method: "POST",
      body: JSON.stringify({
        subject: `${GOLDEN_SUBJECT} — transition`,
        description: "transition test",
        type: "question",
        priority: "medium",
        sourceChannel: "manual",
      }),
    });
    expect(created.status, "newly created ticket should be 'open'").toBe("open");

    // Move to in_progress via the API.
    const updated = await api<Ticket>(`/api/tickets/${created.id}/status`, {
      method: "POST",
      body: JSON.stringify({ toStatus: "in_progress", actorType: "owner" }),
    });
    expect(updated.status, "after POST status, ticket should be 'in_progress'").toBe("in_progress");

    // GET by id should reflect the persisted state.
    const refetched = await api<Ticket | undefined>(`/api/tickets/${created.id}`);
    expect(refetched?.status, "GET should reflect the persisted 'in_progress'").toBe("in_progress");
  });

  // === LAYER 3: UI (Playwright) — same golden values on screen ===
  test("UI: ticket shows '#N' number, 'Open' status, 'High' priority badges", async ({ page }) => {
    // Seed a ticket first so the screen has something to render.
    const created = await api<Ticket>(TICKETS_URL, {
      method: "POST",
      body: JSON.stringify({
        subject: `${GOLDEN_SUBJECT} — UI`,
        description: "UI rendering test",
        type: "complaint",
        priority: "high",
        sourceChannel: "manual",
      }),
    });

    await loginDemo(page);
    await openTabByLabel(page, "Tickets");
    await page.waitForTimeout(2000);

    // The ticket row should appear with its number.
    const ticketRow = page.getByText(new RegExp(`#${created.ticketNumber} .*${GOLDEN_SUBJECT} — UI`));
    await expect(ticketRow.first(), "ticket row should render with the golden ticketNumber").toBeVisible({ timeout: 10_000 });

    // The status badge for THIS ticket should show "Open" — the same
    // label displayTicketStatus("open") returns in the math golden test.
    // The priority badge should show "High" — same as displayTicketPriority("high").
    const row = page.locator("li").filter({ hasText: `${GOLDEN_SUBJECT} — UI` }).first();
    await expect(row.getByText(/^Open$/)).toBeVisible();
    await expect(row.getByText(/^High$/)).toBeVisible();
  });
});
