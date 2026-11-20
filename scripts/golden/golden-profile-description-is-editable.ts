/**
 * Golden test — the sentence the agent believes about this company can be changed.
 *
 * WHY THIS EXISTS (2026-09-08, session 54)
 * ----------------------------------------
 * Found by rebuilding the live demo workspace for a real manufacturer, not by
 * a test.
 *
 * `BusinessProfile.description` is not a blurb on a settings screen. It is
 * loaded by AgentContextBuilder and written into the context of EVERY AI reply
 * as `Description: ...` — it is, literally, what the agent believes the
 * business does before it drafts a word.
 *
 * The only thing in the product that ever set it was the website extractor,
 * which runs once. After that no screen could change it. The demo workspace had
 * been rebuilt end to end for a zari and metallic thread manufacturer — company
 * name, industry, address, products, policies, all correct on screen — while
 * the description still read "enterprise software solutions, including a Cloud
 * ERP System and an AI CRM", left over from the previous seed. Every reply the
 * agent drafted was reasoning from that.
 *
 * The PUT route has accepted the field since M2 (`businessProfileUpdateSchema`
 * is `.passthrough()`, and the handler writes the whole body). Nothing could
 * reach it. Third instance of the same defect family this session, after the
 * product price and the ticket assignee: the read side shipped, the write side
 * never existed.
 *
 *   CASE A — behavioural: PUT with a new description persists it.
 *
 *   CASE B — behavioural: the agent context built AFTER that write carries the
 *     new sentence and no longer carries the old one. This is the assertion
 *     that matters — persisting it somewhere the agent never reads would fix
 *     nothing.
 *
 *   CASE C — static: the profile screen contains a control that writes
 *     `description` onto the draft it saves. Without this the route can keep
 *     working perfectly while the operator has no way to reach it, which is the
 *     exact state this golden was written for.
 *
 * Substrate: runs on whichever provider the suite selects. No network, no AI.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createRepositories } from "@/repositories";
import { defaultWorkspaceId } from "@/lib/db";
import { buildAgentWorkspaceContext } from "@/services/AgentContextBuilder";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const WS = defaultWorkspaceId;
const SCREEN = "src/app/page.tsx";

const STALE = "The company provides enterprise software solutions, including a Cloud ERP System.";
const TRUE_DESCRIPTION =
  "Manufacturer of Kasab zari and metallic embroidery threads, supplying embroidery units and saree houses in Surat.";

async function putProfile(profileId: string, body: Record<string, unknown>) {
  const { PUT } = await import("@/app/api/[[...path]]/route");
  const request = new Request(`http://localhost/api/business-profile/${profileId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await PUT(
    request as never,
    { params: Promise.resolve({ path: ["business-profile", profileId] }) },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function main() {
  console.log("=== GOLDEN: the business description is editable ===\n");
  const repos = createRepositories();

  // Start from the stale-description state the demo was actually found in.
  let profile = await repos.businessProfile.getByWorkspace(WS);
  if (!profile) {
    profile = await repos.businessProfile.create({
      workspaceId: WS,
      companyName: "Om Jari & Metallic",
      industry: "Zari and embroidery thread manufacturing",
      description: STALE,
    } as never);
  } else {
    profile = await repos.businessProfile.update(WS, profile.id, { description: STALE } as never);
  }
  assert(profile?.id, "setup: no business profile to work with");

  const before = await buildAgentWorkspaceContext(WS, repos);
  assert(
    before.profileText.includes("Cloud ERP"),
    "setup: the agent context should be carrying the stale sentence before the fix is exercised",
  );

  // ---------------------------------------------------------------- CASE A
  {
    const { status, body } = await putProfile(profile.id, { ...profile, description: TRUE_DESCRIPTION });
    assert(status === 200, `CASE A: PUT returned HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);

    const reloaded = await repos.businessProfile.getByWorkspace(WS);
    assert(
      reloaded?.description === TRUE_DESCRIPTION,
      `CASE A: the new description must be stored, got ${JSON.stringify(reloaded?.description)}`,
    );
    console.log("✅ CASE A — a new description is persisted through the profile route");
  }

  // ---------------------------------------------------------------- CASE B
  {
    const after = await buildAgentWorkspaceContext(WS, repos);
    assert(
      after.profileText.includes(TRUE_DESCRIPTION),
      `CASE B: the agent must read the corrected sentence. Context was:\n${after.profileText.slice(0, 400)}`,
    );
    assert(
      !after.profileText.includes("Cloud ERP"),
      "CASE B: the stale sentence must be gone from the agent context — an edit the agent never sees is not a fix",
    );
    console.log("✅ CASE B — the corrected sentence reaches the context every AI reply is drafted from");
  }

  // ---------------------------------------------------------------- CASE C
  {
    const source = readSource(SCREEN);
    assert(
      /draft,\s*description:/.test(source),
      `CASE C: ${SCREEN} must contain a control that writes \`description\` onto the profile draft. ` +
      "Without one the field is set once by the website extractor and is unchangeable for the life of the workspace.",
    );
    console.log("✅ CASE C — the profile screen still has a control that edits the description");
  }

  console.log("\n✅✅✅ All profile-description golden cases PASSED (A–C). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
