import { ADMIN_REQUIRED_PREFIXES, OWNER_ONLY_PREFIXES, ROLE_RANK, requiredRoleForPath, isTabHiddenForTour, type MinRole } from './rbac-map';

/** UI affordances follow existing permissions; they never grant access. */
const TAB_ROLE: Record<string, MinRole> = {
  needsYou: 'owner', commandCenter: 'owner', ai: 'owner', agentInstructions: 'owner',
  integrations: 'owner', messages: 'owner', reviewQueue: 'owner', exportBackup: 'owner',
  onboarding: 'admin', profile: 'admin', knowledge: 'admin', catalogue: 'admin',
  icp: 'admin', campaign: 'admin', discovery: 'admin', review: 'admin', unknown: 'admin',
  workspace: 'admin', activity: 'admin', compliance: 'admin', whatsapp: 'admin',
  settings: 'admin', help: 'admin',
  crm: 'viewer', tickets: 'viewer', commercial: 'viewer', replies: 'viewer',
  dashboard: 'viewer', analytics: 'viewer',
};

export function canViewWorkspaceTab(role: MinRole, tab: string, isTour = false): boolean {
  if (isTour) return !isTabHiddenForTour(tab);
  return ROLE_RANK[role] >= ROLE_RANK[TAB_ROLE[tab] ?? 'owner'];
}

export function workspaceLandingTab(role: MinRole, isTour = false): 'needsYou' | 'tickets' | 'dashboard' {
  return role === 'owner' ? 'needsYou' : isTour ? 'dashboard' : 'tickets';
}

export function canReadWorkspacePath(role: MinRole, url: string): boolean {
  const path = url.split('?')[0].replace(/^\/api\//, '').split('/');
  const sensitive = OWNER_ONLY_PREFIXES.has(path[0]) || ADMIN_REQUIRED_PREFIXES.has(path[0])
    || (path[0] === 'health' && path[1] === 'deep') || (path[0] === 'data' && path[1] === 'export');
  return !sensitive || ROLE_RANK[role] >= ROLE_RANK[requiredRoleForPath(path, 'GET')];
}
