/**
 * JobQueue — Stage C.2 dispatcher.
 *
 * Routes enqueueJob / processJob / listQueuedJobs / registerJobHandler to
 * the active backend:
 *   - REDIS_URL set → BullMQ backend (durable, retry+backoff, multi-worker)
 *   - REDIS_URL unset → memory backend (the original in-process array)
 *
 * PUBLIC API (unchanged from pre-Stage-C.2 — ripple rule):
 *   - registerJobHandler(type, handler) — sync, registers on BOTH backends.
 *     (BullMQ's worker reads handlers via the resolver set at boot.)
 *   - enqueueJob(input, options?) — async. options.processImmediately runs
 *     the job inline (memory backend only; BullMQ ignores it).
 *   - processJob(job) — async, memory backend only. (BullMQ jobs are
 *     processed automatically by the worker process.)
 *   - listQueuedJobs() — sync, memory backend only. (BullMQ jobs are
 *     listed via listJobsBullMQ; the dispatcher exposes this as
 *     listQueuedJobsAsync for callers that want BullMQ state.)
 *   - getActiveQueueBackendName() — sync, used by the prod-readiness check
 *     and golden tests.
 *
 * HANDLER MAP: a single in-memory Map<JobType, JobHandler>. Both backends
 * read from it (memory directly, BullMQ via setHandlerResolverForBullMQ at
 * boot in worker-entrypoint.ts). This is the single-source-of-truth rule —
 * register once, dispatch either way.
 *
 * 2026-07-27 Stage C.2.
 */
import type { AppJob, JobInput, JobType } from "./JobTypes";

export type JobHandler = (job: AppJob) => Promise<unknown> | unknown;

import {
  registerJobHandlerMemory,
  getRegisteredHandlerTypesMemory,
  enqueueJobMemory,
  processJobMemory,
  listQueuedJobsMemory,
  resetMemoryBackendForTesting,
} from "./queue/MemoryQueueBackend";
import {
  enqueueJobBullMQ,
  processQueueBullMQ,
  listJobsBullMQ,
  setBullMQConnectionForTesting,
  resetBullMQBackendForTesting,
  setHandlerResolverForBullMQ,
  closeBullMQForTesting,
} from "./queue/BullMQQueueBackend";

// Re-export for callers (worker-entrypoint, JobHandlers) + tests.
export {
  enqueueJobBullMQ,
  processQueueBullMQ,
  listJobsBullMQ,
  setHandlerResolverForBullMQ,
};

// =============================================================================
// Handler map — single source of truth, used by BOTH backends.
// =============================================================================
const handlerMap = new Map<JobType, JobHandler>();

/** Register a handler. Both backends will dispatch to it. */
export function registerJobHandler(type: JobType, handler: JobHandler) {
  handlerMap.set(type, handler);
  // Also register on the memory backend so its processJob can find it.
  registerJobHandlerMemory(type, handler);
}

/** Internal resolver used by the BullMQ worker (set at boot). */
function resolveHandler(type: JobType): JobHandler | undefined {
  return handlerMap.get(type);
}

// Wire up the BullMQ resolver immediately — BullMQ will read it when its
// worker starts. This is safe even when BullMQ isn't active (the resolver
// just sits unused).
setHandlerResolverForBullMQ(resolveHandler);

// =============================================================================
// Public dispatcher API (unchanged signatures — ripple rule)
// =============================================================================

/** Which backend is active, by name. */
export function getActiveQueueBackendName(): "memory" | "bullmq" {
  if (process.env.REDIS_URL) return "bullmq";
  return "memory";
}

/**
 * Enqueue a job. options.processImmediately runs the job inline (memory
 * backend only — BullMQ ignores it since jobs there are picked up by the
 * worker process).
 */
export async function enqueueJob(input: JobInput, options: { processImmediately?: boolean } = {}): Promise<AppJob> {
  if (getActiveQueueBackendName() === "bullmq") {
    return enqueueJobBullMQ(input);
  }
  const job = await enqueueJobMemory(input);
  if (options.processImmediately) await processJobMemory(job);
  return job;
}

/**
 * Process a single job (memory backend only). On the BullMQ backend this is
 * a no-op — BullMQ jobs are processed automatically by the worker. We
 * return the job unchanged to preserve the public-API contract.
 */
export async function processJob(job: AppJob): Promise<AppJob> {
  if (getActiveQueueBackendName() === "bullmq") {
    // BullMQ jobs are processed by the worker process, not by inline calls.
    return job;
  }
  return processJobMemory(job);
}

/**
 * List queued jobs (memory backend only, sync). For BullMQ state, use
 * listQueuedJobsAsync (which awaits listJobsBullMQ).
 *
 * Honest limitation: when BullMQ is active, this returns the memory backend's
 * state, which is empty (every enqueue goes to BullMQ). Documented in the
 * dispatcher header above. Callers needing live BullMQ state should use
 * listQueuedJobsAsync.
 */
export function listQueuedJobs(): AppJob[] {
  return listQueuedJobsMemory();
}

/** Async list — works on both backends (memory or BullMQ). */
export async function listQueuedJobsAsync(): Promise<AppJob[]> {
  if (getActiveQueueBackendName() === "bullmq") {
    return listJobsBullMQ();
  }
  return listQueuedJobsMemory();
}

/** Test seam: reset BOTH backends + the handler map. */
export function resetJobQueueForTesting() {
  handlerMap.clear();
  resetMemoryBackendForTesting();
  resetBullMQBackendForTesting();
}

// Test seams re-exported for the golden test.
export { setBullMQConnectionForTesting, closeBullMQForTesting };

// Re-export types + helpers downstream code expects.
export type { AppJob, JobInput, JobType } from "./JobTypes";
export { getRegisteredHandlerTypesMemory };
