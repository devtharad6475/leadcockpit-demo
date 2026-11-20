/**
 * 2026-07-21 — Golden Thread test: Workspace kill-switch + insights.
 *
 * Per docs/UI-DESIGN.md M9 + the updated build-right Phase 3 (Golden
 * Thread Rule): the SAME hand-computed expected values must appear at
 * the math layer, the API layer, AND the screen layer.
 *
 * Golden numbers for this thread:
 *   KILL_SWITCH: After POST {autonomyKillSwitch: true}, GET returns
 *     {autonomyKillSwitch: true}. The state MUST persist across reads.
 *     After POST {autonomyKillSwitch: false}, GET returns false.
 *
 *   INSIGHTS: After POST {note: "Golden thread N"}, the list GET
 *     returns an array whose FIRST entry has payload.note === "Golden
 *     thread N" (reverse-chrono) and eventType === "insight_note".
 *
 *   UI: After toggling the kill-switch via the Workspace screen, the
 *     badge shows "ENGAGED — outreach paused". After adding an insight
 *     via the form, the note text appears in the insights list.
 *
 * These numbers are hand-computed: there's exactly ONE toggle field,
 * and reverse-chrono means index [0] is the most recent.
 */
import { test, expect } from "@playwright/test";
import { expectAppShell } from "./helpers/login";
import { openTabByLabel } from "./helpers/nav";
import { E2E_BASE_URL } from "./helpers/e2e-target";

const KILL_SWITCH_URL = "/api/workspace/kill-switch";
const INSIGHTS_URL = "/api/workspace/insights";
const GOLDEN_INSIGHT_NOTE = "Golden thread workspace test";

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

test.describe("Golden Thread — Workspace (math + API + UI)", () => {
  // === LAYER 2: API round-trip — kill-switch ===
  test("API: kill-switch state round-trips exactly", async () => {
    // Reset to false first (deterministic starting state).
    await api(KILL_SWITCH_URL, { method: "POST", body: JSON.stringify({ autonomyKillSwitch: false }) });
    const initial = await api<{ autonomyKillSwitch: boolean }>(KILL_SWITCH_URL);
    expect(initial.autonomyKillSwitch, "initial state should be false after reset").toBe(false);

    // Engage.
    const engaged = await api<{ autonomyKillSwitch: boolean }>(KILL_SWITCH_URL, {
      method: "POST",
      body: JSON.stringify({ autonomyKillSwitch: true, actorUserId: "golden-thread-test" }),
    });
    expect(engaged.autonomyKillSwitch, "POST engage should return true").toBe(true);

    // GET reflects the persisted state.
    const afterEngage = await api<{ autonomyKillSwitch: boolean }>(KILL_SWITCH_URL);
    expect(afterEngage.autonomyKillSwitch, "GET after engage should be true").toBe(true);

    // Disengage.
    const disengaged = await api<{ autonomyKillSwitch: boolean }>(KILL_SWITCH_URL, {
      method: "POST",
      body: JSON.stringify({ autonomyKillSwitch: false }),
    });
    expect(disengaged.autonomyKillSwitch, "POST disengage should return false").toBe(false);
  });

  // === LAYER 2: API round-trip — insights ===
  test("API: insight POST appears at index [0] of list (reverse-chrono)", async () => {
    await api(INSIGHTS_URL, {
      method: "POST",
      body: JSON.stringify({ note: GOLDEN_INSIGHT_NOTE }),
    });
    const list = await api<Array<{ eventType: string; payload?: { note?: string } }>>(INSIGHTS_URL);
    expect(list.length, "list should have at least 1 entry").toBeGreaterThan(0);
    expect(list[0].eventType, "first entry should be insight_note").toBe("insight_note");
    expect(list[0].payload?.note, "first entry's note should match what we just posted").toBe(GOLDEN_INSIGHT_NOTE);
  });

  // === LAYER 3: UI (Playwright) — same golden numbers on screen ===
  test("UI: kill-switch toggle changes the screen badge state", async ({ page }) => {
    // Reset to known state via API BEFORE logging in.
    await api(KILL_SWITCH_URL, { method: "POST", body: JSON.stringify({ autonomyKillSwitch: false }) });

    await loginDemo(page);
    await openTabByLabel(page, "Workspace");
    await page.getByRole("tab", { name: "Message controls", exact: true }).click();
    await page.waitForTimeout(2000);

    // The status badge is the one with the EXACT label text. Use exact
    // match to avoid picking up the description paragraph that says
    // "When engaged, ...".
    const beforeBadge = page.getByText(/^(On — nothing goes out by itself|Off — automatic messages allowed)$/i);
    await expect(beforeBadge.first()).toBeVisible();
    await expect(beforeBadge.first()).toHaveText(/Off — automatic messages allowed/i);

    // Engage via the UI button. S6 U-3: the toggle now opens a ConfirmModal
    // (was a native window.confirm — the dialog handler is no longer needed).
    const engageBtn = page.getByRole("button", { name: /^Stop all automatic messages$/i });
    await engageBtn.click();
    // Confirm in the modal — scope to [role=dialog] so we don't re-match the
    // original toggle button (which has the same label).
    const dialog = page.locator("[role='dialog']");
    await dialog.getByRole("button", { name: /^Stop them$/ }).click();
    await page.waitForTimeout(2000);

    // The SAME golden value (true) must now appear on screen.
    const afterBadge = page.getByText(/^On — nothing goes out by itself$/i);
    await expect(afterBadge.first(), "UI must reflect the same autonomyKillSwitch=true value the API returned").toBeVisible();

    // Reset for other tests.
    await api(KILL_SWITCH_URL, { method: "POST", body: JSON.stringify({ autonomyKillSwitch: false }) });
  });

  test("UI: insight typed into the form appears in the list (same note text)", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Workspace");
    await page.getByRole("tab", { name: "Notes and activity", exact: true }).click();
    await page.waitForTimeout(1500);

    // 2026-07-27 de-flake: use a UNIQUE note per run. The old test reused a
    // fixed string, which (a) accumulated in the in-memory demo store across
    // runs and (b) let the on-screen/API assertions match a STALE copy from a
    // previous run — so the test passed without proving this run's POST landed.
    // A unique note can ONLY match this run's POST, which is the real proof.
    const uiNote = `Golden thread UI insight ${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const textarea = page.getByRole("textbox", { name: "New workspace note", exact: true });
    await textarea.fill(uiNote);
    await page.getByRole("button", { name: /^Add$/ }).click();

    // The SAME note text must appear in the on-screen list.
    await expect(page.getByText(uiNote).first()).toBeVisible({ timeout: 5_000 });

    // Cross-check the API also has it (the thread is connected). Poll briefly
    // because the demo store is in-memory and the GET can race the POST write.
    let found = false;
    for (let attempt = 0; attempt < 5 && !found; attempt++) {
      const list = await api<Array<{ payload?: { note?: string } }>>(INSIGHTS_URL);
      found = list.some((e) => e.payload?.note === uiNote);
      if (!found) await page.waitForTimeout(250);
    }
    expect(found, "API list must contain the SAME unique note the UI is showing (proves this run's POST persisted)").toBe(true);
  });
});
