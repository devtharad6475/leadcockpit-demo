/**
 * Golden test — the ticket assignment the product implements can actually be
 * switched on by the owner it is built for.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found on the live demo while checking whether a complaint routes to the
 * right person. A customer message about a shade mismatch in lot OJ-2291
 * correctly raised a ticket at priority "high" — and it came back
 * `assignedTo: null`, as did every other ticket in the workspace.
 *
 * That was not a bug in the routing. `assignTicket` has implemented all three
 * modes since 2026-07-21 — manual, auto_rule with first-match-wins rules, and
 * round_robin with a persisted pointer — and `TicketService.createTicket`
 * calls it on every single ticket, writes an "assigned" event, and advances
 * the pointer. The whole mechanism was correct and complete.
 *
 * It simply could not be reached. `assignmentMode` and `assignmentRules` are
 * fields of TicketSlaSettings, and the only route that writes those settings
 * destructured eight fields, not those two, and merged only those eight. The
 * only screen that posts to it sent four. So every workspace was pinned to
 * "manual" forever, and the auto_rule and round_robin branches were dead code
 * in production — reachable only by writing to the database by hand, which is
 * not something an owner can do.
 *
 * This is the seventh instance of one shape in three sessions: an engine built
 * and wired, with the one control that turns it on never shipped.
 *
 *   CASE A — the write route accepts the mode. Without it the setting cannot
 *     leave "manual" by any means the product offers.
 *
 *   CASE B — the route accepts the rules too. Shipping auto_rule with no way
 *     to add a rule would be the same defect one layer down: a mode the owner
 *     can select that assigns nobody.
 *
 *   CASE C — EVERY mode the service implements is accepted by the route. This
 *     is the property that matters: one unreachable mode is exactly how this
 *     started, and a fix that shipped round_robin alone would pass CASE A.
 *
 *   CASE D — a rule may not name somebody who is not active staff. TicketService
 *     drops members whose userId is null (a pending invitee), so a rule pointing
 *     at one would silently route tickets to nobody while reporting success.
 *
 *   CASE E — the settings screen renders the control and saves it, and offers
 *     only people who could actually receive a ticket.
 *
 *   CASE F — the modes are still merged into what gets persisted. Accepting a
 *     field and then dropping it before the upsert is how the original defect
 *     read from three feet away.
 *
 * Substrate: static read of the route, the screen and the service's own mode
 * list. No repository, no network, no AI.
 */
import "./_helpers/isolate-standalone";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const SERVICE = "src/services/TicketService.ts";
const ROUTE = "src/app/api/[[...path]]/route.ts";
const SCREEN = "src/app/sections/WorkspaceSettings.tsx";

function main() {
  console.log("=== GOLDEN: a raised ticket can be routed to somebody ===\n");

  const service = readSource(SERVICE);
  const route = readSource(ROUTE);
  const screen = readSource(SCREEN);

  // The POST branch only. The path also matches a GET further up the file, and
  // asserting against the whole file would let a read-only route pass.
  const writeBranch = route.slice(route.indexOf(`if (match(path, ["tickets", "sla-settings"]) && request.method === "POST")`));
  assert(writeBranch.length > 0, `setup: no POST branch for /api/tickets/sla-settings in ${ROUTE}`);
  const upsertAt = writeBranch.indexOf("ticketSlaSettings.upsertForWorkspace");
  assert(upsertAt > 0, `setup: the POST branch no longer persists settings`);
  const beforeUpsert = writeBranch.slice(0, upsertAt);

  // ---------------------------------------------------------------- CASE A
  {
    assert(
      /const \{[^}]*\bassignmentMode\b/.test(beforeUpsert),
      `CASE A: the POST branch never reads assignmentMode from the body — the workspace is pinned to "manual"`,
    );
    console.log("✅ CASE A — the route accepts the assignment mode");
  }

  // ---------------------------------------------------------------- CASE B
  {
    assert(
      /const \{[^}]*\bassignmentRules\b/.test(beforeUpsert),
      `CASE B: the POST branch never reads assignmentRules — auto_rule would be selectable and assign nobody`,
    );
    console.log("✅ CASE B — the route accepts the rules that auto_rule needs");
  }

  // ---------------------------------------------------------------- CASE C
  {
    // Taken from the service itself, so a fourth mode added later is covered
    // without editing this golden.
    const modes = Array.from(
      new Set((service.match(/settings\.assignmentMode === "(\w+)"/g) || []).map((hit) => hit.replace(/.*"(\w+)"$/, "$1"))),
    );
    assert(modes.length >= 3, `CASE C setup: expected at least 3 modes in ${SERVICE}, found ${modes.join(", ") || "none"}`);
    const unreachable = modes.filter((mode) => !new RegExp(`"${mode}"`).test(beforeUpsert));
    assert(
      unreachable.length === 0,
      `CASE C: ${unreachable.join(", ")} is implemented in ${SERVICE} but cannot be selected through ${ROUTE}`,
    );
    console.log(`✅ CASE C — all ${modes.length} implemented modes are reachable: ${modes.join(", ")}`);
  }

  // ---------------------------------------------------------------- CASE D
  {
    assert(
      /listActiveStaffForWorkspace\(workspaceId\)/.test(beforeUpsert),
      `CASE D: the route accepts an assignee without checking they are active staff — tickets would route to nobody and report success`,
    );
    assert(
      /is not active staff in this workspace/.test(beforeUpsert),
      `CASE D: the route must reject a rule naming somebody who cannot receive a ticket`,
    );
    console.log("✅ CASE D — a rule cannot name somebody who could never receive the ticket");
  }

  // ---------------------------------------------------------------- CASE E
  {
    assert(
      /assignmentMode: assignMode/.test(screen),
      `CASE E: ${SCREEN} never sends an assignment mode, so the route's new field has no way to be set`,
    );
    assert(
      /id="ticket-assignment-mode"/.test(screen),
      `CASE E: ${SCREEN} has no control for it — a route with no screen leaves the owner exactly where they were`,
    );
    assert(
      /assignmentRules:/.test(screen),
      `CASE E: ${SCREEN} must be able to send rules, not only the mode`,
    );
    assert(
      /member\.userId && member\.status === "active" && member\.role !== "viewer"/.test(screen),
      `CASE E: ${SCREEN} must not offer a pending invitee as an assignee — TicketService drops them`,
    );
    console.log("✅ CASE E — the screen offers the control, the rules, and only real assignees");
  }

  // ---------------------------------------------------------------- CASE F
  {
    const merge = writeBranch.slice(writeBranch.indexOf("const merged = {"), upsertAt);
    assert(
      /assignmentMode !== undefined \? \{ assignmentMode \}/.test(merge),
      `CASE F: assignmentMode is read from the body but never merged into what is saved`,
    );
    assert(
      /assignmentRules !== undefined \? \{ assignmentRules \}/.test(merge),
      `CASE F: assignmentRules is read from the body but never merged into what is saved`,
    );
    console.log("✅ CASE F — both fields survive as far as the write");
  }

  console.log("\n=== GOLDEN PASSED (A-F) ===");
}

main();
