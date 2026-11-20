import { NeedsActionError } from "@/lib/user-errors";
import { rm } from "node:fs/promises";
import path from "node:path";
import { uid } from "@/lib/db";
import type { MediaCatalogItem } from "@/lib/types";
import { createRepositories } from "@/repositories";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { AuditLogService } from "@/services/AuditLogService";

export type MediaUploadInput = {
  workspaceId: string;
  fileName: string;
  fileType: string;
  buffer: Buffer;
  category?: MediaCatalogItem["category"];
  title?: string;
  caption?: string;
  leadId?: string;
  folder?: "media" | "policies";
};

const publicUploadRoot = path.join(process.cwd(), "public", "uploads");

export async function listMediaCatalogItems(workspaceId: string, repos: RepositoryBundle = createRepositories(), filters: { category?: string; leadId?: string } = {}) {
  return repos.mediaCatalog.listByWorkspace(workspaceId, filters);
}

export async function getMediaCatalogItem(workspaceId: string, id: string, repos: RepositoryBundle = createRepositories()) {
  return repos.mediaCatalog.getById(workspaceId, id);
}

/**
 * 2026-09-10 (session 55) — uploads no longer go to public/uploads.
 *
 * They used to: the file was written to `<cwd>/public/uploads/...` and the row
 * kept `/uploads/<folder>/<name>` as its URL. That works on a laptop and is
 * broken everywhere this product actually runs. The deployed container has no
 * persistent disk, so the file died on every deploy and every idle spin-down
 * while the row lived on — the catalogue screen kept showing the item, and the
 * image 404'd. Worse, a WhatsApp media send hands Meta a LINK and Meta fetches
 * it from this origin, so the photo the AI attached simply never arrived, with
 * no error the operator could see.
 *
 * Now the bytes go into the repository (a TEXT column on Postgres, a blob file
 * beside app-data.json on JSON) and the URL points at /api/media/:id/file,
 * which reads them back. The id is minted here rather than by the store so the
 * URL can be built before the row exists.
 *
 * Rows created before this change keep their /uploads/... URL and have no
 * bytes. They are not migrated — their files are already gone — so they render
 * as a broken image until re-uploaded, which is the truth about them.
 */
export async function saveMediaCatalogItem(input: MediaUploadInput, repos: RepositoryBundle = createRepositories()) {
  if (!input.buffer.length) throw new NeedsActionError("Uploaded file is empty.", 400);
  const leadId = input.leadId?.trim() || undefined;
  if (leadId && !await repos.lead.getLeadById(input.workspaceId, leadId)) {
    throw new NeedsActionError("The selected customer is not available in this company.", 404);
  }
  const safeName = sanitizeFileName(input.fileName);
  const id = uid("media");
  return repos.mediaCatalog.create(input.workspaceId, {
    id,
    title: input.title?.trim() || titleFromFileName(safeName),
    category: input.category || inferCategory(input.fileType, safeName),
    fileName: safeName,
    fileType: input.fileType || "application/octet-stream",
    fileSize: input.buffer.length,
    url: mediaFileUrl(id),
    // Nothing on a filesystem backs this row any more. Keep the column honest
    // rather than writing a path that no process will ever open.
    storagePath: "",
    caption: input.caption?.trim() || undefined,
    leadId,
    status: "active",
  }, input.buffer);
}

/** The one place that knows how a stored file is addressed over HTTP. */
export function mediaFileUrl(id: string) {
  return `/api/media/${id}/file`;
}

export async function readMediaCatalogFile(workspaceId: string, id: string, repos: RepositoryBundle = createRepositories()) {
  const item = await repos.mediaCatalog.getById(workspaceId, id);
  if (!item) return undefined;
  const bytes = await repos.mediaCatalog.getFileBytes(workspaceId, id);
  if (!bytes) return undefined;
  return { item, bytes };
}

/**
 * S6 W-1: hard-deletes a media catalog item (removes the DB row + deletes the
 * file from disk). Renamed from `archiveMediaCatalogItem` because the function
 * NEVER archived — it deleted. The misleading name implied soft-delete; the
 * real behavior is irreversible. Now it also records an audit event BEFORE the
 * delete so the operator has a who/what/when trail (the file may be referenced
 * by an active quote's PDF-send path, so deleting it is consequential). The
 * audit write is best-effort (a failure there must not block the delete) but
 * is logged so it's never silent.
 *
 * `archiveMediaCatalogItem` is kept as a deprecated alias for callers that
 * haven't migrated yet; new code should call deleteMediaCatalogItem.
 */
export async function deleteMediaCatalogItem(workspaceId: string, id: string, actorUserId: string, repos: RepositoryBundle = createRepositories()) {
  // Record the audit event BEFORE the delete (so even a mid-delete crash leaves
  // the trail). Best-effort: don't block the delete if the audit write fails.
  try {
    const existing = await repos.mediaCatalog.getById(workspaceId, id);
    await new AuditLogService(repos).logAuditEvent({
      workspaceId,
      userId: actorUserId,
      action: "media.deleted",
      entityType: "media_catalog_item",
      entityId: id,
      newValuesJson: { fileName: existing?.fileName, fileType: existing?.fileType, category: existing?.category },
      metadataJson: { note: "Media catalog item hard-deleted (file removed from disk)." },
    });
  } catch (e) {
    // Best-effort: the audit-log must not block the delete, but the failure
    // must be visible (build-right No-Silent-Failures rule).
    console.error("[media-delete] audit write failed (delete proceeds):", e);
  }
  const item = await repos.mediaCatalog.delete(workspaceId, id);
  if (item.storagePath && isInsidePublicUploads(item.storagePath)) {
    await rm(item.storagePath, { force: true }).catch(() => undefined);
  }
  return item;
}

/** @deprecated use deleteMediaCatalogItem (honest name + audit trail). */
export async function archiveMediaCatalogItem(workspaceId: string, id: string, repos: RepositoryBundle = createRepositories()) {
  return deleteMediaCatalogItem(workspaceId, id, "system", repos);
}

function inferCategory(fileType: string, fileName: string): MediaCatalogItem["category"] {
  const lower = `${fileType} ${fileName}`.toLowerCase();
  if (lower.includes("pdf") && /(policy|terms|agreement|quotation)/.test(lower)) return "policy_document";
  if (/(certificate|iso|compliance|license)/.test(lower)) return "certificate";
  if (lower.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(fileName)) return "product_image";
  if (/(catalog|catalogue|brochure)/.test(lower)) return "catalog";
  return "other";
}

function sanitizeFileName(fileName: string) {
  const base = path.basename(fileName || "media.bin").replace(/[^\w.\- ]+/g, "").trim();
  return base || "media.bin";
}

function titleFromFileName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Media item";
}

function isInsidePublicUploads(storagePath: string) {
  const root = path.resolve(publicUploadRoot);
  const target = path.resolve(storagePath);
  return target === root || target.startsWith(`${root}${path.sep}`);
}
