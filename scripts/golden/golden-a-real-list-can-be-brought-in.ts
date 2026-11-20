/**
 * Golden test — a customer can bring their own list of leads into the product.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Recorded in session 54 and left open: "There is no real CSV import. 'Upload
 * sample CSV' on Discovery loads two hardcoded rows ('Acme Trading Co',
 * 'Global Distributors') and opens no file picker."
 *
 * The route was never the problem. `POST /api/leads/upload-csv` parses headers
 * with Papa, maps six columns and creates leads. The screen simply never gave
 * it a file — it posted a string literal defined three lines above the button.
 * A prospect asking "how do I get my 400 customers in?" had no answer, and the
 * button that looked like the answer silently added two fictional companies to
 * their workspace.
 *
 * Two further faults surfaced while wiring the picker, both of which an
 * operator meets on their first real file rather than on the sample:
 *
 *   - Every parsed row became a lead, including a row carrying only a stray
 *     comma, which became a lead with no company name.
 *   - Uploading a corrected version of the same file doubled every lead, with
 *     nothing said. Re-importing after fixing a typo is the normal thing to do.
 *
 *   CASE A — the screen opens a file picker and posts what it read.
 *
 *   CASE B — no hardcoded sample rows remain. This is the actual defect: a
 *     button that appears to import and instead invents data is worse than no
 *     button.
 *
 *   CASE C — the route skips rows that identify no company, and says how many
 *     it skipped.
 *
 *   CASE D — re-importing the same list does not duplicate it, and the operator
 *     is told what was skipped rather than left to count rows.
 *
 *   CASE E — a phone number reaches `whatsappNumber`, not only `phone`.
 *     Inbound WhatsApp is matched on `whatsappNumber` (`resolveLead` in
 *     WhatsAppConversationEngine), so an imported list whose numbers never
 *     reached that field could not be recognised when those very customers
 *     messaged in — which is the loop the product exists for.
 *
 *   CASE F — the hand-typed form captures the contact details an operator
 *     already has. It took a company name and a website only, so a hand-built
 *     list scored 0 until enrichment ran, and enrichment needs an AI key.
 *
 * Substrate: static read of the route and the screen. No repository, no
 * network, no AI.
 */
import "./_helpers/isolate-standalone";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const ROUTE = "src/app/api/[[...path]]/route.ts";
const SCREEN = "src/app/page.tsx";
const ENGINE = "src/services/WhatsAppConversationEngine.ts";

function main() {
  console.log("=== GOLDEN: a real list can be brought in ===\n");

  const route = readSource(ROUTE);
  const screen = readSource(SCREEN);
  const manualForm = readSource("src/app/sections/ManualCustomerForm.tsx");
  const branch = route.slice(route.indexOf(`if (match(path, ["leads", "upload-csv"]))`));
  const importBranch = branch.slice(0, branch.indexOf("\n  if (match(path,"));
  assert(importBranch.length > 0, `setup: could not isolate the upload-csv branch in ${ROUTE}`);

  // ---------------------------------------------------------------- CASE A
  {
    assert(
      /type="file"/.test(screen) && /accept="\.csv/.test(screen),
      `CASE A: ${SCREEN} has no file input, so a customer cannot choose their own list`,
    );
    assert(
      /await file\.text\(\)/.test(screen),
      `CASE A: the chosen file is never read`,
    );
    assert(
      /csv: text/.test(screen),
      `CASE A: what was read is never sent to the import route`,
    );
    console.log("✅ CASE A — a real file is chosen, read and sent");
  }

  // ---------------------------------------------------------------- CASE B
  {
    // Comments are stripped first: this file explains the defect it fixed, and
    // naming the old rows in prose is not shipping them.
    const code = screen.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const invented of ["Acme Trading Co", "Global Distributors", "info@global.example"]) {
      assert(
        !code.includes(invented),
        `CASE B: ${SCREEN} still ships the hardcoded row "${invented}" — the button invents data instead of importing it`,
      );
    }
    assert(
      !/Upload sample CSV/.test(code),
      `CASE B: the button must no longer offer a sample instead of an import`,
    );
    console.log("✅ CASE B — no invented rows are added to a customer's workspace");
  }

  // ---------------------------------------------------------------- CASE C
  {
    // 2026-09-24: the route hands the file to LeadImportService, and the rules
    // themselves are proven by RUNNING imports in golden-csv-import-behaviour.
    // What stays here is what only the source can show: the route delegates,
    // and the screen shows the counts.
    assert(
      /importLeadsFromCsv\(/.test(importBranch),
      `CASE C: the upload route no longer uses the import service, so the tested rules do not apply to it`,
    );
    assert(
      /emptyRowsSkipped/.test(screen),
      `CASE C: the count of skipped rows must be reported and shown, or rows vanish unexplained`,
    );
    console.log("✅ CASE C — rows identifying no company are skipped, and counted");
  }

  // ---------------------------------------------------------------- CASE D
  {
    assert(
      /duplicatesSkipped/.test(screen),
      `CASE D: duplicates must be counted and shown`,
    );
    console.log("✅ CASE D — importing the same list twice does not duplicate it");
  }

  // ---------------------------------------------------------------- CASE E
  {
    const engine = readSource(ENGINE);
    assert(
      /item\.whatsappNumber && normalizePhone\(item\.whatsappNumber\)/.test(engine),
      `CASE E setup: ${ENGINE} no longer matches inbound on whatsappNumber — re-aim this case`,
    );
    assert(
      /<ManualCustomerForm/.test(screen) && /whatsappNumber: values\.phone/.test(screen) && /value\.trim\(\)/.test(manualForm),
      `CASE E: the same gap on the hand-typed form`,
    );
    console.log("✅ CASE E — imported numbers can be matched to inbound messages");
  }

  // ---------------------------------------------------------------- CASE F
  {
    for (const field of ["email", "phone", "city", "contactName"]) {
      assert(
        new RegExp(`\\["${field}",`).test(manualForm),
        `CASE F: the shared hand-typed lead form has no ${field} field`,
      );
    }
    console.log("✅ CASE F — a hand-typed lead can carry the details the operator already has");
  }

  console.log("\n=== GOLDEN PASSED (A-F) ===");
}

main();
