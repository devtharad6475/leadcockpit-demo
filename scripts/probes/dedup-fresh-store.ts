import "../golden/_helpers/isolate-standalone";
import { createRepositories } from "@/repositories";
import { hasProcessedMessageId, recordProcessedMessageId } from "@/services/WebhookDedupService";

(async () => {
  const repos = createRepositories();
  const ws = `ws_probe_${Date.now()}`;
  const before = await repos.readAll?.();
  console.log("BEFORE any dedup write — typeof processedWebhookMessageIds:",
    Array.isArray(before?.processedWebhookMessageIds) ? "array" : String(before?.processedWebhookMessageIds));

  console.log("delivery 1 — hasProcessed:", await hasProcessedMessageId(ws, "wamid.PROBE1", repos));
  await recordProcessedMessageId(ws, "wamid.PROBE1", "processed", "+15550000", repos);
  const after = await repos.readAll?.();
  console.log("AFTER first write — typeof:", Array.isArray(after?.processedWebhookMessageIds) ? "array" : String(after?.processedWebhookMessageIds));
  console.log("delivery 2 (duplicate) — hasProcessed:", await hasProcessedMessageId(ws, "wamid.PROBE1", repos));
})();
