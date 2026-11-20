import { registerJobHandler } from "./JobQueue";

let registered = false;

export function registerDefaultJobHandlers() {
  if (registered) return;
  registered = true;

  registerJobHandler("send_notification", async (job) => {
    console.info("Notification job placeholder", { jobId: job.jobId, workspaceId: job.workspaceId });
  });

  registerJobHandler("sync_integration", async (job) => {
    console.info("Integration sync job placeholder", { jobId: job.jobId, workspaceId: job.workspaceId });
  });
}
