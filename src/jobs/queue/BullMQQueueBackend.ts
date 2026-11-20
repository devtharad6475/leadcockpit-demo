/**
 * BullMQ job-queue backend (Stage C.2).
 *
 * A durable, Redis-backed queue. BullMQ provides real retry + exponential
 * backoff, persistent state across worker restarts, and shared dispatch
 * across multiple worker processes (the in-memory backend can't do any of
 * these). Gated behind REDIS_URL — if unset, the dispatcher in JobQueue.ts
 * selects the memory backend.
 *
 * DESIGN:
 *   - Lazy ioredis + bullmq imports: keeps the module loadable in CI images
 *     that don't have Redis. The dispatcher never selects this backend
 *     without REDIS_URL, so the imports only fire when actually needed.
 *   - One IORedis connection per process, shared by Queue + Worker. BullMQ
 *     reuses `connection` for both, minimizing TCP sockets.
 *   - The Worker dispatches to the SAME handler map the memory backend uses
 *     (registered via registerJobHandler in JobQueue.ts). So adding a new
 *     job handler automatically wires both backends — no parallel pipe.
 *   - Job payload: we store the AppJob shape (workspaceId, type, payload,
 *     maxAttempts) in the BullMQ job's `data` field, and reconstruct the
 *     AppJob on read. Same shape in + out (the Golden Thread).
 *   - Retry/backoff: BullMQ's `attempts` on the job equals AppJob.maxAttempts
 *     (default 3). Failed jobs are retried with exponential backoff
 *     (1000ms * 2^attempt). The memory backend has no retry; this is the
 *     real upgrade.
 *
 * Test seams: setBullMQConnectionForTesting + resetBullMQBackendForTesting
 * let the golden test inject ioredis-mock and clear state between cases.
 *
 * 2026-07-27 Stage C.2.
 */
import type { AppJob, JobInput, JobType } from "../JobTypes";
import type { JobHandler } from "../JobQueue";

type IORedisLike = unknown; // opaque — we only pass it to BullMQ

// The BullMQ shape we depend on. Keeping it structural lets the golden test
// inject a stub implementation that doesn't need a real Redis or the
// MessagePack Lua scripts BullMQ uses internally.
type BullMQQueue = {
  add: (name: string, data: unknown, opts?: unknown) => Promise<{ id: string }>;
  getJobs: (statuses: string[], start?: number, end?: number) => Promise<BullMQJob[]>;
  close: () => Promise<void>;
};
type BullMQWorker = {
  close: () => Promise<void>;
};
type BullMQJob = {
  id?: string;
  data: { workspaceId: string; type: JobType; payload: Record<string, unknown>; maxAttempts: number; createdAt: string };
  processedOn?: number;
  finishedOn?: number;
  attemptsMade?: number;
  failedReason?: string;
};
type BullMQModule = {
  Queue: new (name: string, opts: { connection: IORedisLike }) => BullMQQueue;
  Worker: new (
    name: string,
    processor: (job: BullMQJob) => Promise<void>,
    opts: { connection: IORedisLike },
  ) => BullMQWorker;
};

let injectedConnection: IORedisLike | null = null;
let injectedModule: BullMQModule | null = null;
let realConnection: IORedisLike | null = null;
let realConnectionInitAttempted = false;
let queuePromise: Promise<BullMQQueue> | null = null;
let workerInstance: BullMQWorker | null = null;

/**
 * Test seam: inject an ioredis-mock connection. NOT enough on its own —
 * BullMQ's Lua scripts need cmsgpack which ioredis-mock doesn't ship. For
 * full-coverage BullMQ testing, also use setBullMQModuleForTesting to inject
 * a stub BullMQ module that bypasses the Lua layer entirely.
 */
export function setBullMQConnectionForTesting(conn: IORedisLike) {
  injectedConnection = conn;
  realConnection = null;
  realConnectionInitAttempted = false;
  queuePromise = null;
  workerInstance = null;
}

/**
 * Test seam: inject a stub BullMQ module. Used by the golden test to assert
 * the contract (enqueue shape, worker dispatch, listJobs normalization)
 * WITHOUT needing real Redis or BullMQ's Lua scripts.
 */
export function setBullMQModuleForTesting(mod: BullMQModule) {
  injectedModule = mod;
}

/** Test seam: clear all module-level state between cases. */
export function resetBullMQBackendForTesting() {
  injectedConnection = null;
  injectedModule = null;
  realConnection = null;
  realConnectionInitAttempted = false;
  queuePromise = null;
  workerInstance = null;
}

