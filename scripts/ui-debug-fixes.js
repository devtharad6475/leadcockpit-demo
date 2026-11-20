/**
 * Debug probe — check WHY the Remove button / View customer link aren't found.
 */
const { chromium } = require("playwright");
const BASE = process.env.COCKPIT_URL || "http://localhost:3001";

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

  // ---- Integrations: what buttons exist? ----
  console.log("=== Integrations section — all buttons with 'Remove' or 'delete' ===");
  await clickNav("Integrations");
  await page.waitForTimeout(2500);
  const intButtons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("button"))
      .map(b => ({ text: b.textContent.trim().slice(0, 40), visible: b.offsetParent !== null, classes: b.className.slice(0, 60) }))
      .filter(b => /remove|delete|test|save|connect/i.test(b.text));
  });
  console.log("Integration buttons:", JSON.stringify(intButtons, null, 2));

  // Check if WhatsApp creds are saved
  const waStatus = await page.evaluate(() => document.body.textContent.match(/Saved.*?••••|no.*saved|WhatsApp credentials.*?this workspace/i)?.[0]);
  console.log("WhatsApp status:", waStatus);

  // Scroll down to find Remove buttons that may be off-screen
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  const intButtonsAfterScroll = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("button"))
      .map(b => ({ text: b.textContent.trim().slice(0, 40), visible: b.offsetParent !== null }))
      .filter(b => /remove/i.test(b.text));
  });
  console.log("Remove buttons after scroll:", JSON.stringify(intButtonsAfterScroll));

  // ---- Tickets: what's in the detail when a ticket is selected? ----
  console.log("\n=== Tickets section — probe detail ===");
  await clickNav("Tickets");
  await page.waitForTimeout(2000);
  // List the ticket items
  const ticketItems = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("button, [role=button]"))
      .map(b => ({ text: b.textContent.trim().slice(0, 60), visible: b.offsetParent !== null }))
      .filter(b => b.visible && /#|bulk|complaint|question|order|support/i.test(b.text) && b.text.length > 5 && b.text.length < 120)
      .slice(0, 10);
  });
  console.log("Ticket list items:", JSON.stringify(ticketItems, null, 2));

  // Click the first ticket-looking item
  const clicked = await page.evaluate(() => {
    const items = document.querySelectorAll("button, [role=button]");
    for (const it of items) {
      const t = it.textContent.trim();
      if (it.offsetParent !== null && /Bulk order|short supply|complaint|delivery|question/i.test(t) && t.length < 100) {
        it.click(); return t.slice(0, 60);
      }
    }
    return null;
  });
  console.log("Clicked ticket:", clicked);
  await page.waitForTimeout(1500);
  const detailText = await page.evaluate(() => {
    // Get the detail card text
    const cards = document.querySelectorAll("[class*='rounded'], .card, [class*='border']");
    for (const c of cards) {
      if (c.offsetParent !== null && /Customer's original message|original message|Ticket #|Subject/i.test(c.textContent)) {
        return c.textContent.slice(0, 600);
      }
    }
    return document.body.textContent.slice(0, 600);
  });
  console.log("Detail text:", detailText);

  // Specifically check for leadId-related content
  const hasLeadRef = await page.evaluate(() => {
    const t = document.body.textContent;
    return {
      viewCustomer: /View customer record/i.test(t),
      leadMention: /lead|customer record|Priya|Aarna|Raj|Bridal/i.test(t),
    };
  });
  console.log("Lead reference in detail:", JSON.stringify(hasLeadRef));

  await browser.close();
})();
