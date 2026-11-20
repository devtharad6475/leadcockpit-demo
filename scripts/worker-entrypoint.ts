/**
 * Stage C.2 — Background worker process entrypoint.
 *
 * Runs on the VPS alongside the Next.js web server. Picks up jobs enqueued
 * to BullMQ (via enqueueJob when REDIS_URL is set) and dispatches them to
 * the handler map.
 *
 * Today (Stage C.2): only the 2 placeholder handlers from
 * registerDefaultJobHandlers are wired (send_notification, sync_integration).
 * Both are no-op console.info placeholders. The 10 real handler
 * implementations (crawl_website, enrich_lead, score_lead, etc.) are
 * Stage C.2-the-future-Milestone — the wiring point is HERE, and adding
 * a handler is a one-line registerJobHandler call in JobHandlers.ts.
 *
 * Graceful shutdown: on SIGTERM/SIGINT, the worker closes (BullMQ lets
 * in-flight jobs finish, then stops polling). No silent job loss.
 *
 * Run:
 *   npm run worker                       # foreground
 *   pm2 start npm --name leadgen-worker -- run worker   # pm2
 *   systemd unit — see docs/STAGE_C_WORKER_RUNBOOK.md
 *
 * If REDIS_URL is unset, this script prints a warning and exits 0 — the
 * in-memory queue in the web process handles jobs in that case (demo mode).
 *
 * 2026-07-27 Stage C.2.
 */
import { registerDefaultJobHandlers } from "@/jobs/JobHandlers";
import { processQueueBullMQ, getActiveQueueBackendName } from "@/jobs/JobQueue";
// Stage C.3: route worker errors to Sentry when configured.
import { initSentry, captureException } from "@/lib/monitoring";

async function main() {
  // Stage C.3: init Sentry (no-op if SENTRY_DSN unset).
  await initSentry();
  const backend = getActiveQueueBackendName();
  if (backend !== "bullmq") {
    console.warn("[worker] REDIS_URL is not set — BullMQ backend is not active.");
    console.warn("[worker] The web process will handle jobs inline via the in-memory queue (demo/single-VPS mode).");
    console.warn("[worker] To enable the durable worker, set REDIS_URL in .env and restart.");
    console.warn("[worker] Exiting 0 — no work to do.");
    process.exit(0);
  }

  console.log(`[worker] Starting BullMQ worker for queue "leadcockpit-jobs"...`);
  registerDefaultJobHandlers();
  const stop = await processQueueBullMQ();
  console.log(`[worker] Worker ready. Listening for jobs (handlers registered for: send_notification, sync_integration).`);

  // Graceful shutdown. BullMQ's worker.close() waits for in-flight jobs.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] Received ${signal}. Draining in-flight jobs before exit...`);
    try {
      await stop();
      console.log(`[worker] Worker closed cleanly. Exiting 0.`);
      process.exit(0);
    } catch (err) {
      // Stage C.3: route shutdown errors to Sentry.
      captureException(err, { source: "worker.shutdown" });
      console.error(`[worker] Error during shutdown: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  // Stage C.3: top-level fatal goes to Sentry before exiting.
  captureException(error, { source: "worker.main.fatal" });
  console.error(`[worker] FATAL:`, error instanceof Error ? error.message : error);
  console.error(error instanceof Error ? error.stack : "");
  process.exit(1);
});
