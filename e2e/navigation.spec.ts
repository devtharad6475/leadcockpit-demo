/**
 * navigation.spec.ts — the sidebar, the drawers, and the mobile drawer.
 *
 * REWRITTEN 2026-08-19 (CEO-loop session 7, N-TEST-4).
 *
 * The previous version was written for the M3 design of 2026-07-21 and asserted
 * five groups named "Today, Sales, Prospecting, Knowledge, Settings" plus a tab
 * called "Leads / CRM". The 2026-08-17 redesign replaced all of that: the groups
 * are now Conversations, Customers, Prospecting, Knowledge, Controls, they start
 * COLLAPSED, and "Leads / CRM" is just "Leads". Every assertion here was
 * describing a product that no longer existed — and because nobody ran the
 * suite, it went unnoticed for two days.
 *
 * So this file now does something the old one could not: it reads the sidebar
 * the app actually renders and compares it against the map the rest of the
 * suite navigates by (`TAB_GROUP` in e2e/helpers/nav.ts). If a tab is renamed
 * or moved again, this fails with a readable diff naming the tab, instead of
 * forty other specs timing out on a click that silently matched nothing.
 */
import { test, expect } from "@playwright/test";
import { loginDemo } from "./helpers/login";
import { openTabByLabel, readNavMap, TAB_GROUP } from "./helpers/nav";

test.describe("navigation", () => {
  test("the sidebar the app renders matches the map the suite navigates by", async ({ page }) => {
    await loginDemo(page);
    const actual = await readNavMap(page);

    // Compare as sorted "label -> group" lines: a diff of two objects is hard to
    // read in a terminal, and the thing that matters is which line changed.
    const asLines = (m: Record<string, string>) =>
      Object.entries(m)
        .map(([label, group]) => `${group}/${label}`)
        .sort();

    expect(
      asLines(actual),
      "The sidebar and e2e/helpers/nav.ts have drifted apart. Whichever is right, " +
        "the map is what ~40 specs navigate by, so fix it there.",
    ).toEqual(asLines(TAB_GROUP));
  });

  test("every drawer is present and starts collapsed", async ({ page }) => {
    await loginDemo(page);
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    // 2026-08-31 (N-UI-7): was five drawers; "Controls" was split into three.
    for (const group of ["Conversations", "Customers", "Prospecting", "Knowledge", "Business performance", "AI & channels", "Workspace & admin"]) {
      await expect(nav.getByRole("button", { name: group }).first()).toBeVisible();
    }
    // "Leads" lives inside Customers, which nobody has opened yet.
    await expect(nav.getByRole("button", { name: "Leads", exact: true })).toHaveCount(0);
  });

  test("opening a drawer and clicking a tab switches the active tab", async ({ page }) => {
    await loginDemo(page);
    await openTabByLabel(page, "Leads");
    const active = page.locator('button[aria-current="page"]');
    await expect(active.first()).toContainText(/Leads/i);
  });

  test("the old label 'Commercial' still resolves, via the rename table", async ({ page }) => {
    await loginDemo(page);
    // Not nostalgia: this is what lets the pre-redesign specs be retargeted
    // mechanically. If the rename table rots, this is the test that says so.
    await openTabByLabel(page, "Commercial");
    const active = page.locator('button[aria-current="page"]');
    await expect(active.first()).toContainText(/Quotes & Orders/i);
  });

  test("an unknown tab fails loudly rather than silently doing nothing", async ({ page }) => {
    await loginDemo(page);
    // The exact failure mode that made the old suite worthless: a click that
    // matches nothing, swallowed, and the test asserts against the screen it was
    // already on. openTabByLabel throws instead.
    await expect(openTabByLabel(page, "Nonexistent Tab")).rejects.toThrow(/no such tab/i);
  });

  test("mobile drawer opens via the hamburger button", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await loginDemo(page);

    const hamburger = page.getByRole("button", { name: "Open navigation" });
    await expect(hamburger).toBeVisible();

    const drawer = page.locator('aside[aria-label="Mobile navigation"]');
    await expect(drawer).toHaveAttribute("aria-hidden", "true");

    await hamburger.click();
    await expect(hamburger).toHaveAttribute("aria-expanded", "true");
    await expect(drawer).toHaveAttribute("aria-hidden", "false");
  });

  test("the queue is the landing screen and its title is the queue status", async ({ page }) => {
    await loginDemo(page);
    // The 2026-08-17 redesign made "Needs you" the landing screen and made the
    // <h1> the queue status rather than the brand. That change is exactly what
    // broke 23 specs, so it is worth one test that states it on purpose.
    const active = page.locator('button[aria-current="page"]').first();
    await expect(active).toContainText(/Needs you/i);
    await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText(
      /(Nothing needs you|\d+ things? needs? you)/i,
    );
  });
});
