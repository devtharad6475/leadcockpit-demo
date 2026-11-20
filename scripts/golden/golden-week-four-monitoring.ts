import assert from "node:assert/strict";
import {probeSystemHealth, resetHealthProbe, setProductionProbes} from "@/services/SystemHealthProbe";
import {computeHealthBanner} from "@/lib/health-status";

async function main() {
  resetHealthProbe();
  const absent = await probeSystemHealth();
  assert.equal(absent.errorRate.observed, false);
  assert.equal(computeHealthBanner(absent).status, "yellow");
  setProductionProbes({errorRateProbe: () => {throw new Error("Monitoring unavailable");}});
  assert.equal((await probeSystemHealth()).errorRate.observed, false);
  const healthy = {...absent, scheduler: {status: "ok" as const, lastRunAt: new Date().toISOString()},
    errorRate: {last1h: 0, threshold: 10, observed: true},
    llm: {slots: [{slotId: "fast", provider: "provider", status: "real" as const}]}};
  assert.equal(computeHealthBanner(healthy).status, "green");
  assert.equal(computeHealthBanner({...healthy, llm: {slots: []}}).status, "yellow");
  assert.equal(computeHealthBanner({...healthy, llm: {slots: [{...healthy.llm.slots[0], status: "fallback"}]}}).status, "yellow");
  assert.equal(computeHealthBanner({...absent, database: {up: false, latencyMs: 0}}).status, "red");
  console.log("PASS absent/failed monitoring is unknown; unconfigured/fallback AI is a warning; actual measured health remains green");
}
main().catch(error => {console.error(error); process.exitCode = 1;}).finally(resetHealthProbe);
