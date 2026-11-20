/**
 * 2026-07-21 (M1) — Design system foundation test.
 *
 * Per docs/UI-DESIGN.md M1, this test proves the foundation is wired
 * correctly without needing a dedicated /dev/ui-preview route (which
 * would pollute production). It exercises:
 *   - The app boots with ToastProvider (no crash).
 *   - The CSS tokens resolve (the body paints --color-background, not
 *     default white).
 *   - Geist font is now applied to body (audit fix).
 *   - Focus-visible ring renders on a focusable element.
 *
 * Per-primitive Playwright tests get added when each primitive is used
 * in a real screen (M5+). This test is the "foundation is solid" gate.
 */
import { test, expect } from "@playwright/test";

test.describe("M1 design system foundation", () => {
  test("app boots with the new token-based palette + Geist font", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // The body must paint the palette token, not Tailwind's default white.
    //
    // 2026-08-19 (N-TEST-8) - this used to hard-code the sage cream the palette
    // shipped with in July (`toContain("246")`, from #f6f7f4). The palette has
    // since moved to a cool light grey (#f4f5f7), so the test failed with
    // `Expected substring: "246" / Received string: "rgb(244, 245, 247)"` - a
    // token rename reported as a broken boot. Reading `--color-background` off
    // the page and comparing the body against IT keeps the real claim ("the
    // tokens resolve and the body uses them") while surviving a repaint.
    const { bodyBg, tokenBg } = await page.evaluate(() => {
      const styles = window.getComputedStyle(document.body);
      return {
        bodyBg: styles.backgroundColor,
        tokenBg: window.getComputedStyle(document.documentElement).getPropertyValue("--color-background").trim(),
      };
    });
    expect(tokenBg, "--color-background must be defined by the design tokens").not.toBe("");
    const toRgb = (hex: string) => {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex);
      if (!m) return null;
      const n = parseInt(m[1], 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    const expected = toRgb(tokenBg) ?? tokenBg;
    expect(bodyBg, `body must paint --color-background (${tokenBg})`).toBe(expected);
    expect(bodyBg, "body must not be Tailwind default white").not.toBe("rgb(255, 255, 255)");

    // Body font should reference Geist. next/font injects the actual
    // family name into the --font-geist-sans CSS var. The computed
    // fontFamily should NOT be just "Arial" anymore — it should contain
    // either Geist OR our fallback stack (system-ui etc).
    const bodyFont = await page.evaluate(() => {
      return window.getComputedStyle(document.body).fontFamily;
    });
    expect(
      bodyFont.includes("__Geist") ||
      bodyFont.includes("Geist") ||
      bodyFont.includes("system-ui"),
      `body font should reference Geist or our fallback stack, got: "${bodyFont}"`,
    ).toBe(true);
    expect(
      bodyFont,
      "should NOT be the old Arial-only override",
    ).not.toBe("Arial, Helvetica, sans-serif");
  });

  test("focus-visible ring renders on keyboard focus", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Tab to the first focusable element (the demo button).
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);

    // The focused element should have an outline-color set when
    // keyboard-focused. We check the outlineStyle — "none" means no ring
    // is rendering; anything else (solid) means the focus-visible rule
    // is applying.
    const focusedInfo = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      // Force :focus-visible computation by checking the active selector.
      const matches = el.matches(":focus-visible");
      const styles = window.getComputedStyle(el);
      return {
        tag: el.tagName,
        matchesFocusVisible: matches,
        outlineStyle: styles.outlineStyle,
        outlineColor: styles.outlineColor,
      };
    });

    expect(focusedInfo, "something should be focused").not.toBeNull();
    // The :focus-visible selector should match after a keyboard Tab.
    expect(
      focusedInfo?.matchesFocusVisible || focusedInfo?.outlineStyle !== "none",
      `focus should produce a visible ring; tag=${focusedInfo?.tag}, matchesFocusVisible=${focusedInfo?.matchesFocusVisible}, outlineStyle=${focusedInfo?.outlineStyle}`,
    ).toBe(true);
  });

  test("ToastProvider is mounted (toast container exists)", async ({ page }) => {
    await page.goto("/");

    // The ToastProvider renders an aria-live region for toasts. It exists
    // even when no toast is showing.
    const liveRegion = page.locator('[aria-live="polite"][aria-atomic="true"]');
    await expect(liveRegion).toHaveCount(1);
  });

  test("CSP header includes a per-request nonce (M0 fix preserved)", async ({ page }) => {
    const response = await page.goto("/");
    const csp = response?.headers()["content-security-policy"] || "";
    expect(csp, "CSP header should be present").not.toBe("");
    expect(csp, "CSP should include a nonce").toMatch(/script-src[^;]*'nonce-/);
    expect(csp, "CSP should NOT allow unsafe-inline for scripts").not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
});