async function getConnection(): Promise<IORedisLike | null> {
  if (injectedConnection) return injectedConnection;
  if (realConnection) return realConnection;
  if (realConnectionInitAttempted) return realConnection;
  realConnectionInitAttempted = true;

  const url = process.env.REDIS_URL;
  if (!url) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: IORedis } = require("ioredis");
    realConnection = new IORedis(url, { maxRetriesPerRequest: null });
    return realConnection;
  } catch (err) {
    console.error(`[job-queue-bullmq] failed to initialize ioredis connection: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Internal: load the BullMQ module — real (lazy require) or injected stub. */
async function getBullMQModule(): Promise<BullMQModule | null> {
  if (injectedModule) return injectedModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("bullmq");
    return mod as BullMQModule;
  } catch (err) {
    console.error(`[job-queue-bullmq] failed to load bullmq: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function getQueue(): Promise<BullMQQueue | null> {
  if (queuePromise) return queuePromise;
  const conn = await getConnection();
  if (!conn) return null;
  const mod = await getBullMQModule();
  if (!mod) return null;
  const queue = new mod.Queue("leadcockpit-jobs", { connection: conn });
  queuePromise = Promise.resolve(queue);
  return queue;
}

/**
 * Handler dispatcher — the BullMQ worker calls this for every job it picks
 * up. It looks up the handler registered via registerJobHandler (same map
 * the memory backend uses). If no handler, the job is moved to "failed"
 * with a clear reason (NOT silently swallowed).
 *
 * Kept module-level so it can be set by the dispatcher at boot.
 */
let externalHandlerResolver: ((type: JobType) => JobHandler | undefined) | null = null;

export function setHandlerResolverForBullMQ(resolver: (type: JobType) => JobHandler | undefined) {
  externalHandlerResolver = resolver;
}

/**
 * Enqueue a job to BullMQ. Returns an AppJob with the SAME shape the memory
 * backend returns (Golden Thread) — only the jobId is BullMQ's UUID.
 */
export async function enqueueJobBullMQ(input: JobInput): Promise<AppJob> {
  const queue = await getQueue();
  if (!queue) {
    throw new Error("BullMQ enqueue called without a Redis connection (REDIS_URL unset or init failed)");
  }
  const createdAt = input.createdAt || new Date().toISOString();
  const data = {
    workspaceId: input.workspaceId,
    type: input.type,
    payload: input.payload || {},
    maxAttempts: input.maxAttempts || 3,
    createdAt,
  };
  // BullMQ `opts`: attempts = retry count (we use maxAttempts so the AppJob
  // field is the single source of truth). Backoff is exponential.
  const added = await queue.add(input.type, data, {
    attempts: data.maxAttempts,
    backoff: { type: "exponential", delay: 1000 },
  });
  return {
    jobId: added.id || `bullmq_${Date.now()}`,
    workspaceId: input.workspaceId,
    type: input.type,
    status: "queued",
    payload: input.payload || {},
    attempts: 0,
    maxAttempts: data.maxAttempts,
    createdAt,
  };
}

/**
 * Start the BullMQ worker. Returns a `stop` function the caller uses for
 * graceful shutdown (called from worker-entrypoint.ts on SIGTERM).
 */
export async function processQueueBullMQ(): Promise<() => Promise<void>> {
  const conn = await getConnection();
  if (!conn) {
    throw new Error("BullMQ process called without a Redis connection (REDIS_URL unset or init failed)");
  }
  const mod = await getBullMQModule();
  if (!mod) {
    throw new Error("BullMQ process called but the bullmq module could not be loaded");
  }
  const worker = new mod.Worker(
    "leadcockpit-jobs",
    async (bullJob: BullMQJob) => {
      const data = bullJob.data;
      if (!externalHandlerResolver) {
        throw new Error("BullMQ worker has no handler resolver — call setHandlerResolverForBullMQ at boot");
      }
      const handler = externalHandlerResolver(data.type);
      if (!handler) {
        // No handler registered — fail loud. Do NOT silently swallow.
        throw new Error(`No handler registered for job type "${data.type}"`);
      }
      const appJob: AppJob = {
        jobId: String(bullJob.id || ""),
        workspaceId: data.workspaceId,
        type: data.type,
        status: "running",
        payload: data.payload,
        attempts: bullJob.attemptsMade || 0,
        maxAttempts: data.maxAttempts,
        createdAt: data.createdAt,
        startedAt: new Date().toISOString(),
      };
      await handler(appJob);
    },
    { connection: conn },
  );
  workerInstance = worker;
  // Graceful: close the worker so in-flight jobs finish.
  return async () => {
    try { await worker.close(); } catch { /* best effort */ }
  };
}

/**
 * List jobs from BullMQ. Returns AppJob-shaped objects (Golden Thread).
 * Note: BullMQ's getJobs returns up to N jobs by status; we default to
 * "completed,waiting,active,delayed,failed" — anything that exists.
 */
export async function listJobsBullMQ(): Promise<AppJob[]> {
  const queue = await getQueue();
  if (!queue) return [];
  const raw = await queue.getJobs(["completed", "waiting", "active", "delayed", "failed"], 0, 100);
  return raw.map((j) => {
    const status = j.finishedOn ? "completed" : j.processedOn ? "running" : "queued";
    return {
      jobId: String(j.id || ""),
      workspaceId: j.data.workspaceId,
      type: j.data.type,
      status,
      payload: j.data.payload,
      attempts: j.attemptsMade || 0,
      maxAttempts: j.data.maxAttempts,
      createdAt: j.data.createdAt,
      startedAt: j.processedOn ? new Date(j.processedOn).toISOString() : undefined,
      completedAt: j.finishedOn ? new Date(j.finishedOn).toISOString() : undefined,
      errorMessage: j.failedReason,
    };
  });
}

/** Test seam: close any open connections (for golden-test cleanup). */
export async function closeBullMQForTesting() {
  if (queuePromise) {
    try { await (await queuePromise).close(); } catch { /* ignore */ }
  }
  if (workerInstance) {
    try { await workerInstance.close(); } catch { /* ignore */ }
  }
  queuePromise = null;
  workerInstance = null;
}
