/**
 * FRESH-EYES mobile UX audit (ANGLE 2 of 6 — Mobile & Responsive) — v2.
 *
 * v1 failed: nav clicks timed out because the "Settings" nav group is
 * COLLAPSED by default (so 10 of 26 nav buttons don't exist in the DOM until
 * the group header is clicked), and an end-of-iteration drawer-close test
 * corrupted drawer state. v2 fixes both:
 *   - before each nav, expand ALL 5 group headers
 *   - no separate drawer-close test (close is exercised implicitly: clicking
 *     a nav item calls setDrawerOpen(false))
 *
 * Per screen at 360x740:
 *   (a) horizontal overflow: scrollWidth > innerWidth (px)
 *   (b) tap targets: every visible button/link sized <44x44
 *   (c) viewport + full-page screenshots
 *   (d) console / page errors
 * Plus one explicit drawer open→overlay-click→close test.
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:3001";
const OUT_DIR = join(process.cwd(), "audit-mobile-out");
mkdirSync(OUT_DIR, { recursive: true });

const GROUP_HEADERS = ["TODAY", "SALES", "PROSPECTING", "KNOWLEDGE", "SETTINGS"];

const SCREENS: Array<{ id: string; name: string; nav: string }> = [
  { id: "dashboard", name: "Dashboard", nav: "Dashboard" },
  { id: "replies", name: "Replies", nav: "Replies" },
  { id: "tickets", name: "Tickets", nav: "Tickets" },
  { id: "reviewQueue", name: "AI Drafts", nav: "AI Drafts" },
  { id: "crm", name: "Leads", nav: "Leads" },
  { id: "messages", name: "Messages", nav: "Messages" },
  { id: "commercial", name: "Quotes & Orders", nav: "Quotes & Orders" },
  { id: "unknown", name: "Questions from AI", nav: "Questions from AI" },
  { id: "icp", name: "Ideal Customers", nav: "Ideal Customers" },
  { id: "campaign", name: "Campaign", nav: "Campaign" },
  { id: "discovery", name: "Discovery", nav: "Discovery" },
  { id: "review", name: "Lead Review", nav: "Lead Review" },
  { id: "onboarding", name: "Onboarding", nav: "Onboarding" },
  { id: "profile", name: "Profile", nav: "Profile" },
  { id: "knowledge", name: "Knowledge Base", nav: "Knowledge Base" },
  { id: "catalogue", name: "Catalogue", nav: "Catalogue" },
  { id: "analytics", name: "Analytics", nav: "Analytics" },
  { id: "whatsapp", name: "WhatsApp Agent", nav: "WhatsApp Agent" },
  { id: "ai", name: "AI Settings", nav: "AI Settings" },
  { id: "agentInstructions", name: "Agent Instructions", nav: "Agent Instructions" },
  { id: "integrations", name: "Integrations", nav: "Integrations" },
  { id: "workspace", name: "Workspace", nav: "Workspace" },
  { id: "compliance", name: "Compliance", nav: "Compliance" },
  { id: "settings", name: "Settings", nav: "Settings" },
  { id: "exportBackup", name: "Export / Backup", nav: "Export / Backup" },
  { id: "help", name: "Help & Support", nav: "Help & Support" },
];

async function expandCollapsedGroups(page: import("playwright").Page) {
  // Only click headers whose aria-expanded === "false". Use native scrollIntoView
  // + click because lower headers (SETTINGS) sit below the 740px viewport and
  // Playwright's click() refuses off-viewport targets. Retry because the auto-
  // expand-on-active rule can re-collapse a group right after we expand a sibling.
  for (let pass = 0; pass < 3; pass++) {
    const collapsed = await page.evaluate((headers) => {
      var aside = document.querySelector('aside[aria-label="Mobile navigation"]');
      if (!aside) return [];
      var out = [];
      var btns = Array.prototype.slice.call(aside.querySelectorAll("button"));
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || "").replace(/\s+/g, " ").trim().toUpperCase();
        if (headers.indexOf(t) !== -1 && btns[i].getAttribute("aria-expanded") === "false") {
          btns[i].scrollIntoView({ block: "center" });
          btns[i].click();
          out.push(t);
        }
      }
      return out;
    }, GROUP_HEADERS);
    if (collapsed.length === 0) break;
    await page.waitForTimeout(120);
  }
}

async function visitScreen(page: import("playwright").Page, nav: string): Promise<void> {
  // If the drawer is already open (aria-hidden=false), skip re-opening — re-
  // opening would require the hamburger which can be stale.
  const drawerAlreadyOpen = await page.locator('aside[aria-label="Mobile navigation"]').getAttribute("aria-hidden").catch(() => "true");
  if (drawerAlreadyOpen === "true") {
    await page.locator('button[aria-label="Open navigation"]').first().click({ timeout: 5000 });
    await page.waitForTimeout(200);
  }
  // Ensure the target button is in the DOM: expand every collapsed group.
  await expandCollapsedGroups(page);
  // With all 5 groups expanded the nav list overflows the 740px drawer, so the
  // target button may sit below the viewport. Playwright's click() refuses
  // off-viewport targets, so scroll the drawer's own overflow container to bring
  // the button into view, THEN click. (This overflow is itself a UX finding —
  // see report.)
  const clicked = await page.evaluate((label) => {
    var aside = document.querySelector('aside[aria-label="Mobile navigation"]');
    if (!aside) return false;
    var btns = Array.prototype.slice.call(aside.querySelectorAll("button"));
    var found = null;
    for (var i = 0; i < btns.length; i++) {
      // Group-header buttons carry aria-expanded; nav items do not. This is what
      // distinguishes the "Settings" nav item from the "SETTINGS" group header
      // (both normalize to "SETTINGS").
      if (btns[i].hasAttribute("aria-expanded")) continue;
      var t = (btns[i].textContent || "").replace(/\s+/g, " ").trim();
      if (t === label) { found = btns[i]; break; }
    }
    if (!found) return false;
    found.scrollIntoView({ block: "center", inline: "nearest" });
    found.click();
    return true;
  }, nav);
  if (!clicked) throw new Error(`nav button "${nav}" not found/clicked in drawer`);
  await page.waitForTimeout(700);
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function measureTapTargets(page: import("playwright").Page) {
  return page.evaluate(() => {
    const sel = "button, a, [role='button'], input[type='submit'], input[type='button'], input[type='checkbox'], input[type='radio'], select, [role='tab']";
    const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
    const out: Array<{ tag: string; text: string; w: number; h: number; x: number }> = [];
    const vw = window.innerWidth;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      if (r.width === 0 || r.height === 0) continue;
      // Skip off-canvas (mobile drawer when closed). Allow small negative for borders.
      if (r.right < -10 || r.left > vw + 10) continue;
      if (r.width < 44 || r.height < 44) {
        const text = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 38);
        out.push({ tag: el.tagName.toLowerCase() + (el.getAttribute("type") ? `[${el.getAttribute("type")}]` : ""), text, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left) });
      }
    }
    return out;
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 360, height: 740 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

  console.log(`=== MOBILE UX AUDIT v2 — 360x740 ===\n`);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const demoBtn = page.getByRole("button", { name: /Continue in Demo Mode/i });
  if (await demoBtn.isVisible().catch(() => false)) {
    await demoBtn.click();
    await page.waitForTimeout(1500);
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  const hamOk = await page.getByRole("button", { name: "Open navigation" }).isVisible().catch(() => false);
  console.log("post-login hamburger visible:", hamOk);
  if (!hamOk) { console.log("FATAL: not logged in. Aborting."); await browser.close(); return; }

  const results: any[] = [];
  for (const screen of SCREENS) {
    consoleErrors.length = 0;
    pageErrors.length = 0;
    let navOk = true;
    let h1After = "?";
    try {
      await visitScreen(page, screen.nav);
      h1After = (await page.locator("h1").first().innerText().catch(() => "?")).trim();
    } catch (e) {
      navOk = false;
      console.log(`  [nav-fail] ${screen.name}: ${String(e).slice(0, 100)}`);
    }
    await page.waitForTimeout(500);

    const overflow = await page.evaluate(() => ({
      scrollW: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      innerW: window.innerWidth,
    }));
    const hasOverflow = overflow.scrollW > overflow.innerW + 1;
    const smallTargets = await measureTapTargets(page);
    const safe = screen.id.replace(/[^a-z0-9]/gi, "_");
    await page.screenshot({ path: join(OUT_DIR, `${safe}__viewport.png`) });
    const fullPageHeight = await page.evaluate(() => document.documentElement.scrollHeight);

    results.push({
      id: screen.id, name: screen.name, navOk, h1After,
      horizontalOverflow: { has: hasOverflow, scrollW: overflow.scrollW, innerW: overflow.innerW, px: hasOverflow ? overflow.scrollW - overflow.innerW : 0 },
      smallTapTargets: smallTargets,
      smallTapCount: smallTargets.length,
      consoleErrors: [...consoleErrors], pageErrors: [...pageErrors],
      fullPageHeight,
    });
    const ofx = hasOverflow ? `+${overflow.scrollW - overflow.innerW}px` : "ok";
    console.log(`- ${screen.name.padEnd(20)} nav:${navOk ? "ok" : "FAIL"} h1:"${h1After.slice(0,18)}"  overflow:${ofx.padEnd(8)} taps<44:${String(smallTargets.length).padStart(3)}  err:${consoleErrors.length}/${pageErrors.length}  h:${fullPageHeight}`);
  }

  // Explicit drawer open → overlay click → close test (once, after all screens).
  let drawerCloseWorks = false;
  try {
    await page.getByRole("button", { name: "Open navigation" }).click({ timeout: 5000 });
    await page.waitForTimeout(200);
    const asideBefore = await page.locator('aside[aria-label="Mobile navigation"]').getAttribute("aria-hidden");
    // Click the overlay.
    await page.locator("div.fixed.inset-0.z-40").first().click({ timeout: 3000 });
    await page.waitForTimeout(300);
    const asideAfter = await page.locator('aside[aria-label="Mobile navigation"]').getAttribute("aria-hidden");
    drawerCloseWorks = asideBefore === "false" && asideAfter === "true";
    console.log(`\ndrawer test: open(aria-hidden=${asideBefore}) → overlay-click → close(aria-hidden=${asideAfter}) => ${drawerCloseWorks ? "WORKS" : "FAILED"}`);
  } catch (e) {
    console.log(`\ndrawer test error: ${String(e).slice(0, 100)}`);
  }

  writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify({ drawerCloseWorks, screens: results }, null, 2));

  const overflowScreens = results.filter((r) => r.horizontalOverflow.has);
  const navFail = results.filter((r) => !r.navOk);
  const wrongScreen = results.filter((r) => r.navOk && r.h1After !== r.name);
  console.log(`\n=== SUMMARY v2 ===`);
  console.log(`nav failures: ${navFail.length} | wrong-screen-after-nav: ${wrongScreen.length} | overflow: ${overflowScreens.length}/${results.length}`);
  if (navFail.length) navFail.forEach((r) => console.log(`   NAV-FAIL: ${r.name}`));
  if (wrongScreen.length) wrongScreen.forEach((r) => console.log(`   WRONG-H1: ${r.name} -> "${r.h1After}"`));
  if (overflowScreens.length) overflowScreens.forEach((r) => console.log(`   OVERFLOW: ${r.name} +${r.horizontalOverflow.px}px`));
  console.log(`total small tap targets (<44px): ${results.reduce((s, r) => s + r.smallTapCount, 0)}`);
  console.log(`console errors: ${results.reduce((s, r) => s + r.consoleErrors.length, 0)} | page errors: ${results.reduce((s, r) => s + r.pageErrors.length, 0)}`);
  console.log(`drawer overlay-close: ${drawerCloseWorks ? "WORKS" : "BROKEN"}`);
  console.log(`Output: ${OUT_DIR}`);
  await browser.close();
}
main().catch((e) => { console.error("AUDIT FAILED:", e); process.exit(1); });
