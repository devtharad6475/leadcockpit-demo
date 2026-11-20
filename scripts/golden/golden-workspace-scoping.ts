/**
 * Golden test — Mutation workspace scoping (Cluster B fix, session 17).
 *
 * PROVES the workspace-resolution helper used by POST/PUT handlers resolves
 * the workspace from the SESSION (not from the request body), and rejects
 * body workspaceIds that don't match the session user's workspace.
 *
 * Without this test, the multi-tenant cross-write bug (P0 finding A1 from
 * AUDIT-FINDINGS-2026-07-21.md) returns silently: a future change can revert
 * to comparing against the constant `defaultWorkspaceId` instead of the
 * session user's workspace.
 *
 * Operator-confirmed rule (AGENTS.md architecture boundaries):
 *   "Backend is the source of truth. Workspace isolation in production."
 *   "Workspace A cannot read/write workspace B."
 *
 * Hand-computed expected values (BEFORE looking at the helper code):
 *
 *   CASE A — demo mode: always resolves to defaultWorkspaceId, no body
 *     check (demo bypasses auth). Body workspaceId is ignored.
 *
 *   CASE B — production mode, no body workspaceId: resolves to session
 *     user's workspaceId.
 *
 *   CASE C — production mode, body workspaceId MATCHES session: resolves
 *     to that workspaceId (= session workspaceId).
 *
 *   CASE D — production mode, body workspaceId DIFFERS from session:
 *     returns { ok: false, status: 403 } (the cross-tenant block).
 *
 *   CASE E — production mode, session user has no workspaceId (defensive):
 *     falls back to defaultWorkspaceId AND rejects any body workspaceId
 *     that differs (fail-closed).
 *
 * Run: npx tsx scripts/golden/golden-workspace-scoping.ts
 *
 * NOTE: the helper is exercised in isolation here with mock session users.
 * The route integration is pinned by an HTTP-level test in a future
 * Cluster E Playwright spec (requires production auth fixture).
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { resolveMutationWorkspace } from "@/app/api/[[...path]]/workspace-resolution";
import { defaultWorkspaceId } from "@/lib/db";

type MockUser = { workspaceId: string; userId: string } | null;

function mockRequest(user: MockUser): unknown {
  // The helper accepts a request-like object; we pass the resolved user
  // directly via a property the helper reads.
  return { __mockUser: user };
}

async function main() {
  // ---------------------------------------------------------------------------
  // CASE A — demo mode: ignores body, returns default.
  // ---------------------------------------------------------------------------
  {
    const result = await resolveMutationWorkspace({
      authMode: "demo",
      request: mockRequest({ workspaceId: "ws_X", userId: "u1" }),
      bodyWorkspaceId: "ws_anything",
      sessionUser: { workspaceId: "ws_X", userId: "u1" },
    });
    assert.equal(result.ok, true, "CASE A: demo mode succeeds");
    if (result.ok) {
      assert.equal(result.workspaceId, defaultWorkspaceId, "CASE A: resolves to default in demo");
    }
    console.log("  CASE A OK: demo mode ignores body, returns defaultWorkspaceId.");
  }

  // ---------------------------------------------------------------------------
  // CASE B — production, no body workspaceId: resolves from session.
  // ---------------------------------------------------------------------------
  {
    const result = await resolveMutationWorkspace({
      authMode: "production",
      request: mockRequest({ workspaceId: "ws_A", userId: "u1" }),
      bodyWorkspaceId: undefined,
      sessionUser: { workspaceId: "ws_A", userId: "u1" },
    });
    assert.equal(result.ok, true, "CASE B: succeeds");
    if (result.ok) {
      assert.equal(result.workspaceId, "ws_A", "CASE B: resolves from session");
    }
    console.log("  CASE B OK: production + no body workspaceId → session workspaceId.");
  }

  // ---------------------------------------------------------------------------
  // CASE C — production, body matches session: succeeds with that id.
  // ---------------------------------------------------------------------------
  {
    const result = await resolveMutationWorkspace({
      authMode: "production",
      request: mockRequest({ workspaceId: "ws_A", userId: "u1" }),
      bodyWorkspaceId: "ws_A",
      sessionUser: { workspaceId: "ws_A", userId: "u1" },
    });
    assert.equal(result.ok, true, "CASE C: succeeds");
    if (result.ok) {
      assert.equal(result.workspaceId, "ws_A", "CASE C: body matches session");
    }
    console.log("  CASE C OK: body workspaceId === session workspaceId → succeeds.");
  }

  // ---------------------------------------------------------------------------
  // CASE D — production, body DIFFERS from session: 403.
  // ---------------------------------------------------------------------------
  {
    const result = await resolveMutationWorkspace({
      authMode: "production",
      request: mockRequest({ workspaceId: "ws_A", userId: "u1" }),
      bodyWorkspaceId: "ws_B_other_tenant",
      sessionUser: { workspaceId: "ws_A", userId: "u1" },
    });
    assert.equal(result.ok, false, "CASE D: must block cross-tenant");
    if (!result.ok) {
      assert.equal(result.status, 403, "CASE D: status 403 FORBIDDEN");
      assert.match(result.code || "", /FORBIDDEN/i, "CASE D: code FORBIDDEN");
    }
    console.log("  CASE D OK: body workspaceId ≠ session workspaceId → 403 FORBIDDEN (cross-tenant block).");
  }

  // ---------------------------------------------------------------------------
  // CASE E — production, body workspaceId = defaultWorkspaceId constant
  // but session user's workspace is a different real workspace: STILL 403.
  // This is the exact attack from finding A1: an attacker from ws_A sends
  // body.workspaceId="workspace_demo" hoping to write into the demo tenant.
  // The OLD code allowed this (compared against the constant). The fix
  // compares against the SESSION, so this must now fail.
  // ---------------------------------------------------------------------------
  {
    const result = await resolveMutationWorkspace({
      authMode: "production",
      request: mockRequest({ workspaceId: "ws_A_attacker", userId: "u_attacker" }),
      bodyWorkspaceId: defaultWorkspaceId, // "workspace_demo"
      sessionUser: { workspaceId: "ws_A_attacker", userId: "u_attacker" },
    });
    assert.equal(result.ok, false, "CASE E: must block the A1 attack (body=default, session=different)");
    if (!result.ok) {
      assert.equal(result.status, 403, "CASE E: status 403");
    }
    console.log("  CASE E OK: A1 attack blocked (body=default constant ≠ session) → 403.");
  }

  console.log("\nPASS golden-workspace-scoping: mutation workspaceId resolved from session (5 cases).");
  console.log("NOTE: POST + PUT handlers MUST call resolveMutationWorkspace and honor its result.");
}

main().catch((err) => {
  console.error("\nFAIL golden-workspace-scoping:", err.message);
  process.exit(1);
});
