/**
 * 2026-08-05 — Visual screenshot capture for manual UX review.
 * Captures desktop + mobile screenshots of every screen so we can spot
 * visual/layout issues the text heuristics miss.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.COCKPIT_URL || "http://localhost:3001";
const OUT = path.join(__dirname, "ui-screenshots", "visual");
fs.mkdirSync(OUT, { recursive: true });

const SCREENS = [
  "Dashboard", "Replies", "Tickets", "AI Drafts",
  "Leads", "Messages", "Quotes & Orders", "Questions from AI",
  "Ideal Customers", "Campaign", "Discovery", "Lead Review",
  "Onboarding", "Profile", "Knowledge Base", "Catalogue",
  "Analytics", "WhatsApp Agent", "AI Settings", "Agent Instructions",
  "Integrations", "Workspace", "Compliance", "Settings", "Export / Backup",
  "Help & Support",
];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(BASE + "/", { waitUntil: "commit", timeout: 60000 });
  await page.waitForTimeout(2500);
  const demoBtn = page.getByRole("button", { name: /continue in demo mode/i });
  if (await demoBtn.isVisible({ timeout: 4000 }).catch(() => false)) await demoBtn.click();
  await page.waitForTimeout(3000);

  const clickNav = (name) => page.evaluate((label) => {
    const btns = Array.from(document.querySelectorAll("button"));
    const t = btns.find(b => b.textContent.trim() === label);
    if (t) { t.click(); return true; }
    return false;
  }, name);

  // Desktop screenshots
  console.log("=== Desktop (1440px) ===");
  for (const screen of SCREENS) {
    await clickNav(screen);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, "desktop_" + screen.replace(/[^a-z0-9]+/gi, "_") + ".png"), fullPage: false });
    process.stdout.write(".");
  }
  console.log(" done");

  // Mobile screenshots
  console.log("=== Mobile (360px) ===");
  await page.setViewportSize({ width: 360, height: 740 });
  for (const screen of SCREENS) {
    await clickNav(screen);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, "mobile_" + screen.replace(/[^a-z0-9]+/gi, "_") + ".png"), fullPage: false });
    process.stdout.write(".");
  }
  console.log(" done");

  await browser.close();
  console.log(`\nScreenshots saved to ${OUT}`);
})();
