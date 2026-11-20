/**
 * Stage A+ / Cluster 11 (2026-07-26, P3-H3) — File-size formatter.
 *
 * Replaces the inline `Math.ceil(item.fileSize / 1024) + " KB"` pattern
 * that produces ugly output for large files (e.g. "15625 KB" instead of
 * "15.6 MB"). Routes through one chokepoint so the format is consistent
 * everywhere (build-right Phase 3d).
 *
 * Input is bytes (the standard from the DB / file uploads).
 * Output: human-readable string ("2.4 KB", "1.1 MB", "840 bytes").
 */
export function formatFileSize(bytes: number | undefined | null): string {
  if (bytes == null || isNaN(Number(bytes))) return "Unknown size";
  const b = Number(bytes);
  if (b < 1024) return `${b} ${b === 1 ? "byte" : "bytes"}`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * How long ago something happened, in words an owner reads rather than a
 * timestamp they have to subtract from today (2026-09-04, N-UX-21).
 *
 * Added because the Tickets screen's own one-line explanation promised "how
 * long it has been waiting" and then showed no time at all on any row. The
 * promise came first; this makes it true.
 *
 * Deliberately coarse. "2 days" is what decides whether someone chases a
 * ticket; "2 days 4 hours 11 minutes" is noise at that decision.
 */
export function formatWaitingFor(iso: string | undefined | null, now: Date = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.floor((now.getTime() - then) / 60000);
  // A clock skew between the browser and the server can put a fresh record a
  // few seconds in the future. Reading "in -1 minutes" is worse than reading
  // "just now", and both mean the same thing to the person looking.
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"}`;
}
