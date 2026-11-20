/**
 * Golden test — a workspace can be emptied and a backup can be loaded back in,
 * without losing the one record that must never be lost.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Recorded in session 54 and left open: "No workspace reset and no backup
 * restore ('Loading a backup back in isn't built yet'). Cleaning a demo means
 * erasing leads one at a time."
 *
 * The export half shipped and was careful — owner-gated, rate-limited, scoped
 * to one workspace, secrets redacted. It ended at a sentence on the screen
 * saying the other half did not exist, and a disabled row reading "Restore:
 * Coming soon". So the product could produce a file it could not read, and an
 * operator preparing to show the demo to a second customer had to delete
 * fifty-three leads by hand.
 *
 * Both halves are destructive, which is why the interesting assertions here are
 * about what they refuse to do.
 *
 *   CASE A — both routes exist and are owner-only.
 *
 *   CASE B — both require the operator to TYPE the word. A boolean flag can be
 *     sent by a stray retry or a malformed client; "RESET" cannot arrive by
 *     accident.
 *
 *   CASE C — a reset does not delete the workspace or its members. Emptying the
 *     contents must not remove the operator's own access to the thing they
 *     emptied.
 *
 *   CASE D — a reset NEVER clears the do-not-contact registry. LOGIC.md is
 *     explicit that "DNC is permanent — clearing the lead flag does NOT remove
 *     them from the registry". A reset that emptied it would make everyone who
 *     ever opted out contactable again by re-importing the same list. This is
 *     the assertion that matters most in this file.
 *
 *   CASE E — a restore ADDS to the do-not-contact registry and never replaces
 *     it. Restoring a three-month-old backup must not resurrect contactability
 *     for somebody who opted out last week.
 *
 *   CASE F — a restore only writes collections the export itself produces, and
 *     re-stamps rows onto this workspace. An unknown key in a hand-edited file
 *     is ignored rather than written into the snapshot, and a backup taken from
 *     a different workspace id does not land as rows no query can see.
 *
 *   CASE G — the screen offers both, and stops saying they do not exist.
 *
 * Substrate: static read of the route and the screen, plus the reset helper
 * exercised directly. No repository, no network, no AI.
 */
import "./_helpers/isolate-standalone";
import type { AppData } from "@/lib/types";
import { clearWorkspaceData, resetTargetCollections } from "@/app/api/[[...path]]/route";
import { RESET_PRESERVED_COLLECTIONS } from "@/lib/workspace-reset";
import { RESET_COLLECTION_DELEGATES } from "@/repositories/prisma";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const ROUTE = "src/app/api/[[...path]]/route.ts";
const SCREEN = "src/app/page.tsx";

