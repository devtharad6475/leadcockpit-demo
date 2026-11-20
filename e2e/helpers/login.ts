/**
 * login.ts — the one place the e2e suite decides "the app is up and logged in".
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Twenty-three specs each carried their own private copy of this:
 *
 *   await page.goto("/");
 *   await page.getByRole("button", { name: /Continue in Demo Mode/i }).click();
 *   await expect(page.getByRole("heading", { level: 1, name: /LeadCockpit/i }))
 *     .toBeVisible({ timeout: 20_000 });
 *
 * The 2026-08-17 navigation redesign moved "LeadCockpit" into the sidebar brand
 * — it is plain text now, not a heading at all — and made the <h1> the queue
 * status ("4 things need you" / "Nothing needs you"). So that last line matched
 * nothing, in every copy, and the WHOLE SUITE failed at login: 253 tests, each
 * burning its own 20-second timeout before its first real assertion ever ran.
 *
 * One copy-pasted line took the entire suite down, and it stayed down because
 * nobody ran it. That is why this is a shared helper rather than a twenty-fourth
 * copy: the next rename should cost one edit, not twenty-three.
 *
 * WHY THE ASSERTION IS STRUCTURAL
 * -------------------------------
 * It deliberately asserts no product copy. "Logged in" here means the app shell
 * mounted: there is an <h1>, and there is a main navigation landmark. Copy
 * changes all the time — a login helper that reads a headline is a helper that
 * cries "login is broken" every time a word on the dashboard changes, which is
 * exactly the false alarm that made this suite worth ignoring.
 */
import { expect, type Page } from "@playwright/test";

/**
 * Asserts the post-login app shell has mounted. No product copy is asserted.
 *
 * The <h1> alone is not enough evidence: the signed-OUT screen has an <h1> too
 * ("Agent-assisted B2B lead generation..."), so a helper that stopped there
 * would report success for a login that never happened. The navigation is the
 * part that only exists once you are inside.
 *
 * Below the `lg` breakpoint the desktop sidebar is hidden and navigation lives
 * behind the hamburger, so either one counts — `navigation.spec.ts` logs in at
 * 800px on purpose.
 */
export async function expectAppShell(page: Page, timeout = 20_000): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout });
  const desktopNav = page.getByRole("navigation", { name: "Main navigation" });
  const hamburger = page.getByRole("button", { name: "Open navigation" });
  await expect(desktopNav.or(hamburger).first()).toBeVisible({ timeout });
}

/** Opens the app, signs in through demo mode, and waits for the shell. */
export async function loginDemo(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: /Continue in Demo Mode/i }).click();
  await expectAppShell(page);
}
