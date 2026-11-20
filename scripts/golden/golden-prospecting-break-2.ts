/**
 * golden-prospecting-break-2.ts — the second break test of finding and managing
 * customers (2026-09-27). Each case below failed on the code before the fix.
 *
 *   L1  no search key / a failed search invented companies in EVERY workspace,
 *       and the daily run made leads + drafts of them and reported no error.
 *       Rule: invented prospects only for the sample company on the demo site;
 *       elsewhere zero, with "Search is not connected" in the run summary.
 *   L2  discovery merged a different "Balaji Textiles" (other city, website,
 *       phone) into the existing lead on the name alone and wrote its email in.
 *   L3  website contact scraping fetched internal / metadata addresses, and
 *       fetch() followed redirects to them; the SSRF guard let IPv4-mapped IPv6
 *       and 100.64.0.0/10 through.
 *   L4/L6 one shared "same company?" rule: website host, phone (last 10),
 *       email, name (NFC, any script) — CSV, discovery, manual add.
 *   L5  common Indian CSV headers ("Firm Name", "Mobile No.", "Email ID").
 *   L7  the digest's "new leads" counted found-again leads; the daily run could
 *       run twice in a day.
 *   L8  editing a lead to a number on the do-not-contact register left it
 *       contactable.
 *   L9  a campaign from another company was accepted on a lead.
 *
 * No network: fetch is stubbed and records every URL asked for.
 * Run: npm run golden:prospecting-break-2
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { Campaign, Lead } from "@/lib/types";
import { ProspectingService, scrapeWebsiteContacts, type ProspectingCandidate } from "@/services/ProspectingService";
import { importLeadsFromCsv, createManualLead, updateLeadDetails, type CsvImportResult } from "@/services/LeadImportService";
import { registerDoNotContact } from "@/lib/dnc-registry";
import { assertSafeFetchUrl } from "@/lib/ssrf-guard";
import { crawlWebsite } from "@/lib/crawler";
import { isSameCompany } from "@/lib/same-company";
import { runDailyDiscoveryForWorkspace, digestRunFromSummary } from "@/services/DailyProspectingScheduler";
import { defaultWorkspaceId } from "@/lib/db";

delete process.env.PLATFORM_SERPAPI_API_KEY;
delete process.env.SERPAPI_API_KEY;
delete process.env.AUTH_MODE;

const fetched: string[] = [];
let respond: (url: string) => Response = () => new Response("<html><head><title>SECRET-INTERNAL-TITLE</title></head><body>root@internal.corp</body></html>", { status: 200 });
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  fetched.push(url);
  return respond(url);
}) as typeof fetch;

const repos = createJsonRepos() as RepositoryBundle;
const cases: Array<[string, () => Promise<void>]> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push([name, fn]);

class Stub extends ProspectingService {
  constructor(private readonly found: Array<Partial<Lead>>) { super(repos); }
  async generateSearchQueries() { return { queries: ["stub"], llm: undefined, warning: "" }; }
  async searchGoogleMaps() {
    return { mode: "live_google_maps" as const, provider: "serpapi", candidates: this.found.map((f) => ({ ...f, searchQuery: "stub", searchMode: "live_google_maps", sourceProvider: "serpapi" }) as ProspectingCandidate) };
  }
}
/** Real search path, only the query generation stubbed (no AI call). */
class RealSearch extends ProspectingService {
  constructor() { super(repos); }
  async generateSearchQueries() { return { queries: ["saree wholesalers Surat"], llm: undefined, warning: "" }; }
}

