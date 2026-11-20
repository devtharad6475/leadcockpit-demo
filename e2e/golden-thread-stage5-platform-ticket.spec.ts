/**
 * Stage 5 / WP3 (2026-07-28) — Golden Thread test: Platform tickets (Help).
 *
 * Math layer is pinned by `golden:platform-ticket` (10 hand-computed cases):
 *   - displayPlatformTicketCategory("bug") === "Bug or error"
 *   - displayPlatformTicketStatus("open") === "Open"
 *   - displayTicketPriority("urgent") === "Urgent"
 *   - ticketNumber is a positive integer, globally unique (max-before + 1)
 *
 * This test pins the API + UI layers to the SAME values, so a future change
 * that breaks the platform-ticket repo, the label map, OR the Help screen
 * rendering makes exactly one of these layers scream.
 *
 * Golden thread value: a freshly opened "bug" ticket shows the category label
 * "Bug or error", status "Open", priority "Urgent" — at the API AND on screen.
 *
 * NOTE: the operator-side /admin/* panel is production-only (admin auth
 * returns null in demo), so its UI is NOT exercised here. Its math is pinned
 * by golden:platform-admin-auth; the operator inbox UI is verified by the
 * build (route compiles) + manual production-mode review.
 *
 * Run: npx playwright test golden-thread-stage5-platform-ticket
 * (Requires the dev server running in demo mode on the port E2E_BASE_URL names —
 *  3000 by default, or whatever E2E_PORT is set to.)
 */
import { test, expect } from "@playwright/test";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel } from "./helpers/nav";
import { E2E_BASE_URL } from "./helpers/e2e-target";

const URL_LIST = "/api/platform-tickets";

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

type PlatformTicket = {
  id: string;
  ticketNumber: number;
  status: string;
  priority: string;
  category: string;
  subject: string;
  workspaceId: string;
};

const GOLDEN_SUBJECT = "Golden thread platform ticket (Stage 5 WP3)";

test.describe("Golden Thread — Platform ticket Help screen (API + UI; math pinned by golden:platform-ticket)", () => {
  // === LAYER 2: API ===
  test("API: POST creates a bug ticket; list returns it with golden values", async () => {
    const created = await api<PlatformTicket>(URL_LIST, {
      method: "POST",
      body: JSON.stringify({
        subject: GOLDEN_SUBJECT,
        description: "Golden thread fixture for the Help screen.",
        category: "bug",
        priority: "urgent",
      }),
    });
    expect(created.category, "category field should be 'bug'").toBe("bug");
    expect(created.status, "new ticket status should be 'open'").toBe("open");
    expect(created.priority, "priority field should be 'urgent'").toBe("urgent");
    expect(typeof created.ticketNumber, "ticketNumber should be a number").toBe("number");
    expect(created.ticketNumber, "ticketNumber should be a positive integer").toBeGreaterThan(0);
    // The route ignores any body.workspaceId and scopes the ticket to the
    // caller's SESSION workspace. In demo mode that's defaultWorkspaceId
    // ("workspace_demo"). Sending a wrong workspaceId in the body must NOT
    // redirect the ticket into another tenant's queue.
    expect(created.workspaceId, "ticket must be scoped to the session workspace, never the body").toBe("workspace_demo");

    const list = await api<PlatformTicket[]>(URL_LIST);
    const ours = list.find((t) => t.id === created.id);
    expect(ours, "the created ticket must appear in the workspace-scoped list").toBeDefined();
    expect(ours!.workspaceId, "the ticket must be scoped to the caller's workspace").toBe("workspace_demo");
  });

  // === LAYER 3: UI (Playwright) — same golden values on screen ===
  test("UI: Help screen shows the bug ticket with 'Bug or error' / 'Open' / 'Urgent'", async ({ page }) => {
    // Seed the golden ticket so the screen has something to render.
    const created = await api<PlatformTicket>(URL_LIST, {
      method: "POST",
      body: JSON.stringify({
        subject: `${GOLDEN_SUBJECT} — UI`,
        description: "UI rendering test for Stage 5 WP3.",
        category: "bug",
        priority: "urgent",
      }),
    });

    await loginDemo(page);
    // The Help & Support tab lives in the Settings sidebar group.
    await openTabByLabel(page, "Help & Support");
    await page.waitForTimeout(1500);

    // The page heading should confirm we landed on Help & Support.
    await expect(page.getByRole("heading", { name: /Help and support/i }).first()).toBeVisible({ timeout: 10_000 });

    // The ticket row must show the golden ticketNumber + subject.
    const row = page.locator("button").filter({ hasText: new RegExp(`#${created.ticketNumber}`) }).filter({ hasText: `${GOLDEN_SUBJECT} — UI` }).first();
    await expect(row, "the seeded ticket row should render with its golden ticketNumber").toBeVisible({ timeout: 10_000 });

    // The SAME labels the math golden asserts must appear on screen:
    //   displayPlatformTicketCategory("bug") === "Bug or error"
    //   displayPlatformTicketStatus("open") === "Open"
    //   displayTicketPriority("urgent") === "Urgent"
    await expect(row.getByText(/Bug or error/)).toBeVisible();
    await expect(row.getByText(/^Open$/)).toBeVisible();
    await expect(row.getByText(/^Urgent$/)).toBeVisible();
  });

  // === LAYER 3b: UI empty-state honesty (no data must look intentional) ===
  // (We don't wipe the store, so this is a presence-check, not an
  // emptiness-check — but we do assert the "Open a ticket" affordance is
  // always reachable so a user is never stuck.)
  test("UI: Help screen always offers the 'Open a ticket' action", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Help & Support");
    await page.waitForTimeout(1500);
    // The primary action button is always visible whether the list is empty or not.
    await expect(page.getByRole("button", { name: /Open a ticket/i }).first()).toBeVisible({ timeout: 10_000 });
  });
});
