import type { RepositoryBundle } from "@/repositories/interfaces";
import { NeedsActionError } from "@/lib/user-errors";
import { restoreWorkspaceCollections, unsupportedRestoreCollections } from "@/migration/migrate-executor";
import type { MediaCatalogItem } from "@/lib/types";

type Row = Record<string, unknown>;

/** Validate, clear and restore as one database unit; never report partial success. */
export async function restoreWorkspaceAtomically(
  repos: RepositoryBundle, workspaceId: string,
  rows: Record<string, Row[]>, collections: readonly string[],
) {
  if (!repos.withTransaction || !repos.readAll || !repos.clearWorkspaceCollections) {
    throw new NeedsActionError("Safe restore is unavailable in this runtime. Nothing was changed.", 409);
  }
  const unsupported = unsupportedRestoreCollections(rows);
  if (unsupported.length) {
    throw new NeedsActionError(`This file contains sections that cannot be restored: ${unsupported.join(", ")}. Nothing was changed.`, 400);
  }
  for (const [collection, items] of Object.entries(rows)) {
    const ids = new Set<string>();
    for (const row of items) {
      if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.id !== "string" || !row.id.trim() || ids.has(row.id)) {
        throw new NeedsActionError(`The ${collection} section has an invalid or repeated record. Nothing was changed.`, 400);
      }
      ids.add(row.id);
    }
  }
  return repos.withTransaction(async () => {
    const current = await repos.readAll!();
    const snapshot = current as unknown as Record<string, Row[]>;
    for (const [collection, items] of Object.entries(rows)) {
      const foreign = new Set((snapshot[collection] || []).filter(r => r.workspaceId !== workspaceId).map(r => r.id));
      if (items.some(r => foreign.has(r.id))) {
        throw new NeedsActionError("This file contains record identifiers used by another company. Nothing was changed.", 400);
      }
    }
    const referenceCollections: Record<string, string> = {
      leadId: "leads", campaignId: "campaigns", icpId: "icps", quoteId: "quotes",
      sourceQuoteId: "quotes", supersedesQuoteId: "quotes", orderId: "orders",
      replyId: "replies", ticketId: "tickets", documentId: "knowledgeBaseDocuments",
      productId: "productKnowledges", productKnowledgeId: "productKnowledges",
      varietyId: "productVarieties", variantId: "productVarieties",
      applicationId: "productApplications", buyerSegmentId: "buyerSegments",
    };
    // Restoring bypasses normal create services. Validate its links against
    // what WILL exist after the clear, not just what exists before it.
    const cleared = new Set(collections);
    const available = new Map<string, Set<unknown>>();
    for (const collection of new Set(Object.values(referenceCollections))) {
      const retained = cleared.has(collection) ? [] : (snapshot[collection] || []).filter(r => r.workspaceId === workspaceId);
      available.set(collection, new Set([...retained, ...(rows[collection] || [])].map(r => r.id)));
    }
    const validateLinks = (row: Row) => {
      for (const [field, collection] of Object.entries(referenceCollections)) {
        const id = row[field];
        if (id !== undefined && id !== null && id !== "" && !available.get(collection)?.has(id)) {
          throw new NeedsActionError(`A ${field} link in this file does not belong to the restored company records. Nothing was changed.`, 400);
        }
      }
      if (Array.isArray(row.lineItems)) for (const item of row.lineItems) {
        if (item && typeof item === "object" && !Array.isArray(item)) validateLinks(item as Row);
      }
    };
    for (const items of Object.values(rows)) for (const row of items) validateLinks(row);
    // Workspace JSON exports contain upload metadata, not the original bytes.
    // Reuse only this company's still-available files; refuse missing files
    // rather than replace working records with catalogue links that return 404.
    const media = rows.mediaCatalogItems || [];
    const files = new Map<string, Buffer>();
    for (const row of media) {
      const bytes = await repos.mediaCatalog.getFileBytes(workspaceId, String(row.id));
      if (!bytes) throw new NeedsActionError("This backup does not contain its uploaded files. Re-upload the missing files or use a complete database recovery. Nothing was changed.", 400);
      files.set(String(row.id), bytes);
    }
    const removed = await repos.clearWorkspaceCollections!(workspaceId, collections);
    const result = await restoreWorkspaceCollections(repos, { ...rows, mediaCatalogItems: [] }, workspaceId);
    if (result.errors.length || Object.keys(result.unsupported).length) {
      throw new NeedsActionError("The backup could not be restored completely. Your previous data was kept. Check the file and try again.", 400);
    }
    for (const row of media) {
      await repos.mediaCatalog.create(workspaceId, row as Partial<MediaCatalogItem>, files.get(String(row.id)));
    }
    if (media.length) result.restored.mediaCatalogItems = media.length;
    return { removed, result };
  });
}