function main() {
  console.log("=== GOLDEN: a backup can be loaded back in ===\n");

  const route = readSource(ROUTE);
  const screen = readSource(SCREEN);
  const restoreService = readSource("src/services/WorkspaceRestoreService.ts");
  const resetBranch = route.slice(route.indexOf(`if (match(path, ["data", "reset"]))`), route.indexOf(`if (match(path, ["data", "restore"]))`));
  const restoreStart = route.indexOf(`if (match(path, ["data", "restore"]))`);
  const restoreBranch = route.slice(restoreStart, route.indexOf(`if (match(path, ["leads", "manual"]))`, restoreStart));
  assert(resetBranch.length > 0 && restoreBranch.length > 0, `setup: could not isolate both branches in ${ROUTE}`);

  // ---------------------------------------------------------------- CASE A
  {
    for (const [label, branch] of [["reset", resetBranch], ["restore", restoreBranch]] as const) {
      assert(
        /requireRole\(request, "owner"\)/.test(branch),
        `CASE A: the ${label} route is not owner-only`,
      );
    }
    console.log("✅ CASE A — both routes exist and are owner-only");
  }

  // ---------------------------------------------------------------- CASE B
  {
    assert(/!== "RESET"/.test(resetBranch), `CASE B: reset does not require the word to be typed`);
    assert(/!== "RESTORE"/.test(restoreBranch), `CASE B: restore does not require the word to be typed`);
    assert(
      /resetConfirm !== "RESET"/.test(screen) && /restoreConfirm !== "RESTORE"/.test(screen),
      `CASE B: ${SCREEN} must keep the buttons disabled until the word is typed`,
    );
    console.log("✅ CASE B — both make the operator type the word");
  }

  // ---------------------------------------------------------------- CASE C / D
  {
    for (const preserved of ["workspaces", "workspaceMembers", "doNotContactRegistry"]) {
      assert(
        (RESET_PRESERVED_COLLECTIONS as readonly string[]).includes(preserved),
        `CASE C/D: "${preserved}" is not preserved by a reset`,
      );
    }

    // Exercise the real helper, not a description of it.
    const data = {
      workspaces: [{ id: "w1" }, { id: "w2" }],
      workspaceMembers: [{ workspaceId: "w1" }, { workspaceId: "w2" }],
      doNotContactRegistry: [{ workspaceId: "w1", contactValue: "+919999999999" }],
      leads: [{ workspaceId: "w1" }, { workspaceId: "w1" }, { workspaceId: "w2" }],
      tickets: [{ workspaceId: "w1" }],
    } as unknown as AppData;
    const removed = clearWorkspaceData(data, "w1");
    const bag = data as unknown as Record<string, unknown[]>;

    assert(bag.leads.length === 1, `CASE C: this workspace's leads must go, and only this workspace's — ${bag.leads.length} left`);
    assert(bag.tickets.length === 0, "CASE C: this workspace's tickets must go");
    assert(bag.workspaces.length === 2, "CASE C: a reset must not delete the workspace itself");
    assert(bag.workspaceMembers.length === 2, "CASE C: a reset must not delete the operator's own membership");
    assert(removed.leads === 2, `CASE C: the reset must report what it removed, got ${JSON.stringify(removed)}`);
    console.log("✅ CASE C — the contents go, the workspace and its people stay");

    assert(
      bag.doNotContactRegistry.length === 1,
      "CASE D: a reset emptied the do-not-contact registry — everyone who opted out would become contactable again",
    );
    console.log("✅ CASE D — the do-not-contact registry survives a reset");
  }

  // ---------------------------------------------------------------- CASE D2
  {
    // Found live on 2026-09-09 by pressing the button on Postgres: the reset
    // ran through `repos.mutateAll`, whose Postgres writer is upsert-only, so
    // the silent-removal guard refused it — "Empty this workspace" answered 400
    // and removed nothing on the substrate production runs on. Every earlier
    // assertion passed because they all exercised the JSON-shaped helper on a
    // plain object. A reset has to go through a repository that can DELETE.
    assert(
      /repos\.clearWorkspaceCollections\(/.test(resetBranch),
      "CASE D2: the reset still writes through mutateAll, which cannot delete a single row on Postgres",
    );
    assert(
      !/mutateAll\(\(data\) => clearWorkspaceData/.test(resetBranch),
      "CASE D2: the reset must not clear a workspace by mutating the snapshot",
    );

    // And the Postgres side must know a table for every collection the reset
    // clears, or those rows quietly survive.
    const unmapped = resetTargetCollections().filter((key) => !RESET_COLLECTION_DELEGATES[key]);
    assert(
      unmapped.length === 0,
      `CASE D2: no Postgres table is mapped for ${unmapped.join(", ")} — a reset would leave those rows behind`,
    );
    // The reverse too: a mapping for something a reset never clears is either
    // dead or a preserved collection about to be deleted by accident.
    const targets = new Set(resetTargetCollections());
    const stray = Object.keys(RESET_COLLECTION_DELEGATES).filter((key) => !targets.has(key));
    assert(
      stray.length === 0,
      `CASE D2: ${stray.join(", ")} is mapped for deletion but is not a collection the reset clears`,
    );
    // The restore had the identical defect and the identical symptom: it
    // cleared the collections INSIDE the same mutateAll that wrote the backup
    // rows, so Postgres refused the whole call and restored nothing. The clear
    // has to be a repository delete; the snapshot write may only ADD.
    assert(
      /restoreWorkspaceAtomically\(/.test(restoreBranch) && /repos\.clearWorkspaceCollections!\(/.test(restoreService),
      "CASE D2: the restore still clears the workspace inside mutateAll, which Postgres refuses outright",
    );
    assert(
      !/clearWorkspaceData\(data, workspaceId\)/.test(restoreBranch),
      "CASE D2: the restore must not clear by mutating the snapshot",
    );
    console.log("✅ CASE D2 — reset and restore both delete on the substrate production runs on");
  }

  // ---------------------------------------------------------------- CASE E
  {
    assert(
      /if \(key === "doNotContactRegistry"\) continue;/.test(restoreBranch),
      `CASE E: restore replaces the do-not-contact registry wholesale — an older backup would resurrect contactability`,
    );
    assert(
      /existingDncKeys\.has\(key\)/.test(restoreBranch),
      `CASE E: restore must merge do-not-contact entries, skipping ones already registered`,
    );
    // The merge has to compare the CONTACT. The first version keyed on
    // `contactValue`, which DoNotContactEntry does not have, so every
    // comparison fell through to the row id and the same phone under a new id
    // was re-added.
    assert(
      /normalizedPhone/.test(restoreBranch) && /normalizedEmail/.test(restoreBranch),
      `CASE E: the do-not-contact merge must compare the contact, not the row id`,
    );
    // Comments stripped first: the route explains this mistake in prose, and a
    // golden that reads the explanation as the code would fail forever.
    const restoreCode = restoreBranch.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
    assert(
      !/contactValue/.test(restoreCode),
      `CASE E: contactValue is not a field on DoNotContactEntry — comparing it silently compares nothing`,
    );
    console.log("✅ CASE E — a restore only ever adds to the do-not-contact list");
  }

  // ---------------------------------------------------------------- CASE F
  {
    assert(
      /knownCollections\.has\(key\)/.test(restoreBranch),
      `CASE F: restore writes whatever keys the file carries, including ones the export never produces`,
    );
    assert(
      /\(row\) => \(\{ \.\.\.stripRedactedValues\(row\), workspaceId \}\)/.test(restoreBranch),
      `CASE F: restored rows must be re-stamped onto this workspace (and stripped of masked values), or a backup from another workspace lands invisible to every query`,
    );
    // Found live: restore reported "restoredRows: 2342" on Postgres while the
    // database held nothing, because mutateAll upserts fifteen of the
    // fifty-five collections a workspace has. It now writes through the
    // repositories and REPORTS what it could not write.
    assert(
      /restoreWorkspaceAtomically\(/.test(restoreBranch) && /restoreWorkspaceCollections\(/.test(restoreService),
      `CASE F: restore still writes through the snapshot, which cannot persist leads, campaigns, tickets, quotes or orders on Postgres`,
    );
    assert(
      /unsupportedCollections/.test(restoreBranch) && /failedRowCount/.test(restoreBranch),
      `CASE F: a restore must report what it could not bring back — reporting only successes is how a silent no-op reads as 2342 rows restored`,
    );
    console.log("✅ CASE F — only known collections are written, onto this workspace, and gaps are reported");
  }

  // ---------------------------------------------------------------- CASE G
  {
    assert(
      !/Loading a backup back in isn/.test(screen),
      `CASE G: ${SCREEN} still says restore is not built`,
    );
    assert(
      !/Coming soon/.test(screen.slice(screen.indexOf("function ExportBackup"), screen.indexOf("function ExportBackup") + 6000)),
      `CASE G: the Export/Backup screen still advertises restore as coming soon`,
    );
    assert(
      /\/api\/data\/restore/.test(screen) && /\/api\/data\/reset/.test(screen),
      `CASE G: the screen must actually call both routes`,
    );
    console.log("✅ CASE G — the screen offers both, and no longer says they do not exist");
  }

  console.log("\n=== GOLDEN PASSED (A-G) ===");
}

main();
