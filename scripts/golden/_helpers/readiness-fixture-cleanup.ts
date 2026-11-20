import { prisma } from '@/lib/prisma';
import type { RepositoryBundle } from '@/repositories/interfaces';
import { assertDisposableReadinessDatabase } from './disposable-readiness-database';

/** Track only workspaces created by this proof; never select by broad prefixes. */
export function readinessFixtureCleanup() {
  const ids = new Set<string>();
  const track = (id: string) => { ids.add(id); };
  const attach = (repos: RepositoryBundle) => {
    const create = repos.workspace.create.bind(repos.workspace);
    repos.workspace.create = async (...args) => {
      const row = await create(...args); track(row.id); return row;
    };
    const signup = repos.auth.createWorkspaceWithOwner.bind(repos.auth);
    repos.auth.createWorkspaceWithOwner = async input => {
      const result = await signup(input); track(input.workspace.id); return result;
    };
  };
  const cleanup = async () => {
    assertDisposableReadinessDatabase(process.env.DATABASE_URL, process.env.CI);
    if (ids.size) await prisma.workspace.deleteMany({ where: { id: { in: [...ids] } } });
  };
  return { track, attach, cleanup };
}
