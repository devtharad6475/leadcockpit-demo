/**
 * Golden test — the screens must not tell the operator something the code
 * contradicts (N-UX-5 … N-UX-9).
 *
 * WHY THIS EXISTS (2026-08-20)
 * ----------------------------
 * Session 10's UI/UX pass found five defects that share one shape: **the
 * interface made a claim the code underneath had stopped honouring.** None of
 * them was a rendering bug, none would be caught by a screenshot, and the
 * worst of them was a safety mislabel on a button that really sends a message
 * to a paying customer.
 *
 *   CASE A (N-UX-5) — The AI review queue said "Approving here does not send
 *     WhatsApp yet; it only records your review decision." Its Approve button
 *     calls approveAutoReplyLog, which golden-whatsapp-outbound-send proves
 *     ends in a real POST to Meta. The sentence was true before the send path
 *     was wired and nobody revisited it. An operator was told the button was
 *     inert while it messaged their customer.
 *
 *   CASE B (N-UX-6) — the same card never named the recipient, so the operator
 *     approved a send to somebody they could not see.
 *
 *   CASE C (N-UX-7) — the dashboard's pipeline stage table was mutually
 *     exclusive but NOT exhaustive: it covered 9 of 26 statuses and matched 6
 *     strings LeadStatus cannot hold, so one bar was structurally dead and two
 *     thirds of the leads appeared nowhere. Percentages used the sum of the
 *     bars as the denominator while the card header printed the lead count
 *     directly above them.
 *
 *   CASE D (N-UX-8) — "Conversation so far" rendered
 *     `convSummary?.summary || <Skeleton/>`. The 2026-08-05 fix for an
 *     infinite skeleton set `{ summary: "", mode: "error" }` on failure; an
 *     empty string is falsy, so the failure path rendered the very shimmer the
 *     fix was written to remove.
 *
 *   CASE E (N-UX-9) — a search field's `pl-9` was silently dead because an
 *     unlayered `.input` rule beats Tailwind's layered utilities, so the icon
 *     printed on top of the placeholder.
 *
 * CASE C is a real runtime check — it imports PIPELINE_STAGES and compares it
 * against the LeadStatus union parsed out of the type source, so a status
 * added tomorrow and forgotten fails here immediately. The others are static
 * source assertions, which is the honest instrument available without a
 * browser: each pins the SPECIFIC contradiction, so restoring the old code
 * fails the golden even though the screen still renders.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts \
 *        scripts/golden/golden-operator-screen-honesty.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PIPELINE_STAGES } from "@/lib/lead-pipeline";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const page = readFileSync(resolve("src/app/page.tsx"), "utf8");
const css = readFileSync(resolve("src/app/globals.css"), "utf8");

/** The AI review queue component body, so assertions cannot pass on some other screen. */
function reviewQueueBody(): string {
  const start = page.indexOf("function AIReviewQueue(");
  assert(start > 0, "could not locate AIReviewQueue in src/app/page.tsx — this golden's source parse needs updating");
  const end = page.indexOf("\nfunction ", start + 1);
  return page.slice(start, end > 0 ? end : undefined);
}

/**
 * Comments explain defects; they do not render. The source comment recording
 * why the false sentence was removed necessarily quotes it, so CASE A must
 * scan what the operator sees, not what the file says about itself.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** The page as the operator gets it — comments removed. */
const rendered = stripComments(page);

