import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import { indexSourcesIntoKnowledgeBase } from "@/services/KnowledgeSourceIndexingService";
import type { KnowledgeExtractionSource } from "@/lib/types";

async function main() {
  const repos = createJsonRepos();
  const workspaceId = `source_identity_${Date.now()}`;
  await ensureWorkspace(repos, workspaceId);
  const source = (id: string, file: string, text: string): KnowledgeExtractionSource => ({ id, workspaceId, bundleId: "bundle", sourceType: "uploaded_file", sourceTitle: file, sourceFileName: file, extractedText: text, metadataJson: {}, status: "ready", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const a = source("source_a", "catalogue.txt", "The catalogue describes copper thread for weaving.");
  const b = source("source_b", "policy.txt", "The sample policy permits one small sample pack.");
  const first = await indexSourcesIntoKnowledgeBase(workspaceId, [a, b], repos);
  assert.equal(first.length, 2);
  const updated = await indexSourcesIntoKnowledgeBase(workspaceId, [{ ...b, extractedText: "The sample policy now permits two small sample packs." }], repos);
  assert.equal(updated[0].documentId, first[1].documentId, "re-uploading policy must replace policy, not the first unrelated file with no URL");
  const catalogue = await repos.knowledgeBaseDocument.getById(workspaceId, first[0].documentId);
  assert.equal(catalogue?.contentText, a.extractedText, "the catalogue must not be overwritten by another file's policy");
  assert.equal((await repos.knowledgeBaseDocument.listByWorkspace(workspaceId)).filter(d => d.documentType === "uploaded_source").length, 2);
  const duplicate = source("source_c", "variants.txt", "Variants initially include blue thread.");
  const latest = { ...duplicate, id: "source_d", extractedText: "Variants now include green thread." };
  const sameBundle = await indexSourcesIntoKnowledgeBase(workspaceId, [duplicate, latest], repos);
  assert.equal(sameBundle[0].documentId, sameBundle[1].documentId, "same file in one bundle must replace rather than duplicate");
  assert.equal((await repos.knowledgeBaseDocument.getById(workspaceId, sameBundle[1].documentId))?.contentText, latest.extractedText);
  const notes = { ...source("source_notes", "unused", "Pasted company notes."), sourceType: "pasted_text" as const, sourceFileName: undefined, sourceTitle: "Pasted company notes" };
  const notesFirst = await indexSourcesIntoKnowledgeBase(workspaceId, [notes], repos);
  const notesAgain = await indexSourcesIntoKnowledgeBase(workspaceId, [notes], repos);
  assert.equal(notesAgain[0].documentId, notesFirst[0].documentId, "re-syncing the same pasted source must not append duplicate evidence");
  console.log("workflow-source-identity: 3 passed, 0 failed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
