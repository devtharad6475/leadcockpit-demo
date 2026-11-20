/**
 * Memory job-queue backend (Stage C.2).
 *
 * Extracted from the original src/jobs/JobQueue.ts. This is the default
 * backend — works with zero external deps, so the JSON demo runtime + all
 * 37 golden tests run without Redis.
 *
 * Known quirk PRESERVED here (not silently "fixed"): processJob on a job
 * with NO registered handler returns the job UNCHANGED (status stays
 * "queued", attempts stays 0). This matches the original behavior. The
 * BullMQ backend has a different but compatible behavior (the job stays
 * "waiting" in the queue). Both are honest — the operator can see no work
 * was done.
 *
 * Also preserved: the no-retry-loop quirk. processJob has the `attempts`/
 * `maxAttempts` fields but a single failed processJob marks the job "failed"
 * once (no automatic retry). The BullMQ backend gets real retry+backoff;
 * the memory backend stays as-is (changing it would silently change demo-
 * mode behavior the golden tests pin).
 *
 * 2026-07-27 Stage C.2.
 */
import type { AppJob, JobInput, JobType } from "../JobTypes";
import type { JobHandler } from "../JobQueue";

const handlers = new Map<JobType, JobHandler>();
const queuedJobs: AppJob[] = [];

function jobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function registerJobHandlerMemory(type: JobType, handler: JobHandler) {
  handlers.set(type, handler);
}

export function getRegisteredHandlerTypesMemory(): JobType[] {
  return Array.from(handlers.keys());
}

export async function enqueueJobMemory(input: JobInput): Promise<AppJob> {
  const job: AppJob = {
    jobId: input.jobId || jobId(),
    workspaceId: input.workspaceId,
    type: input.type,
    status: input.status || "queued",
    payload: input.payload || {},
    attempts: input.attempts || 0,
    maxAttempts: input.maxAttempts || 3,
    createdAt: input.createdAt || new Date().toISOString(),
  };
  queuedJobs.push(job);
  return job;
}

export async function processJobMemory(job: AppJob): Promise<AppJob> {
  const handler = handlers.get(job.type);
  if (!handler) return job; // quirk preserved: no handler → unchanged
  job.status = "running";
  job.startedAt = new Date().toISOString();
  job.attempts += 1;
  try {
    await handler(job);
    job.status = "completed";
    job.completedAt = new Date().toISOString();
  } catch (error) {
    job.status = "failed";
    job.errorMessage = error instanceof Error ? error.message : "Unknown job failure";
    job.completedAt = new Date().toISOString();
  }
  return job;
}

export function listQueuedJobsMemory(): AppJob[] {
  return [...queuedJobs];
}

/** Test seam: clear handlers + queue between golden-test cases. */
export function resetMemoryBackendForTesting() {
  handlers.clear();
  queuedJobs.length = 0;
}