async function main() {
  // ─── CASE A: the send button must not be described as inert ───────────────
  {
    const body = reviewQueueBody();
    const approvesByApi = /auto-reply-logs\/\$\{item\.id\}\/approve/.test(body);
    assert(approvesByApi, "CASE A: the Approve button no longer posts to /approve — re-derive this golden against the new handler before trusting it");

    // The exact claim that was false. Matched loosely so a reworded version of
    // the same lie ("does not send", "doesn't send", "will not send") fails too.
    const deniesSending = /does ?n[o’']?t send|will not send|only records your review/i.test(stripComments(body));
    assert(
      !deniesSending,
      "CASE A: the AI review queue tells the operator that approving does NOT send, but its Approve button calls " +
      "/api/auto-reply-logs/:id/approve → approveAutoReplyLog → sendApprovedReply → a real Meta send. " +
      "A send button described as inert is a safety defect, not a copy nit. Say plainly that approving sends.",
    );
    const admitsSending = /Approving sends this reply/i.test(body);
    assert(admitsSending, "CASE A: the screen must state that approving sends the reply to the customer");
    console.log("✅ CASE A (N-UX-5) — the approve screen states that approving sends, and nothing on it denies sending");
  }

  // ─── CASE B: the operator must be told who receives the message ───────────
  {
    const body = reviewQueueBody();
    assert(/leads: Lead\[\]/.test(body), "CASE B: AIReviewQueue must receive the leads it needs to name the recipient");
    assert(/leadById/.test(body) && /item\.leadId/.test(body), "CASE B: the card must look the lead up by item.leadId");
    assert(/whatsappNumber \|\| lead\?\.phone/.test(body), "CASE B: the card must show the destination (WhatsApp number, phone or email)");
    // 2026-09-03 — this used to pin the WHOLE tag,
    // `<AIReviewQueue run={run} leads={leads} />`, so adding any unrelated prop
    // broke it (it did: the screen gained `setActive` so its empty state could
    // offer a way out instead of dead-ending). Pinning the whole tag asserts
    // more than this case means: the case is about the RECIPIENT being
    // knowable, which needs `leads` and nothing else. It still fails if `leads`
    // stops being passed — that is the defect — but no longer fails on props it
    // has no opinion about.
    //
    // Written with a literal space and a negated character class rather than
    // a word boundary: this repo has now lost five hours to backslash-letter
    // escapes being eaten by one layer or another, and a regex that silently
    // matches nothing is the worst possible failure for a test.
    assert(
      /<AIReviewQueue [^>]*leads=\{leads\}/.test(page),
      "CASE B: the call site must pass leads into AIReviewQueue",
    );
    console.log("✅ CASE B (N-UX-6) — the approve card names the lead and the destination it will send to");
  }

  // ─── CASE C: the pipeline chart must account for every lead ───────────────
  {
    const types = readFileSync(resolve("src/lib/types.ts"), "utf8");
    const match = types.match(/export type LeadStatus =([\s\S]*?);/);
    assert(match, "CASE C: could not locate the LeadStatus union in src/lib/types.ts");
    const union = [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    assert(union.length >= 20, `CASE C: parsed only ${union.length} statuses — the source parse is broken, not the code`);

    const covered = PIPELINE_STAGES.flatMap((s) => s.statuses as string[]);
    const uncovered = union.filter((s) => !covered.includes(s));
    assert(
      uncovered.length === 0,
      `CASE C: ${uncovered.length} LeadStatus value(s) appear in no pipeline stage: [${uncovered.join(", ")}]. ` +
      "Leads in those statuses are invisible on the dashboard while the card header still counts them, so the bars " +
      "contradict the total printed above them. Add each to a stage in src/lib/lead-pipeline.ts.",
    );

    const duplicated = covered.filter((s, i) => covered.indexOf(s) !== i);
    assert(duplicated.length === 0, `CASE C: status(es) [${[...new Set(duplicated)].join(", ")}] appear in more than one stage — bars would double-count and percentages would exceed 100%`);

    const invented = covered.filter((s) => !union.includes(s));
    assert(invented.length === 0, `CASE C: stage(s) match value(s) LeadStatus cannot hold: [${invented.join(", ")}] — those bars can only ever read zero`);

    // The denominator half of the same defect.
    assert(/const stageDefs = PIPELINE_STAGES;/.test(page), "CASE C: the dashboard must use the shared stage table, not a private copy");
    assert(/const totalForBars = Math\.max\(1, leads\.length\);/.test(page),
      "CASE C: pipeline percentages must be computed against leads.length. Using the sum of the bars makes each bar a " +
      "percentage of the leads the chart happens to show, while the card header prints the true lead count right above it.");
    console.log(`✅ CASE C (N-UX-7) — all ${union.length} statuses land in exactly one of ${PIPELINE_STAGES.length} stages; denominator is leads.length`);
  }

  // ─── CASE D: loading must mean loading ────────────────────────────────────
  {
    assert(!/convSummary\?\.summary \|\| <Skeleton/.test(rendered),
      "CASE D: `convSummary?.summary || <Skeleton/>` is back. An errored summary is the empty string, which is falsy, " +
      "so this renders a loading shimmer forever on a request that already failed.");
    // 2026-09-04 — this used to be `/convSummary === null \? \(\s*<Skeleton/`,
    // which pinned the SHAPE of the source (the shimmer had to be the literal
    // next thing after the ternary opened) rather than the PROPERTY it exists
    // to protect (the shimmer appears in the loading branch and nowhere else).
    // Adding a line of text above the shimmer — "Reading the conversation…",
    // N-UX-19 — broke the shape while leaving the property untouched.
    //
    // Re-derived to check the property directly, and it is now STRICTER than
    // what it replaced: the old regex never checked that the error and loaded
    // branches were shimmer-free, so a stray <Skeleton> in the error branch —
    // exactly the N-UX-8 bug — would have passed it.
    const loadingStart = rendered.indexOf("convSummary === null ? (");
    assert(loadingStart >= 0, "CASE D: the loading branch must still be keyed on `convSummary === null` — that is what makes a failed load stop shimmering");
    const branchEnd = rendered.indexOf('convSummary.mode === "error"', loadingStart);
    assert(branchEnd > loadingStart, "CASE D: the error branch must follow the loading branch in the same expression");
    const loadingBranch = rendered.slice(loadingStart, branchEnd);
    const afterLoading = rendered.slice(branchEnd);
    assert(/<Skeleton/.test(loadingBranch), "CASE D: the shimmer must render while the summary is genuinely still loading (state null)");
    assert(!/<Skeleton/.test(afterLoading), "CASE D: a <Skeleton> renders after the loading branch. A shimmer in the error or loaded branch tells the operator to keep waiting for something that already finished — that is the N-UX-8 bug returning.");
    assert(/convSummary\.mode === "error"/.test(rendered) && /Try again/.test(rendered), "CASE D: a failed summary must say so and offer a retry");
    console.log("✅ CASE D (N-UX-8) — the shimmer is tied to the loading state alone; failure renders an error plus a retry");
  }

  // ─── CASE E: a utility that cannot win must not be relied on ──────────────
  {
    assert(!/className="input pl-9"/.test(rendered),
      "CASE E: class=\"input pl-9\" is back. Tailwind v4 puts utilities in @layer utilities and .input is unlayered, " +
      "so the unlayered padding wins and the leading icon prints on top of the placeholder text.");
    assert(/\.input\.has-leading-icon\s*\{[^}]*padding-left/.test(css), "CASE E: .input.has-leading-icon must reserve room for the icon in the same unlayered rule that overrides utilities");
    assert(/className="input has-leading-icon"/.test(rendered), "CASE E: the search field must use the dedicated class");
    console.log("✅ CASE E (N-UX-9) — the icon's room comes from a rule that can actually win the cascade");
  }

  console.log("\n✅✅✅ All operator-screen-honesty golden cases PASSED (A–E). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
