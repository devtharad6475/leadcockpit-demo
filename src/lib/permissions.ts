import type { WorkspaceRole } from "./types";

const roleRank: Record<WorkspaceRole, number> = {
  viewer: 0,
  sales_member: 1,
  admin: 2,
  owner: 3,
};

function atLeast(role: WorkspaceRole, minimum: WorkspaceRole) {
  return roleRank[role] >= roleRank[minimum];
}

export function canManageWorkspace(role: WorkspaceRole) {
  return atLeast(role, "admin");
}

export function canEditKnowledge(role: WorkspaceRole) {
  return atLeast(role, "admin");
}

export function canApproveCampaign(role: WorkspaceRole) {
  return atLeast(role, "admin");
}

export function canApproveLead(role: WorkspaceRole) {
  return atLeast(role, "sales_member");
}

export function canConfigureAI(role: WorkspaceRole) {
  return atLeast(role, "admin");
}

export function canConfigureIntegrations(role: WorkspaceRole) {
  return atLeast(role, "admin");
}

export function canExportData(role: WorkspaceRole) {
  return atLeast(role, "owner");
}

export function canViewAnalytics(role: WorkspaceRole) {
  return atLeast(role, "viewer");
}

export function canManageMembers(role: WorkspaceRole) {
  return role === "owner";
}
