import { createRepositories } from "@/repositories";
import type { PendingSettingsDraft } from "@/lib/types";

export async function listPendingSettingsDrafts(workspaceId: string, repos = createRepositories()) {
  return repos.pendingSettingsDraft.listPending(workspaceId);
}

export async function savePendingSettingsDraft(workspaceId: string, input: Partial<PendingSettingsDraft>, repos = createRepositories()) {
  return repos.pendingSettingsDraft.upsertPending(workspaceId, {
    ...input,
    status: "pending_review",
  });
}

export async function markPendingSettingsDraftSaved(workspaceId: string, draftId: string, repos = createRepositories()) {
  return repos.pendingSettingsDraft.updateStatus(workspaceId, draftId, "saved");
}

export async function discardPendingSettingsDraft(workspaceId: string, draftId: string, repos = createRepositories()) {
  return repos.pendingSettingsDraft.updateStatus(workspaceId, draftId, "discarded");
}