async function ws(slug: string) {
  const id = `ws_pb2_${slug}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await repos.workspace.create({ id, name: slug, status: "active" } as never);
  return id;
}
async function camp(workspaceId: string): Promise<Campaign> {
  return repos.campaign.create({ workspaceId, name: "c", goal: "g", targetRegion: ["Surat"], productFocus: ["zari"], offer: "x", selectedChannels: ["whatsapp"], dailyOutreachLimit: 5, leadGoal: 10, status: "active", approvalStatus: "approved", plan: { searchQueries: ["stub"] } as Campaign["plan"] } as Partial<Campaign>);
}
const ok = (r: unknown): CsvImportResult => { assert.ok(r && typeof r === "object" && "created" in r, `import refused: ${JSON.stringify(r)}`); return r as CsvImportResult; };
async function rejects400(fn: () => Promise<unknown>, label: string) {
  await assert.rejects(fn, (error: Error & { statusCode?: number }) => error.statusCode === 400 && /campaign was not found/i.test(error.message), label);
}

test("L1 — no search key in a real company: nobody invented, the run says so", async () => {
  const w = await ws("l1");
  const c = await camp(w);
  const result = await new RealSearch().prospectForWorkspace({ workspaceId: w, campaignId: c.id, limit: 5 });
  assert.strictEqual(result.created, 0, "no invented leads outside the demo company");
  assert.strictEqual(result.mode, "search_unavailable");
  assert.ok(result.warnings.some((x) => /Search is not connected/.test(x)), `warning expected, got ${JSON.stringify(result.warnings)}`);
  assert.strictEqual((await repos.lead.listLeads(w)).length, 0);
});

test("L1 — a failing SerpApi in a real company: nobody invented", async () => {
  const w = await ws("l1b");
  const c = await camp(w);
  process.env.PLATFORM_SERPAPI_API_KEY = "test-key-not-real";
  const before = respond;
  respond = () => { throw new Error("network disabled"); };
  try {
    const result = await new RealSearch().prospectForWorkspace({ workspaceId: w, campaignId: c.id, limit: 5 });
    assert.strictEqual(result.created, 0);
    assert.ok(result.warnings.some((x) => /Search failed .* no new buyers found today/.test(x)), JSON.stringify(result.warnings));
  } finally {
    delete process.env.PLATFORM_SERPAPI_API_KEY;
    respond = before;
  }
});

test("L1 — the sample company on the demo site still gets sample prospects; not in production", async () => {
  const c = await camp(defaultWorkspaceId);
  const demo = await new RealSearch().searchGoogleMaps("zari buyers", 2, c);
  assert.strictEqual(demo.candidates.length, 2, "demo workspace in demo mode keeps sample prospects");
  process.env.AUTH_MODE = "production";
  try {
    const prod = await new RealSearch().searchGoogleMaps("zari buyers", 2, c);
    assert.strictEqual(prod.candidates.length, 0, "the demo workspace id on a production site is not the demo");
  } finally {
    delete process.env.AUTH_MODE;
  }
});

test("L1 + L7 — daily run carries the search error; a second run the same day does nothing", async () => {
  const w = await ws("sched");
  await repos.businessProfile.create({ workspaceId: w, companyName: "Real Zari Co", products: ["zari"] } as never);
  await camp(w);
  const day = "2026-09-28";
  const first = await runDailyDiscoveryForWorkspace(w, repos, { day });
  assert.strictEqual(first.leadsCreated, 0);
  assert.strictEqual(first.draftsGenerated, 0);
  assert.ok(first.errors.some((x) => /Search is not connected — no new buyers found today/.test(x)), `errors: ${JSON.stringify(first.errors)}`);
  assert.ok((first.warnings || []).length > 0, "warnings reach the run summary");
  assert.ok(digestRunFromSummary(first).errors.some((e) => /Search is not connected/.test(e.message)), "and the digest");
  const runsAfterFirst = (await repos.agentRun.listRecent(w, 100)).length;
  assert.ok(runsAfterFirst > 0, "the first run ran discovery");
  const second = await runDailyDiscoveryForWorkspace(w, repos, { day });
  assert.ok(second.skipped && /already ran/.test(second.skipped), `second run must skip, got ${JSON.stringify(second)}`);
  assert.strictEqual(second.campaignsRun, 0);
  assert.strictEqual((await repos.agentRun.listRecent(w, 100)).length, runsAfterFirst, "no second discovery");
  const nextDay = await runDailyDiscoveryForWorkspace(w, repos, { day: "2026-09-29" });
  assert.ok(!nextDay.skipped, "the next day runs");
});

test("L7 — the digest counts only newly created leads", async () => {
  const line = digestRunFromSummary({ workspaceId: "w", campaignsRun: 1, candidatesDiscovered: 7, leadsCreated: 2, leadsUpdated: 5, draftsGenerated: 2, errors: [] });
  assert.strictEqual(line.leadsDiscovered, 2);
});

test("L2 — a different company with the same name is not merged; same phone is", async () => {
  const w = await ws("l2");
  const c = await camp(w);
  const existing = await repos.lead.createLead({ workspaceId: w, companyName: "Balaji Textiles", websiteUrl: "https://balajitextiles-surat.in", city: "Surat", phone: "+91 90000 11111", status: "approved", reviewStatus: "approved" } as Partial<Lead>);
  const r = await new Stub([{ companyName: "Balaji Textiles", websiteUrl: "https://balaji-textiles-delhi.invalid", city: "Delhi", phone: "+91 90000 22222", email: "delhi@balaji.invalid" }]).prospectForWorkspace({ workspaceId: w, campaignId: c.id, limit: 5 });
  assert.strictEqual(r.created, 1, "the Delhi company is a new lead");
  assert.strictEqual((await repos.lead.getLeadById(w, existing.id))?.email, undefined, "the Surat lead's email is untouched");
  const r2 = await new Stub([{ companyName: "BT Surat Pvt", websiteUrl: "https://bt-surat.invalid", phone: "09000011111" }]).prospectForWorkspace({ workspaceId: w, campaignId: c.id, limit: 5 });
  assert.strictEqual(r2.created, 0, "same phone is the same company");
  const r3 = await new Stub([{ companyName: "बालाजी ज़री" }, { companyName: "बालाजी ज़री".normalize("NFD") }]).prospectForWorkspace({ workspaceId: w, campaignId: c.id, limit: 5 });
  assert.strictEqual(r3.created, 1, "a Hindi name found twice is one lead");
});

test("L4 — shared rule units", async () => {
  assert.ok(isSameCompany({ websiteUrl: "https://www.ShreeZari.in/contact?x=1" }, { websiteUrl: "shreezari.in" }));
  assert.ok(isSameCompany({ email: " Sales@X.in " }, { email: "sales@x.in" }));
  assert.ok(!isSameCompany({ companyName: "बालाजी" }, { companyName: "बाला" }), "different Hindi names differ");
  assert.ok(!isSameCompany({ companyName: "Untitled prospect", phone: "9825011111" }, { companyName: "Untitled prospect", phone: "9825022222" }), "placeholder names never match");
  assert.ok(isSameCompany({ companyName: "Shree Zari" }, { companyName: "Shree Zari", websiteUrl: "shreezari.in" }), "name with one website missing matches");
});

test("L4/L5 — CSV duplicates, Unicode and Indian headers", async () => {
  const w = await ws("csv");
  await repos.lead.createLead({ workspaceId: w, companyName: "Shree Zari", websiteUrl: "https://shreezari.in", phone: "+91 98250 11111", email: "sales@shreezari.in", status: "needs_review" } as Partial<Lead>);
  const dup = ok(await importLeadsFromCsv(w, ["Company Name,Website,Phone,Email", "Shree Zari,,,", "Shree Zari Pvt Ltd,https://www.shreezari.in/contact,,", "SZ Threads,,09825011111,", "Other Name,,,SALES@ShreeZari.in", "Shree Zari,shreezari.in?utm=x,,"].join("\n"), {}, repos));
  assert.strictEqual(dup.created, 0, `all five rows are the existing company, created ${dup.created}: ${dup.leads.map((l) => l.companyName).join(", ")}`);
  const nfc = "Café Zari".normalize("NFC"), nfd = "Café Zari".normalize("NFD");
  const uni = ok(await importLeadsFromCsv(await ws("uni"), `company_name,phone\n${nfc},\n${nfd},\n"Balaji Zari",\n"Balaji Zari ",\nबालाजी ज़री,\n${"बालाजी ज़री".normalize("NFD")},\n`, {}, repos));
  assert.strictEqual(uni.created, 3, `three companies, got ${uni.leads.map((l) => JSON.stringify(l.companyName)).join(", ")}`);
  const hdr = ok(await importLeadsFromCsv(await ws("hdr"), "Firm Name,Mobile No.,Email ID,City/Town,WhatsApp No,GST No\nKirti Zari,+91 90000 00004,k@k.in,Surat,+91 90000 00005,24AAAAA0000A1Z5\nParty Two,,,,,\n", {}, repos));
  assert.strictEqual(hdr.created, 2);
  const kirti = hdr.leads.find((l) => l.companyName === "Kirti Zari");
  assert.ok(kirti, `Firm Name read as the company: ${hdr.leads.map((l) => l.companyName)}`);
  assert.strictEqual(kirti!.phone, "+91 90000 00004");
  assert.strictEqual(kirti!.email, "k@k.in");
  assert.strictEqual(kirti!.city, "Surat");
  assert.strictEqual(kirti!.whatsappNumber, "+91 90000 00005");
  const party = ok(await importLeadsFromCsv(await ws("party"), "Party Name,Contact No\nMehta Laces,98250 44444\n", {}, repos));
  assert.strictEqual(party.leads[0]?.companyName, "Mehta Laces");
  assert.strictEqual(party.leads[0]?.phone, "98250 44444");
});

test("L6 — manual add refuses the same name again (409), allows two phone-only leads", async () => {
  const a = await ws("manual");
  await createManualLead(a, { companyName: "Same Name Co" }, repos);
  await assert.rejects(() => createManualLead(a, { companyName: "same  name co." }, repos), (e: Error & { statusCode?: number }) => e.statusCode === 409);
  await createManualLead(a, { phone: "9825055551" }, repos);
  await createManualLead(a, { phone: "9825055552" }, repos);
});

test("L3 — the SSRF guard blocks mapped, bracketed and CGNAT addresses", async () => {
  for (const url of ["http://[::1]:3000/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:a9fe:a9fe]/latest/meta-data/", "http://[::ffff:7f00:1]/", "http://[0:0:0:0:0:ffff:10.0.0.1]/", "http://[fd00::1]/", "http://100.100.100.200/", "http://100.64.0.1/", "http://0x7f000001/", "http://127.1/", "http://[0:0:0:0:0:0:0:1]/", "http://[64:ff9b::a9fe:a9fe]/"]) {
    assert.strictEqual((await assertSafeFetchUrl(url)).safe, false, `${url} must be blocked`);
  }
  assert.strictEqual((await assertSafeFetchUrl("http://100.128.0.1/")).safe, true, "outside 100.64/10 is public");
});

test("L3 — contact scraping never reads internal addresses, even through a redirect", async () => {
  fetched.length = 0;
  const info = await scrapeWebsiteContacts("http://169.254.169.254/latest/meta-data/");
  assert.deepStrictEqual(fetched, [], "metadata address never requested");
  assert.ok(!info.fetched && !info.title);
  const before = respond;
  respond = (url) => url.startsWith("https://public-site.invalid") ? new Response("", { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } }) : new Response("<title>SECRET</title>", { status: 200 });
  try {
    fetched.length = 0;
    const redirected = await scrapeWebsiteContacts("https://public-site.invalid/");
    assert.ok(!(fetched as string[]).some((u) => u.includes("127.0.0.1")), `redirect target must not be fetched: ${fetched}`);
    assert.ok(!redirected.fetched && redirected.title !== "SECRET");
    fetched.length = 0;
    await assert.rejects(() => crawlWebsite("https://public-site.invalid/", 2));
    assert.ok(!(fetched as string[]).some((u) => u.includes("127.0.0.1")), `crawler must not follow the redirect: ${fetched}`);
  } finally {
    respond = before;
  }
});

test("L8 — editing a lead to an opted-out number marks it do-not-contact, with an audit record", async () => {
  const w = await ws("l8");
  await registerDoNotContact(w, { phone: "919825033333", reason: "stop" }, repos);
  const lead = await repos.lead.createLead({ workspaceId: w, companyName: "Edit Co", status: "needs_review" } as Partial<Lead>);
  const edited = await updateLeadDetails(w, lead.id, { whatsappNumber: "+91 98250 33333" }, repos, "user_owner");
  assert.strictEqual(edited.doNotContact, true);
  assert.strictEqual(edited.status, "do_not_contact");
  const audit = (await repos.auditLog.listByWorkspace(w)).find((row) => row.eventType === "lead.do_not_contact_matched" && row.entityId === lead.id);
  assert.ok(audit, "audit record written");
  const clean = await updateLeadDetails(w, (await repos.lead.createLead({ workspaceId: w, companyName: "Fine Co" } as Partial<Lead>)).id, { phone: "+91 98250 99999" }, repos);
  assert.ok(!clean.doNotContact, "a number not on the register changes nothing");
});

test("L9 — a campaign from another company is refused everywhere", async () => {
  const a = await ws("A"); const b = await ws("B");
  const foreign = await camp(b);
  await rejects400(() => createManualLead(a, { companyName: "Cross Co", campaignId: foreign.id }, repos), "manual add");
  await rejects400(() => importLeadsFromCsv(a, "company_name\nCross CSV\n", { campaignId: foreign.id }, repos), "CSV import");
  const lead = await repos.lead.createLead({ workspaceId: a, companyName: "Mine" } as Partial<Lead>);
  await rejects400(() => updateLeadDetails(a, lead.id, { campaignId: foreign.id }, repos), "lead edit");
  const own = await camp(a);
  assert.strictEqual((await updateLeadDetails(a, lead.id, { campaignId: own.id }, repos)).campaignId, own.id, "own campaign accepted");
});

async function main() {
  let failed = 0;
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL ${name}\n    ${error instanceof Error ? error.message : error}`);
    }
  }
  if (failed) {
    console.error(`FAIL golden-prospecting-break-2: ${failed}/${cases.length} cases failed.`);
    process.exit(1);
  }
  console.log(`PASS golden-prospecting-break-2: ${cases.length} cases.`);
}
main().catch((error) => { console.error(error); process.exit(1); });
