/**
 * golden-credential-crud.ts — pins the LLMProviderCredentialRepository CRUD
 * (I-4 fix, batch 3, 2026-07-27).
 *
 * WHAT THIS PROVES
 *   The credential repository previously had only `listByWorkspace` + `create`.
 *   An operator who needed to rotate a leaked API key (or revoke a stale one)
 *   had to do DB surgery — there was no update/delete path. Audit finding I-4.
 *   This golden pins the new `update` + `delete` methods AND the workspace-
 *   scoping contract that prevents a user from ws_A touching ws_B's credential
 *   by guessing the id (defense-in-depth on top of the RBAC route gate).
 *
 * THE FIX (root cause):
 *   Added `update(workspaceId, id, patch)` + `delete(workspaceId, id)` to the
 *   LLMProviderCredentialRepository interface + both impls (JSON + Prisma).
 *   Both methods bind on (id AND workspaceId) so a cross-tenant id guess is a
 *   no-op. Update preserves id/workspaceId/createdAt (immutable); delete
 *   returns true iff a row was actually removed.
 *
 * CASE MAP (each hand-computed BEFORE writing assertions):
 *   CASE A — create + listByWorkspace round-trip (regression guard).
 *   CASE B — update rotates encryptedApiKey + bumps updatedAt; id + workspaceId
 *            + createdAt are IMMUTABLE (a patch trying to change them is ignored).
 *   CASE C — update on a NON-EXISTENT id throws (no silent no-op).
 *   CASE D — update is WORKSPACE-SCOPED: ws_A cannot update ws_B's credential
 *            even with the correct id (returns throws/not-found, never mutates).
 *   CASE E — delete removes the row; returns true.
 *   CASE F — delete on a NON-EXISTENT id returns false (no throw — idempotent).
 *   CASE G — delete is WORKSPACE-SCOPED: ws_A cannot delete ws_B's credential
 *            (returns false, ws_B's row survives).
 *   CASE H — delete + recreate with the same provider works (rotation cycle).
 *
 * REAL PIPELINE: imports the real JsonLLMProviderCredentialRepository + the
 * real JSON file via readData/mutateData. Each case uses an isolated workspace
 * id (Ironclad Gate #8) so cases don't leak state into each other.
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { createJsonRepos } from "./_helpers/provider";
import assert from "node:assert";

const WS_A = "ws_cred_crud_A";
const WS_B = "ws_cred_crud_B";

/** Isolate each case on its own workspace so leftover state can't leak. */
function caseWs(caseId: string) { return `ws_cred_crud_${caseId}`; }

async function clearCredentialsForWorkspace(ws: string) {
  const repos = createJsonRepos();
  const existing = await repos.llmProviderCredential.listByWorkspace(ws);
  for (const c of existing) {
    try { await repos.llmProviderCredential.delete(ws, c.id); } catch { /* best-effort */ }
  }
}

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

// --- CASE A: create + listByWorkspace round-trip --------------------------------
test("CASE A — create + listByWorkspace round-trip", async () => {
  const ws = caseWs("A"); await clearCredentialsForWorkspace(ws);
  const repos = createJsonRepos();
  const created = await repos.llmProviderCredential.create(ws, {
    provider: "openai", displayName: "OpenAI prod key", encryptedApiKey: "enc_key_A1",
    status: "connected", config: { baseModel: "gpt-4o" },
  });
  assert.ok(created.id, "create returns a record with an id");
  assert.strictEqual(created.workspaceId, ws);
  assert.strictEqual(created.provider, "openai");
  assert.strictEqual(created.encryptedApiKey, "enc_key_A1");
  const list = await repos.llmProviderCredential.listByWorkspace(ws);
  assert.strictEqual(list.length, 1, `listByWorkspace returns 1 row, got ${list.length}`);
  assert.strictEqual(list[0].id, created.id);
});

// --- CASE B: update rotates key + immutability of id/workspaceId/createdAt ------
test("CASE B — update rotates encryptedApiKey; id/workspaceId/createdAt immutable", async () => {
  const ws = caseWs("B"); await clearCredentialsForWorkspace(ws);
  const repos = createJsonRepos();
  const created = await repos.llmProviderCredential.create(ws, {
    provider: "anthropic", displayName: "Claude key v1", encryptedApiKey: "enc_key_B1",
  });
  // Tiny delay so updatedAt is observably different.
  await new Promise((r) => setTimeout(r, 10));
  const updated = await repos.llmProviderCredential.update(ws, created.id, {
    encryptedApiKey: "enc_key_B2_ROTATED",
    displayName: "Claude key v2 (rotated)",
    // Attempt to mutate immutable fields — the impl MUST ignore these.
    // (Partial<> allows them in the type signature; the runtime enforces
    // immutability by spreading patch AFTER existing, so these are no-ops.)
    id: "forged_id",
    workspaceId: "ws_forged",
    createdAt: "1970-01-01T00:00:00.000Z",
  } as Partial<import("@/lib/types").LLMProviderCredential>);
  assert.strictEqual(updated.encryptedApiKey, "enc_key_B2_ROTATED", "key rotated");
  assert.strictEqual(updated.displayName, "Claude key v2 (rotated)", "displayName updated");
  assert.strictEqual(updated.id, created.id, "id IMMUTABLE on update");
  assert.strictEqual(updated.workspaceId, ws, "workspaceId IMMUTABLE on update");
  assert.strictEqual(updated.createdAt, created.createdAt, "createdAt IMMUTABLE on update");
  assert.ok(updated.updatedAt !== created.updatedAt, `updatedAt bumped, got '${updated.updatedAt}' vs '${created.updatedAt}'`);
});

