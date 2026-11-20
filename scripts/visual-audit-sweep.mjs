// ANGLE 6 VISUAL POLISH AUDIT — plain Node script (no Playwright test runner).
// Connects to the already-running dev server on http://localhost:3001.
// Logs in via demo mode, screenshots all 26 tabs at 1440px, dumps computed
// styles for representative buttons/cards/badges for cross-screen comparison.
//
// Run: node scripts/visual-audit-sweep.mjs
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const TABS = [
  ["dashboard", "Dashboard"],
  ["replies", "Replies"],
  ["tickets", "Tickets"],
  ["reviewQueue", "AI Drafts"],
  ["crm", "Leads"],
  ["messages", "Messages"],
  ["commercial", "Quotes & Orders"],
  ["unknown", "Questions from AI"],
  ["icp", "Ideal Customers"],
  ["campaign", "Campaign"],
  ["discovery", "Discovery"],
  ["review", "Lead Review"],
  ["onboarding", "Onboarding"],
  ["profile", "Profile"],
  ["knowledge", "Knowledge Base"],
  ["catalogue", "Catalogue"],
  ["analytics", "Analytics"],
  ["whatsapp", "WhatsApp Agent"],
  ["ai", "AI Settings"],
  ["agentInstructions", "Agent Instructions"],
  ["integrations", "Integrations"],
  ["workspace", "Workspace"],
  ["compliance", "Compliance"],
  ["settings", "Settings"],
  ["exportBackup", "Export / Backup"],
  ["help", "Help & Support"],
];

const SHOT_DIR = path.join(process.cwd(), "e2e", "visual-shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

// capture console errors across the sweep (each captureTab attaches its own).
const consoleErrors = [];

console.log("→ visual audit sweep on :3001 (per-tab fresh browser) ...");

const report = [];
const SKIP_EXISTING = !process.env.VISUAL_FRESH;

// Capture one tab in its OWN fresh browser (bulletproof against GPU/process
// crashes on long pages — a crash only loses that one tab, never the sweep).
async function captureTab(tabId, label) {
  if (SKIP_EXISTING && fs.existsSync(path.join(SHOT_DIR, `${tabId}.png`))) {
    console.log(`  SKIP ${tabId} (${label}) — already captured`);
    report.push({ tab: `${tabId} (${label})`, status: "SKIP" });
    return;
  }
  let b = null;
  try {
    b = await chromium.launch({ headless: true });
    const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await c.newPage();
    p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await p.goto("http://localhost:3001/", { waitUntil: "domcontentloaded" });
    await p.getByRole("button", { name: /Continue in Demo Mode/i }).click();
    await p.waitForSelector("h1", { timeout: 30_000 });
    await p.waitForLoadState("networkidle").catch(() => {});
    await p.waitForTimeout(1200);
    await p.locator("nextjs-portal button[aria-label='Close']").first().click({ timeout: 1200 }).catch(() => {});
    const btn = p.getByRole("button", { name: label, exact: true }).first();
    try {
      await btn.click({ timeout: 5000 });
    } catch {
      await btn.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
      await p.waitForTimeout(150);
      await btn.click({ force: true }).catch(() => {});
    }
    await p.waitForTimeout(1500);
    await p.waitForLoadState("networkidle").catch(() => {});
    await p.screenshot({ path: path.join(SHOT_DIR, `${tabId}.png`), fullPage: true });
    await p.screenshot({ path: path.join(SHOT_DIR, `${tabId}-fold.png`), fullPage: false });
    report.push({ tab: `${tabId} (${label})`, status: "OK" });
    console.log(`  OK   ${tabId} (${label})`);
    await c.close();
  } catch (e) {
    report.push({ tab: `${tabId} (${label})`, status: "FAIL", note: String(e.message).slice(0, 140) });
    console.log(`  FAIL ${tabId} (${label}) — ${e.message}`);
  } finally {
    try { await b.close(); } catch {}
  }
}

for (const [tabId, label] of TABS) {
  await captureTab(tabId, label);
}

// Computed-style comparison dump across a few representative screens.
const dumpStylesFor = async (b, label) => {
  const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  await p.goto("http://localhost:3001/", { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: /Continue in Demo Mode/i }).click();
  await p.waitForSelector("h1", { timeout: 30_000 });
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(1000);
  const btn = p.getByRole("button", { name: label, exact: true }).first();
  await btn.click({ timeout: 5000 }).catch(async () => {
    await btn.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
    await p.waitForTimeout(120);
    await btn.click({ force: true }).catch(() => {});
  });
  await p.waitForTimeout(1000);
  const result = await p.evaluate(() => {
    const pickAll = (sel) =>
      Array.from(document.querySelectorAll(sel)).slice(0, 6).map((el) => {
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 130),
          radius: cs.borderRadius,
          bg: cs.backgroundColor,
          color: cs.color,
          boxShadow: cs.boxShadow.slice(0, 90),
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
        };
      });
    const pickOne = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { cls: (el.className || "").toString().slice(0, 130), radius: cs.borderRadius, bg: cs.backgroundColor, boxShadow: cs.boxShadow.slice(0, 90), fontSize: cs.fontSize, fontWeight: cs.fontWeight };
    };
    const h1 = document.querySelector("h1");
    return {
      h1: h1 ? { text: (h1.textContent || "").trim().slice(0, 40), fontSize: getComputedStyle(h1).fontSize, fontWeight: getComputedStyle(h1).fontWeight } : null,
      h2s: pickAll("h2").slice(0, 3),
      cardSections: pickAll("section.rounded-xl").slice(0, 4),
      btnClass: pickAll("button.btn"),
      btnNoClass: Array.from(document.querySelectorAll('button')).filter((b) => !b.className.includes("btn")).slice(0, 6).map((el) => {
        const cs = getComputedStyle(el);
        return { cls: (el.className || "").toString().slice(0, 130), radius: cs.borderRadius, bg: cs.backgroundColor, color: cs.color, fontSize: cs.fontSize, fontWeight: cs.fontWeight };
      }),
      badges: pickAll("span.rounded-full").slice(0, 8),
      panel: pickOne("section.min-w-0.rounded-xl"),
    };
  });
  await c.close();
  return result;
};

const styleDump = {};
for (const label of ["Dashboard", "Leads", "Tickets", "Quotes & Orders", "Knowledge Base", "Settings"]) {
  let b = null;
  try {
    b = await chromium.launch({ headless: true });
    styleDump[label] = await dumpStylesFor(b, label);
  } catch (e) {
    styleDump[label] = { error: String(e.message) };
  } finally {
    try { await b.close(); } catch {}
  }
}

fs.writeFileSync(path.join(SHOT_DIR, "styles.json"), JSON.stringify(styleDump, null, 2));
fs.writeFileSync(path.join(SHOT_DIR, "report.json"), JSON.stringify({ report, consoleErrors }, null, 2));

console.log(`\n=== DONE. ${report.filter((r) => r.status === "OK").length}/${report.length} OK. Console errors: ${consoleErrors.length} ===`);
console.log(`Screenshots + styles.json → ${SHOT_DIR}`);
