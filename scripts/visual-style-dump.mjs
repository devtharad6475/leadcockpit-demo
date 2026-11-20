// Focused computed-style dump across representative screens, for the
// cross-screen consistency comparison (buttons/cards/badges/headings).
// Each screen gets its own fresh browser so a crash can't cascade.
import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const SCREENS = [
  ["Dashboard", "Dashboard"],
  ["Leads", "Leads"],
  ["Tickets", "Tickets"],
  ["QuotesOrders", "Quotes & Orders"],
  ["KnowledgeBase", "Knowledge Base"],
  ["Settings", "Settings"],
  ["Replies", "Replies"],
  ["Catalogue", "Catalogue"],
];

const SHOT_DIR = path.join(process.cwd(), "e2e", "visual-shots");

async function dumpFor(label) {
  const b = await chromium.launch({ headless: true });
  const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  await p.goto("http://localhost:3001/", { waitUntil: "domcontentloaded" });
  await p.getByRole("button", { name: /Continue in Demo Mode/i }).click();
  await p.waitForSelector("h1", { timeout: 30_000 });
  await p.waitForLoadState("networkidle").catch(() => {});
  await p.waitForTimeout(1000);
  await p.locator("nextjs-portal button[aria-label='Close']").first().click({ timeout: 1000 }).catch(() => {});
  const btn = p.getByRole("button", { name: label, exact: true }).first();
  try { await btn.click({ timeout: 5000 }); }
  catch {
    await btn.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
    await p.waitForTimeout(120);
    await btn.click({ force: true }).catch(() => {});
  }
  await p.waitForTimeout(1500);
  await p.waitForLoadState("networkidle").catch(() => {});
  const result = await p.evaluate(() => {
    const summarize = (el) => {
      const cs = getComputedStyle(el);
      return {
        cls: (el.getAttribute("class") || "").slice(0, 120),
        radius: cs.borderRadius,
        bg: cs.backgroundColor,
        color: cs.color,
        border: cs.border.slice(0, 60),
        boxShadow: cs.boxShadow.slice(0, 80),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
      };
    };
    const all = (sel, n = 6) => Array.from(document.querySelectorAll(sel)).slice(0, n).map(summarize);
    const h1 = document.querySelector("h1");
    const h1cs = h1 ? getComputedStyle(h1) : null;
    return {
      h1: h1 ? { text: (h1.textContent || "").trim().slice(0, 50), fontSize: h1cs.fontSize, fontWeight: h1cs.fontWeight, color: h1cs.color } : null,
      h2s: all("h2", 4),
      h3s: all("h3", 3),
      // Cards: Card.tsx = section.rounded-xl...border; Panel = section.min-w-0.rounded-xl; Metric = div.rounded-xl...shadow-md
      cardsSection: all("section.rounded-xl", 6),
      cardsDiv: all("div.rounded-xl", 6),
      // Buttons: legacy .btn vs <Button> component (no .btn class)
      btnLegacy: all("button.btn", 6),
      btnModern: Array.from(document.querySelectorAll("button")).filter((b) => !b.className.includes("btn")).slice(0, 8).map(summarize),
      // Badges
      badges: all("span.rounded-full", 10),
      // Inputs (radius consistency)
      inputs: all("input.input, .input", 4),
    };
  });
  await c.close();
  await b.close();
  return result;
}

const out = {};
for (const [key, label] of SCREENS) {
  try {
    console.log(`→ ${label}`);
    out[label] = await dumpFor(label);
  } catch (e) {
    console.log(`  FAIL ${label}: ${e.message}`);
    out[label] = { error: String(e.message).slice(0, 160) };
  }
}
fs.writeFileSync(path.join(SHOT_DIR, "styles.json"), JSON.stringify(out, null, 2));
console.log(`\nwrote styles.json`);
