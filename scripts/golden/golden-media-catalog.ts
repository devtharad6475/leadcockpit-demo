/**
 * golden-media-catalog.ts — MediaCatalogService.deleteMediaCatalogItem pin (NEW, 2026-07-27).
 *
 * WHY THIS TEST EXISTS:
 *   MediaCatalogService had NO golden test. The W-1 fix (2026-07-27) renamed
 *   archiveMediaCatalogItem → deleteMediaCatalogItem (honest name; it never
 *   archived at the service level) and added an audit-event trail BEFORE the
 *   delete so the operator has a who/what/when record for an irreversible
 *   action (the file may be referenced by an active quote's PDF-send path).
 *   We pin: (1) the audit event is recorded with the right action + actor +
 *   entity, (2) the file is removed from disk, (3) the item is no longer
 *   retrievable via getById, (4) the deprecated alias still works, (5) the
 *   audit write is best-effort (a delete still succeeds even if the item is
 *   already gone — the audit fires with whatever it could load).
 *
 * HAND-COMPUTED CONTRACT (the anti-cheat — these are the rules, not the code):
 *
 *   CASE A — deleteMediaCatalogItem records a 'media.deleted' audit event
 *     BEFORE the delete, carrying the session-resolved actor + the item's
 *     fileName/fileType/category. Hand-computed: after the call, exactly one
 *     new audit log row exists for this workspace with eventType='media.deleted',
 *     actorUserId === the passed actor, entityId === the item id. If the audit
 *     is skipped or stamped with the wrong actor, the operator loses the
 *     non-repudiation trail on an irreversible delete.
 *
 *   CASE B — the FILE is removed, not just the row. Rewritten 2026-09-10: this
 *     case used to assert a path under public/uploads existed and then stopped
 *     existing. That encoded the defect it was meant to guard — a file under
 *     public/uploads does not survive a deploy on the substrate this ships on,
 *     so the row outlived what it pointed at and the catalogue served 404s.
 *     Bytes now live in the store, and the contract is the one that actually
 *     matters: readable before the delete, unreadable after it. WHERE the bytes
 *     live is the store's business; that they are really gone is the product's.
 *
 *   CASE C — after delete, getById returns undefined (the item is no longer
 *     retrievable). Hand-computed: getById post-delete is undefined.
 *
 *   CASE D — the deprecated alias archiveMediaCatalogItem still works (calls
 *     through to deleteMediaCatalogItem with actor 'system'). This is the
 *     backward-compat seam for callers that haven't migrated. Hand-computed:
 *     the alias deletes the item + records the same audit event with
 *     actorUserId === 'system'.
 *
 *   CASE E — deleteMediaCatalogItem still completes (and still records an
 *     audit event) even when the underlying item is missing. The audit write
 *     is best-effort: it loads `existing` (which may be undefined) and stamps
 *     the fileName/fileType/category as undefined. The delete itself then
 *     throws at the repo layer (notFound), which is the honest behavior — but
 *     the audit event was already recorded. We pin that the audit row exists
 *     even though the call rejects. (This is the build-right No-Silent-
 *     Failures rule: the audit attempt is visible even on a failed delete.)
 *
 * REAL PIPELINE: imports the real saveMediaCatalogItem + deleteMediaCatalogItem
 * + the real JSON repo. Each case uses a unique timestamped workspace. Real
 * files are written under public/uploads and removed by the service.
 *
 * Run: `npm run golden:media-catalog`
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import {
  saveMediaCatalogItem,
  deleteMediaCatalogItem,
  archiveMediaCatalogItem,
  readMediaCatalogFile,
} from "@/services/MediaCatalogService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: () => Promise<void>) { cases.push({ name, fn }); }

function caseWorkspace(slug: string): string {
  return `ws_golden_media_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

// --- CASE A: audit event recorded with right action + actor + entity ----------
test("CASE A — deleteMediaCatalogItem records a 'media.deleted' audit event with the passed actor", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("A");
  // Seed a real item (we don't need the file to persist for this case, but the
  // service writes one — that's fine).
  const saved = await saveMediaCatalogItem({
    workspaceId: WS,
    fileName: "catalog-A.pdf",
    fileType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 fake catalog A"),
    category: "catalog",
    title: "Catalog A",
  }, repos);

  const auditBefore = (await repos.auditLog.listByWorkspace(WS)).filter((l) => l.eventType === "media.deleted").length;
  await deleteMediaCatalogItem(WS, saved.id, "user_owner_123", repos);
  const auditAfter = (await repos.auditLog.listByWorkspace(WS)).filter((l) => l.eventType === "media.deleted");

  // Hand-computed: exactly one new media.deleted row, scoped to this workspace.
  assert.strictEqual(auditAfter.length - auditBefore, 1, "exactly one new media.deleted audit row");
  const entry = auditAfter[auditAfter.length - 1];
  assert.strictEqual(entry.eventType, "media.deleted", "audit eventType === 'media.deleted'");
  assert.strictEqual(entry.actorUserId, "user_owner_123", "audit actorUserId === the passed actor (not 'system')");
  assert.strictEqual(entry.entityId, saved.id, "audit entityId === the deleted item id");
  assert.strictEqual(entry.entityType, "media_catalog_item", "audit entityType === 'media_catalog_item'");
  // The audit payload captures what was deleted (fileName at minimum).
  const newValues = (entry.payload?.newValuesJson || {}) as Record<string, unknown>;
  assert.strictEqual(newValues.fileName, "catalog-A.pdf", "audit payload captured the deleted fileName");
});

// --- CASE B: the file itself is removed, not just the row ---------------------
test("CASE B — deleteMediaCatalogItem REMOVES the stored file, not just the row", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("B");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header bytes
  const saved = await saveMediaCatalogItem({
    workspaceId: WS,
    fileName: "image-B.png",
    fileType: "image/png",
    buffer: pngBytes,
    category: "product_image",
    title: "Image B",
  }, repos);

  const before = await readMediaCatalogFile(WS, saved.id, repos);
  assert.ok(before, "the file could not be read back before the delete — the upload did not persist");
  assert.ok(before!.bytes.equals(pngBytes), "the stored bytes are not the bytes that were uploaded");

  await deleteMediaCatalogItem(WS, saved.id, "user_owner", repos);

  // Hand-computed: the bytes are GONE after the delete. A "deleted" photo that
  // is still served to anyone holding its id is not deleted.
  const after = await readMediaCatalogFile(WS, saved.id, repos);
  assert.strictEqual(after, undefined, "the file is still readable after the delete");
});

// --- CASE C: getById returns undefined after delete ---------------------------
test("CASE C — after delete, getById returns undefined (item no longer retrievable)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("C");
  const saved = await saveMediaCatalogItem({
    workspaceId: WS,
    fileName: "doc-C.txt",
    fileType: "text/plain",
    buffer: Buffer.from("hello C"),
    category: "other",
  }, repos);

  const before = await repos.mediaCatalog.getById(WS, saved.id);
  assert.ok(before, "item retrievable before delete");

  await deleteMediaCatalogItem(WS, saved.id, "user_owner", repos);

  const after = await repos.mediaCatalog.getById(WS, saved.id);
  // Hand-computed: getById returns undefined (the repo soft-archives but
  // getById filters archived rows, so the item is effectively gone).
  assert.strictEqual(after, undefined, "getById returns undefined after delete");
});

// --- CASE D: deprecated alias archiveMediaCatalogItem still works -------------
test("CASE D — deprecated alias archiveMediaCatalogItem delegates to delete with actor 'system'", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("D");
  const saved = await saveMediaCatalogItem({
    workspaceId: WS,
    fileName: "doc-D.txt",
    fileType: "text/plain",
    buffer: Buffer.from("hello D"),
    category: "other",
  }, repos);

  await archiveMediaCatalogItem(WS, saved.id, repos);

  // Hand-computed: item is gone (alias delegated to delete).
  const after = await repos.mediaCatalog.getById(WS, saved.id);
  assert.strictEqual(after, undefined, "alias-deleted item is no longer retrievable");
  // And the audit event was recorded with actor 'system' (the alias default).
  const audit = (await repos.auditLog.listByWorkspace(WS)).filter((l) => l.eventType === "media.deleted");
  assert.ok(audit.length >= 1, "alias recorded a media.deleted audit event");
  const last = audit[audit.length - 1];
  assert.strictEqual(last.actorUserId, "system", "alias stamps actor 'system' (default)");
});

// --- CASE E: audit is best-effort even when the item is missing ---------------
test("CASE E — deleteMediaCatalogItem records the audit event even when the item is missing (best-effort)", async () => {
  const repos = createJsonRepos();
  const WS = caseWorkspace("E");
  const missingId = "media_does_not_exist";

  // The delete will reject at the repo layer (notFound), but the audit write
  // happens BEFORE the delete, so the audit row should still be present.
  await assert.rejects(
    () => deleteMediaCatalogItem(WS, missingId, "user_owner", repos),
    /not found/i,
    "delete of a missing item rejects at the repo layer",
  );

  // Hand-computed: the best-effort audit event WAS recorded (No-Silent-Failures).
  const audit = (await repos.auditLog.listByWorkspace(WS)).filter((l) => l.eventType === "media.deleted" && l.entityId === missingId);
  assert.ok(audit.length >= 1, "audit event recorded even though the item was missing (best-effort)");
  assert.strictEqual(audit[audit.length - 1].actorUserId, "user_owner", "audit actor preserved on the failed-delete path");
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
  console.log(`media-catalog: ${passed} passed, ${failed} failed — ${failed === 0 ? "ALL GREEN ✅" : "FAIL ❌"}`);
  if (failed > 0) process.exit(1);
})();
