import { createRepositories } from "@/repositories";
import type { CommunicationSettings, PolicySettings, ProductSettings, SalesSettings } from "@/lib/types";

export async function getSalesSettings(workspaceId: string, repos = createRepositories()) {
  return repos.salesSettings.getByWorkspace(workspaceId);
}

export async function updateSalesSettings(workspaceId: string, input: Partial<SalesSettings>, repos = createRepositories()) {
  return repos.salesSettings.upsertForWorkspace(workspaceId, input);
}

export async function getProductSettings(workspaceId: string, repos = createRepositories()) {
  return repos.productSettings.getByWorkspace(workspaceId);
}

export async function updateProductSettings(workspaceId: string, input: Partial<ProductSettings>, repos = createRepositories()) {
  return repos.productSettings.upsertForWorkspace(workspaceId, input);
}

export async function getPolicySettings(workspaceId: string, repos = createRepositories()) {
  return repos.policySettings.getByWorkspace(workspaceId);
}

export async function updatePolicySettings(workspaceId: string, input: Partial<PolicySettings>, repos = createRepositories()) {
  return repos.policySettings.upsertForWorkspace(workspaceId, input);
}

export async function getCommunicationSettings(workspaceId: string, repos = createRepositories()) {
  return repos.communicationSettings.getByWorkspace(workspaceId);
}

export async function updateCommunicationSettings(workspaceId: string, input: Partial<CommunicationSettings>, repos = createRepositories()) {
  return repos.communicationSettings.upsertForWorkspace(workspaceId, input);
}
