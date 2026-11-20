import { oneAtATime } from '@/lib/one-at-a-time';
import type { RepositoryBundle } from '@/repositories/interfaces';

/** Hold only while re-reading and saving; never while waiting for a model. */
export function withLeadMemoryWrite<T>(workspaceId: string, leadId: string, repos: RepositoryBundle, work: () => Promise<T>): Promise<T> {
  return oneAtATime(`lead-memory-write:${workspaceId}:${leadId}`, () => {
    if (repos.withLeadMemoryTransaction) return repos.withLeadMemoryTransaction(workspaceId, leadId, work);
    return repos.withTransaction ? repos.withTransaction(work) : work();
  });
}
