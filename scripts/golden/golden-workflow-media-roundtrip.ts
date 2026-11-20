import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspaces } from "./_helpers/fixtures";
import { saveMediaCatalogItem, readMediaCatalogFile } from "@/services/MediaCatalogService";

async function main() {
  const repos = createJsonRepos();
  const workspaceId = `media_roundtrip_${Date.now()}`;
  const other = `${workspaceId}_other`;
  await ensureWorkspaces(repos, [workspaceId, other]);
  const bytes = Buffer.from("Owned catalogue evidence: copper thread.", "utf8");
  const item = await saveMediaCatalogItem({ workspaceId, fileName: "catalogue.txt", fileType: "text/plain", buffer: bytes, title: "Our catalogue", category: "catalog" }, repos);
  const reopened = await readMediaCatalogFile(workspaceId, item.id, createJsonRepos());
  assert.deepEqual(reopened?.bytes, bytes, "new repository must recover the exact stored upload bytes");
  assert.equal(reopened?.item.title, "Our catalogue");
  assert.equal(await readMediaCatalogFile(other, item.id, repos), undefined, "another tenant cannot read media by guessed id");
  console.log("PASS A — uploaded bytes survive a new repository and stay company-scoped");
  await assert.rejects(() => saveMediaCatalogItem({ workspaceId, fileName: "empty.txt", fileType: "text/plain", buffer: Buffer.alloc(0) }, repos), /empty/i);
  console.log("PASS B — empty uploads are rejected");
  console.log("workflow-media-roundtrip: 2 passed, 0 failed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
