/**
 * Stage 5 / WP2 (2026-07-28) — Golden Thread test: Operator admin panel.
 *
 * Math layer is pinned by `golden:platform-admin-ops` (13 hand-computed cases):
 *   - suspendWorkspace → status=suspended, login blocked, data intact
 *   - impersonation: operator-only, 15-min TTL, one-at-a-time, owner-blocked
 *   - password reset: token hashed, 24h expiry, session killed, no token leak
 *   - feature flags: 4 fixed keys, default-on, operator-only toggle
 *
 * This test pins the API + UI layers:
 *   LAYER 2 (API): the /admin/* routes are GATED — an unauthenticated request
 *     to /admin/workspaces, /admin/health, /admin/feature-flags returns 401
 *     (the platform-admin session is required). This proves the RBAC chokepoint
 *     is wired at the HTTP layer (the UI hiding a button is NOT security).
 *   LAYER 3 (UI): the /admin page renders the login gate in demo mode (no
 *     platform admin bootstrapped) — showing either the login form or the
 *     "no admin account yet / bootstrap" hint. It must NOT crash, NOT show a
 *     white screen, NOT leak any workspace data before auth.
 *
 * Why not exercise the live operator console: it's production-only (admin auth
 * returns null in demo). Its math is pinned by golden:platform-admin-ops; the
 * HTTP wiring (RBAC gate) is pinned here; the UI rendering is verified by the
 * build (route compiles) + this gate test + manual production-mode review.
 *
 * SACRED no-auto-outreach: this test sends NO email / WhatsApp. The
 * password-reset path is exercised only at the service layer (smoke + golden),
 * never with a real provider call here.
 *
 * Run: npx playwright test golden-thread-stage5-admin
 * (Requires the dev server running in demo mode on the port E2E_BASE_URL names —
 *  3000 by default, or whatever E2E_PORT is set to.)
 */
import { test, expect } from "@playwright/test";
import { E2E_BASE_URL } from "./helpers/e2e-target";

// ─── LAYER 2: API RBAC gate (unauthenticated → 401) ─────────────────────────

test.describe("Stage 5 WP2 — admin API RBAC gate", () => {
  for (const endpoint of [
    "/api/admin/workspaces",
    "/api/admin/workspaces/list",
    "/api/admin/health",
    "/api/admin/feature-flags",
    "/api/admin/audit-logs",
  ]) {
    test(`unauthenticated GET ${endpoint} → 401 (RBAC gate wired at HTTP layer)`, async () => {
      const res = await fetch(`${E2E_BASE_URL}${endpoint}`, { cache: "no-store" });
      // The admin routes require a platform-admin session. Without one, the
      // response must NOT be 200 (no data leak before auth). Accept 401 or 403.
      expect([401, 403]).toContain(res.status);
      // And the body must not contain workspace data.
      const body = await res.text();
      expect(body).not.toMatch(/workspace_demo|user_owner|"workspaces"\s*:/);
    });
  }

  test("unauthenticated POST /api/admin/workspaces/:id/suspend → 401/403 (no kill-switch without auth)", async () => {
    const res = await fetch(`${E2E_BASE_URL}/api/admin/workspaces/workspace_demo/suspend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "unauthorized attempt" }),
      cache: "no-store",
    });
    expect([401, 403]).toContain(res.status);
  });

  test("unauthenticated POST /api/admin/feature-flags → 401/403 (no flag toggle without auth)", async () => {
    const res = await fetch(`${E2E_BASE_URL}/api/admin/feature-flags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "ai_usage_enabled", enabled: false }),
      cache: "no-store",
    });
    expect([401, 403]).toContain(res.status);
  });
});

// ─── LAYER 3: UI gate (/admin renders the login screen in demo) ─────────────

test.describe("Stage 5 WP2 — /admin UI gate (demo mode)", () => {
  test("/admin page renders without crashing + shows the admin login gate", async ({ page }) => {
    await page.goto("/admin");

    // Must NOT be a white screen / crash. The page renders either the login
    // form OR the "no admin account yet" bootstrap hint (depends on whether an
    // admin was bootstrapped in this env). Either way, the admin identity
    // header must be present.
    await expect(page.getByRole("heading", { name: /LeadCockpit Admin/i })).toBeVisible({ timeout: 15_000 });

    // Must NOT leak workspace data before auth. The body should not contain
    // tenant rows / user lists (those only appear AFTER operator login).
    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toMatch(/user_owner|workspace_demo/i);

    // No console errors (build-right Ironclad Gate #2).
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.waitForLoadState("networkidle");
    // Allow benign Next.js dev warnings; fail on real errors.
    const realErrors = errors.filter((e) => !e.includes("Download the React DevTools"));
    expect(realErrors).toEqual([]);
  });
});
