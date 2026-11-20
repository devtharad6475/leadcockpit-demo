import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { createJsonRepos } from "./_helpers/provider";
import { ensureWorkspace } from "./_helpers/fixtures";
import { ProspectingService, type ProspectingCandidate, type ProspectingMode } from "@/services/ProspectingService";
import { registerDoNotContact } from "@/lib/dnc-registry";
import { IntegrationCredentialService } from "@/services/IntegrationCredentialService";
import type { Campaign, ICP, Lead } from "@/lib/types";
import type { RepositoryBundle } from "@/repositories/interfaces";

// Exercise real discovery persistence/registry gates. Only external search and
// AI qualification are replaced; neither live credentials nor network is used.
class DiscoveryFixture extends ProspectingService {
  constructor(repos: RepositoryBundle, private readonly contact: Partial<Lead>, private readonly mode: ProspectingMode = "fallback_demo") { super(repos); }
  async generateSearchQueries() { return { queries: ["fixture"], llm: undefined, warning: "Deterministic test queries; no research provider was called." }; }
  async searchGoogleMaps(_query: string, _limit: number, _campaign?: Campaign, _icp?: ICP, workspaceKey?: string) {
    if (this.mode === "live_google_maps") assert.equal(workspaceKey, "synthetic-search-key");
    return { mode: this.mode, provider: "fixture", candidates: [{ companyName: "Fixture Buyer", searchQuery: "fixture", searchMode: this.mode, sourceProvider: "fixture" } as ProspectingCandidate] };
  }
  async qualifyLead() { return { companyName: "Fixture Buyer", ...this.contact }; }
}

const repos = createJsonRepos();
const cases: Array<[string, () => Promise<void>]> = [];
async function fixture(tag: string) {
  const workspaceId = `week_two_discovery_${tag}`;
  await ensureWorkspace(repos, workspaceId);
  const campaign = await repos.campaign.create({ workspaceId, name: "Buyer discovery", goal: "Find buyers", targetRegion: ["India"], productFocus: ["Products"], selectedChannels: ["whatsapp"], status: "active", approvalStatus: "approved" });
  return { workspaceId, campaignId: campaign.id };
}
for (const [label, contact, registration] of [
  ["alternate phone", { whatsappNumber: "+919111111111", phone: "+919222222222" }, { phone: "+919222222222" }],
  ["WhatsApp number", { whatsappNumber: "+919333333333", phone: "+919444444444" }, { phone: "+919333333333" }],
  ["email", { whatsappNumber: "+919555555555", email: "Buyer@Example.invalid" }, { email: "buyer@example.invalid" }],
  ["website", { whatsappNumber: "+919666666666", websiteUrl: "https://www.blocked.example.invalid/contact" }, { website: "blocked.example.invalid" }],
] as const) {
  cases.push([`discovery never recreates a contact blocked by ${label}`, async () => {
    const input = await fixture(label.replace(/\W/g, "_"));
    await registerDoNotContact(input.workspaceId, { ...registration, reason: "Customer opted out" }, repos);
    const result = await new DiscoveryFixture(repos, contact).prospectForWorkspace(input);
    assert.equal(result.created, 0);
    assert.deepEqual(result.newLeadIds, []);
    assert.deepEqual(await repos.lead.listLeads(input.workspaceId), []);
  }]);
}
cases.push(["another company's opt-out does not block this company's buyer", async () => {
  const input = await fixture("scoped");
  const other = await fixture("other");
  await registerDoNotContact(other.workspaceId, { phone: "+919777777777", reason: "stop" }, repos);
  const result = await new DiscoveryFixture(repos, { phone: "+919777777777" }).prospectForWorkspace(input);
  assert.equal(result.created, 1);
  assert.equal(result.leads[0].reviewStatus, "pending");
  assert.equal(result.leads[0].status, "needs_review");
}]);
cases.push(["registry failure stops discovery without creating a buyer and records failure", async () => {
  const input = await fixture("failure");
  const broken = { ...repos, doNotContact: { ...repos.doNotContact, findMatch: async () => { throw new Error("registry unavailable"); } } } as RepositoryBundle;
  await assert.rejects(() => new DiscoveryFixture(broken, { whatsappNumber: "+919888888888", phone: "+919999999999" }).prospectForWorkspace(input), /registry unavailable/);
  assert.equal((await repos.lead.listLeads(input.workspaceId)).length, 0);
  const runs = await repos.agentRun.listRecent(input.workspaceId);
  assert.equal(runs[0].status, "failed");
  assert.match(runs[0].errorMessage || "", /registry unavailable/);
}]);
cases.push(["saved workspace search key is reported configured and passed into search", async () => {
  const input = await fixture("workspace_key");
  await new IntegrationCredentialService(repos).save(input.workspaceId, "serpapi", "synthetic-search-key");
  const result = await new DiscoveryFixture(repos, { phone: "+918111111111" }, "live_google_maps").prospectForWorkspace(input);
  assert.equal(result.providerStatus.serpApiConfigured, true);
  assert.equal(result.mode, "live_google_maps");
}]);

async function main() {
  process.env.PLATFORM_SERPAPI_API_KEY = "";
  process.env.SERPAPI_API_KEY = "";
  let failed = 0;
  for (const [name, test] of cases) {
    try { await test(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
  }
  console.log(`week-two-discovery-dnc: ${cases.length - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
void main();