// --- CASE C: update on non-existent id throws -----------------------------------
test("CASE C — update on a NON-EXISTENT id throws (no silent no-op)", async () => {
  const ws = caseWs("C"); await clearCredentialsForWorkspace(ws);
  const repos = createJsonRepos();
  await assert.rejects(
    () => repos.llmProviderCredential.update(ws, "nonexistent_id", { encryptedApiKey: "x" }),
    /not found/i,
    "update on missing id must throw (not silently return)",
  );
});

// --- CASE D: update is workspace-scoped (cross-tenant block) --------------------
test("CASE D — update is WORKSPACE-SCOPED (ws_A cannot update ws_B's credential)", async () => {
  await clearCredentialsForWorkspace(WS_A); await clearCredentialsForWorkspace(WS_B);
  const repos = createJsonRepos();
  // ws_B owns a credential.
  const bCred = await repos.llmProviderCredential.create(WS_B, {
    provider: "openai", displayName: "B's key", encryptedApiKey: "enc_key_B_real",
  });
  // ws_A tries to update ws_B's credential by guessing the id.
  await assert.rejects(
    () => repos.llmProviderCredential.update(WS_A, bCred.id, { encryptedApiKey: "STOLEN" }),
    /not found/i,
    "ws_A updating ws_B's credential must throw (workspace-scoped)",
  );
  // ws_B's credential is UNCHANGED.
  const bList = await repos.llmProviderCredential.listByWorkspace(WS_B);
  const survivor = bList.find((c) => c.id === bCred.id);
  assert.ok(survivor, "ws_B's credential still exists");
  assert.strictEqual(survivor!.encryptedApiKey, "enc_key_B_real", "ws_B's key was NOT overwritten by ws_A");
});

// --- CASE E: delete removes the row; returns true -------------------------------
test("CASE E — delete removes the row; returns true", async () => {
  const ws = caseWs("E"); await clearCredentialsForWorkspace(ws);
  const repos = createJsonRepos();
  const created = await repos.llmProviderCredential.create(ws, {
    provider: "gemini", displayName: "Gemini key", encryptedApiKey: "enc_key_E",
  });
  const deleted = await repos.llmProviderCredential.delete(ws, created.id);
  assert.strictEqual(deleted, true, "delete returns true when a row was removed");
  const list = await repos.llmProviderCredential.listByWorkspace(ws);
  assert.strictEqual(list.length, 0, "row gone after delete");
});

// --- CASE F: delete on non-existent id returns false (idempotent) ---------------
test("CASE F — delete on a NON-EXISTENT id returns false (idempotent, no throw)", async () => {
  const ws = caseWs("F"); await clearCredentialsForWorkspace(ws);
  const repos = createJsonRepos();
  const deleted = await repos.llmProviderCredential.delete(ws, "nonexistent_id");
  assert.strictEqual(deleted, false, "delete on missing id returns false (not throw)");
});

// --- CASE G: delete is workspace-scoped (cross-tenant block) --------------------
test("CASE G — delete is WORKSPACE-SCOPED (ws_A cannot delete ws_B's credential)", async () => {
  await clearCredentialsForWorkspace(WS_A); await clearCredentialsForWorkspace(WS_B);
  const repos = createJsonRepos();
  const bCred = await repos.llmProviderCredential.create(WS_B, {
    provider: "openai", displayName: "B's key", encryptedApiKey: "enc_key_G_real",
  });
  // ws_A tries to delete ws_B's credential.
  const result = await repos.llmProviderCredential.delete(WS_A, bCred.id);
  assert.strictEqual(result, false, "ws_A deleting ws_B's credential returns false (no row matched)");
  // ws_B's credential SURVIVES.
  const bList = await repos.llmProviderCredential.listByWorkspace(WS_B);
  assert.strictEqual(bList.length, 1, "ws_B's credential survived the cross-tenant delete attempt");
  assert.strictEqual(bList[0].id, bCred.id);
});

// --- CASE H: delete + recreate with same provider (rotation cycle) --------------
test("CASE H — delete + recreate with the same provider works (rotation cycle)", async () => {
  const ws = caseWs("H"); await clearCredentialsForWorkspace(ws);
  const repos = createJsonRepos();
  const v1 = await repos.llmProviderCredential.create(ws, {
    provider: "openai", displayName: "OpenAI v1", encryptedApiKey: "enc_key_H_v1",
  });
  await repos.llmProviderCredential.delete(ws, v1.id);
  const v2 = await repos.llmProviderCredential.create(ws, {
    provider: "openai", displayName: "OpenAI v2 (rotated)", encryptedApiKey: "enc_key_H_v2",
  });
  assert.notStrictEqual(v2.id, v1.id, "recreated credential has a NEW id");
  const list = await repos.llmProviderCredential.listByWorkspace(ws);
  assert.strictEqual(list.length, 1, "exactly 1 credential after rotation");
  assert.strictEqual(list[0].encryptedApiKey, "enc_key_H_v2", "the new key is in place");
});

// --- RUNNER ---------------------------------------------------------------------
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${(e as Error).message}`);
    }
  }
  console.log("");
  console.log(`credential-crud: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
