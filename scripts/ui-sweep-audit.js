/**
 * 2026-08-05 — UI/UX sweep audit (CONTINUOUS-#4 final survey, browser leg).
 *
 * Visits every nav screen in the LeadCockpit demo app, captures the rendered
 * text content + flags any console errors / HTTP failures, and records the
 * visible structure so we can spot UX issues (empty states, dead text, raw
 * IDs, missing labels, broken layouts) without relying on the IAB.
 *
 * Run against a demo dev server:
 *   PERSISTENCE_PROVIDER=json PORT=3001 npm run dev
 *   node scripts/ui-sweep-audit.js
 *
 * Output: scripts/ui-screenshots/sweep-audit/<screen>.txt + console-errors.json
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.COCKPIT_URL || "http://localhost:3001";
const OUT = path.join(__dirname, "ui-screenshots", "sweep-audit");
fs.mkdirSync(OUT, { recursive: true });

// The nav buttons in order (from the snapshot). These are the screens an
// operator reaches. We click each and capture state.
const SCREENS = [
  "Dashboard", "Replies", "Tickets", "AI Drafts",
  "Leads", "Messages", "Quotes & Orders", "Questions from AI",
  "Ideal Customers", "Campaign", "Discovery", "Lead Review",
  "Onboarding", "Profile", "Knowledge Base", "Catalogue",
  "Analytics", "WhatsApp Agent", "AI Settings", "Agent Instructions",
  "Integrations", "Workspace", "Compliance", "Settings", "Export / Backup",
  "Help & Support",
];

const findings = [];
const consoleErrors = [];
const httpFails = [];

function pushFinding(screen, severity, issue, detail) {
  findings.push({ screen, severity, issue, detail });
  const tag = severity === "P0" ? "🚨" : severity === "P1" ? "❌" : severity === "P2" ? "⚠️" : "•";
  console.log(`  ${tag} [${severity}] ${screen}: ${issue}${detail ? " — " + detail : ""}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const t = msg.text();
      // Ignore noisy dev-only source-map / favicon errors.
      if (/favicon|sourceMap|Failed to load resource: net::ERR|stylesheet|404.*\.ico/i.test(t)) return;
      consoleErrors.push(t);
    }
  });
  page.on("response", (resp) => {
    if (resp.status() >= 500) httpFails.push(`${resp.status()} ${resp.url().replace(BASE, "")}`);
  });

  console.log("=== Boot (demo mode) ===");
  await page.goto(BASE + "/", { waitUntil: "commit", timeout: 60000 });
  await page.waitForTimeout(2500);
  const demoBtn = page.getByRole("button", { name: /continue in demo mode/i });
  if (await demoBtn.isVisible({ timeout: 4000 }).catch(() => false)) await demoBtn.click();
  await page.waitForTimeout(3000);

  // Helper: get the visible text of the main region (excludes nav).
  async function mainText() {
    return page.evaluate(() => {
      const main = document.querySelector("main") || document.body;
      // Walk text nodes, return a flattened string of visible content.
      const bits = [];
      const walk = (n) => {
        if (!n) return;
        if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) bits.push(t); return; }
        if (n.nodeType !== 1) return;
        const style = getComputedStyle(n);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return;
        for (const c of n.childNodes) walk(c);
      };
      // Exclude the complementary nav region.
      const nav = main.querySelector("[role=complementary], aside, nav");
      if (nav && main.contains(nav)) {
        for (const c of main.childNodes) { if (c !== nav && (!nav.contains)) walk(c); }
      }
      // Simpler: just walk everything in main, but skip the aside.
      bits.length = 0;
      const walker = (n) => {
        if (!n || n === nav) return;
        if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) bits.push(t); return; }
        if (n.nodeType !== 1) return;
        const style = getComputedStyle(n);
        if (style.display === "none" || style.visibility === "hidden") return;
        for (const c of n.childNodes) walker(c);
      };
      walker(main);
      return bits.join(" | ");
    });
  }

  // Helper: click a nav button by exact text.
  // 2026-08-05: the nav groups are now collapsible (Settings starts collapsed).
  // Expand ALL collapsed groups in the desktop aside first, then click the item.
  async function clickNav(name) {
    // Expand every collapsed group header in the desktop nav (the aside that
    // is NOT lg:hidden — the mobile drawer aside is hidden on desktop).
    await page.evaluate(() => {
      const asides = Array.from(document.querySelectorAll("aside"));
      const desktop = asides.find(a => !a.className.includes("lg:hidden"));
      if (!desktop) return;
      const headers = desktop.querySelectorAll('button[aria-expanded="false"]');
      headers.forEach(h => h.click());
    });
    await page.waitForTimeout(400);
    // Now click the target item.
    return page.evaluate((label) => {
      const btns = Array.from(document.querySelectorAll("button"));
      const t = btns.find(b => b.textContent.trim() === label && b.offsetParent !== null);
      if (t) { t.click(); return true; }
      return false;
    }, name);
  }

  const seenScreens = [];
  for (const screen of SCREENS) {
    const ok = await clickNav(screen);
    if (!ok) { pushFinding(screen, "P1", "nav button not found", "screen unreachable"); continue; }
    await page.waitForTimeout(1500);
    seenScreens.push(screen);
    const text = await mainText();
    fs.writeFileSync(path.join(OUT, screen.replace(/[^a-z0-9]+/gi, "_") + ".txt"), text);

    // ---- Per-screen heuristics ----
    // 1. Raw snake_case / IDs leaking into UI.
    if (/\b(lead_|quote_|ticket_|ws_|conv_|msg_)[a-z0-9]{6,}/i.test(text)) {
      pushFinding(screen, "P2", "raw ID leaked into UI", text.match(/\b(lead_|quote_|ticket_|ws_|conv_|msg_)[a-z0-9]{6,}/i)[0]);
    }
    if (/\b(held_for_review|drafted|draft_only|price_request|in_progress|waiting_customer)\b/i.test(text)) {
      // Some of these are legitimate in code contexts but not in operator-facing copy.
      const m = text.match(/\b(held_for_review|draft_only|price_request)\b/i);
      if (m) pushFinding(screen, "P2", "raw snake_case status leaked", m[0]);
    }

    // 2. "undefined" / "null" / "NaN" / "[object" rendered.
    if (/\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]|Invalid Date/i.test(text)) {
      const m = text.match(/\b(undefined|null|NaN|\[object Object\]|Invalid Date)\b/i);
      // Allow "null" only if it's clearly not a value (rare). Flag it.
      pushFinding(screen, "P1", "literal undefined/null/NaN rendered", (m && m[0]) || "unknown");
    }

    // 3. "Loading..." stale text (should be Skeletons now).
    if (/^Loading\.\.\.|Loading workspace|Loading\.\.\.$/.test(text)) {
      pushFinding(screen, "P2", "stale 'Loading...' text", "should use Skeleton");
    }

    // 4. Empty state with no explanation.
    if (/^No .*\.$/.test(text.trim()) && text.length < 40 && !/because|yet|upload|add|click|try|filter/i.test(text)) {
      pushFinding(screen, "P2", "bare empty state — no 'why' or guidance", text.trim());
    }

    // 5. ₹ amount sanity — no "₹NaN" or "₹undefined".
    if (/₹(undefined|NaN|0\.00\s)/.test(text)) {
      pushFinding(screen, "P1", "broken currency value", text.match(/₹(undefined|NaN)[^\s]*/i)?.[0]);
    }

    // 6. Whitespace / encoding issues.
    if (/&amp;|&lt;|&gt;|&quot;|&#39;/.test(text)) {
      pushFinding(screen, "P2", "HTML entity not decoded", text.match(/&amp;|&lt;|&gt;|&quot;/)[0]);
    }
  }

  // ---- Mobile viewport sweep (360px) ----
  console.log("\n=== Mobile viewport sweep (360px) ===");
  await page.setViewportSize({ width: 360, height: 740 });
  // Visit a few key screens and check for horizontal overflow.
  for (const screen of ["Dashboard", "Leads", "Quotes & Orders", "Replies", "Tickets", "Knowledge Base"]) {
    await clickNav(screen);
    await page.waitForTimeout(1500);
    const overflow = await page.evaluate(() => {
      const sw = window.innerWidth, bw = document.body.scrollWidth;
      return { viewport: sw, body: bw, overflowPx: Math.max(0, bw - sw) };
    });
    if (overflow.overflowPx > 4) {
      pushFinding(screen + " (mobile)", "P1", `horizontal overflow ${overflow.overflowPx}px`, `body ${overflow.body} > viewport ${overflow.viewport}`);
    }
    await page.screenshot({ path: path.join(OUT, "mobile_" + screen.replace(/[^a-z0-9]+/gi, "_") + ".png"), fullPage: false });
  }

  fs.writeFileSync(path.join(OUT, "console-errors.json"), JSON.stringify(consoleErrors, null, 2));
  fs.writeFileSync(path.join(OUT, "http-fails.json"), JSON.stringify(httpFails, null, 2));
  fs.writeFileSync(path.join(OUT, "findings.json"), JSON.stringify(findings, null, 2));

  console.log(`\n=== Sweep complete: ${seenScreens.length}/${SCREENS.length} screens visited ===`);
  console.log(`Findings: ${findings.length} (P0:${findings.filter(f=>f.severity==="P0").length} P1:${findings.filter(f=>f.severity==="P1").length} P2:${findings.filter(f=>f.severity==="P2").length})`);
  console.log(`Console errors: ${consoleErrors.length}`);
  console.log(`HTTP 5xx: ${httpFails.length}`);

  await browser.close();
  process.exit(0);
})();
