/**
 * Corrected probe — actually click a ticket ROW (not the nav) and verify the
 * "View customer record" link appears in the detail.
 */
const { chromium } = require("playwright");
const BASE = process.env.COCKPIT_URL || "http://localhost:3001";
let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d?" — "+d:""}`); } };

(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + "/", { waitUntil: "commit", timeout: 60000 });
  await page.waitForTimeout(2500);
  const demoBtn = page.getByRole("button", { name: /continue in demo mode/i });
  if (await demoBtn.isVisible({ timeout: 4000 }).catch(() => false)) await demoBtn.click();
  await page.waitForTimeout(3000);

  await page.evaluate((label) => {
    const btns = Array.from(document.querySelectorAll("button"));
    const t = btns.find(b => b.textContent.trim() === label);
    t && t.click();
  }, "Tickets");
  await page.waitForTimeout(2000);

  // The ticket list is a Table. Click the first ROW's main cell (subject).
  // The Tickets section renders a <TableBody><TableRow>. Click the row that
  // contains a ticket number.
  const clickedRow = await page.evaluate(() => {
    const rows = document.querySelectorAll("tr, [role=row], button, div");
    for (const r of rows) {
      const t = r.textContent || "";
      if (r.offsetParent !== null && /#\d.*Bulk order|#\d.*Delayed|#\d.*Care/i.test(t) && t.length < 200) {
        // Prefer the inner clickable element
        const inner = r.querySelector("button, [role=button], [class*='cursor-pointer']") || r;
        inner.click();
        return t.trim().slice(0, 60);
      }
    }
    return null;
  });
  console.log("Clicked row:", clickedRow);
  await page.waitForTimeout(1500);

  const detailHasLink = await page.evaluate(() => {
    const t = document.body.textContent;
    return {
      viewCustomer: /View customer record/i.test(t),
      externalLink: !!document.querySelector("[class*='text-primary'] svg, a:has(svg), button:has-text('View customer')"),
    };
  });
  check("ticket-detail-has-view-customer-link", detailHasLink.viewCustomer, JSON.stringify(detailHasLink));

  // Now verify clicking it navigates to CRM
  if (detailHasLink.viewCustomer) {
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll("button")).find(x => /View customer record/i.test(x.textContent));
      b && b.click();
    });
    await page.waitForTimeout(1500);
    const onCrm = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return h1 ? h1.textContent.trim() : "";
    });
    check("view-customer-navigates-to-crm", /leads/i.test(onCrm), `h1 = "${onCrm}"`);
  }

  await browser.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})();
