/**
 * time-webhook-dedup.ts — how long the duplicate-message check takes on the
 * database this points at, the old way (read the whole database) and the new
 * way (one indexed lookup). Read-only. 2026-09-24.
 *
 * Run: npx tsx scripts/probes/time-webhook-dedup.ts   (needs DATABASE_URL)
 */
import { createRepositories } from "@/repositories";

async function time(label: string, fn: () => Promise<unknown>, runs = 5) {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(`${label.padEnd(34)} median ${samples[Math.floor(runs / 2)].toFixed(0)} ms   (min ${samples[0].toFixed(0)}, max ${samples[runs - 1].toFixed(0)})`);
}

(async () => {
  const repos = createRepositories("prisma");
  await time("old: readAll then search", async () => {
    const data = await repos.readAll!();
    return (data.processedWebhookMessageIds || []).some((m) => m.providerMessageId === "timing-probe");
  });
  await time("new: one indexed lookup", () => repos.hasProcessedWebhookMessage!("timing-probe-ws", "timing-probe"));
  process.exit(0);
})();
