export const JOB_TYPES = [
  "crawl_website",
  "extract_business_profile",
  "generate_icps",
  "generate_campaign_plan",
  "discover_prospects",
  "enrich_lead",
  "score_lead",
  "generate_message",
  "classify_reply",
  "generate_campaign_learning",
  "send_notification",
  "sync_integration",
  "import_json_to_postgres",
] as const;

export type JobType = (typeof JOB_TYPES)[number];
export type JobStatus = "queued" | "running" | "completed" | "failed";

export type AppJob = {
  jobId: string;
  workspaceId: string;
  type: JobType;
  status: JobStatus;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
};

export type JobInput = Omit<AppJob, "jobId" | "status" | "attempts" | "createdAt"> & {
  jobId?: string;
  status?: JobStatus;
  attempts?: number;
  createdAt?: string;
};
