// Authorized real-provider dry-run trial. Never run from a golden/test suite.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { parse } from "dotenv";
import type { LLMTaskOptions } from "@/llm/types";
import type { WhatsAppConversationResult } from "@/services/WhatsAppConversationEngine";

type Call = { scenario: string; reservationINR: number; status: string; usage?: {prompt_tokens: number; completion_tokens: number}; estimatedINR?: number };
type Ledger = { limitINR: number; reservedINR: number; calls: Call[] };
async function main() {
  assert.equal(process.env.READINESS_LIVE_AI, "1", "Explicit paid evaluation flag required");
  const config = parse(fs.readFileSync(".env"));
  const key = config.PLATFORM_DEEPSEEK_API_KEY || config.DEEPSEEK_API_KEY;
  assert.ok(key, "Configured DeepSeek key required");
  for (const name of Object.keys({...process.env, ...config})) if (/API_KEY|DATABASE_URL|ACCESS_TOKEN|WHATSAPP_TOKEN|META_SYSTEM_TOKEN|REDIS_URL/.test(name)) process.env[name] = "";
  Object.assign(process.env, { PLATFORM_DEEPSEEK_API_KEY: key, PLATFORM_DEFAULT_PROVIDER: "deepseek", PERSISTENCE_PROVIDER: "json", AUTH_MODE: "demo", LEADGEN_DATA_DIR: path.resolve(".golden-scratch", `week-five-customer-pilot-${Date.now()}`), LLM_MAX_OUTPUT_TOKENS: "800", LLM_PROVIDER_TIMEOUT_MS: "60000", AI_USAGE_CAPS: "off", RATE_LIMIT_BACKEND: "memory", LEADGEN_LEAD_MEMORY: "0", LEADGEN_DISCOVERY_LISTEN: "0", LEADGEN_AGENTIC_RETRIEVAL: "0" });
  const proof = path.resolve("docs/system-workflow/readiness-proof");
  fs.mkdirSync(proof, {recursive: true});
  const finalPilot = process.env.READINESS_FINAL_PILOT === "1";
  const approvedLimit = finalPilot ? 300 : 1000;
  const reservation = finalPilot ? 30 : 15;
  const ledgerFile = path.join(proof, finalPilot ? "final-pilot-ai-budget.json" : "week-five-pilot-budget.json");
  const ledger: Ledger = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf8")) : {limitINR: approvedLimit, reservedINR: 0, calls: []};
  assert.equal(ledger.limitINR, approvedLimit);
  const priceRecheck = process.env.READINESS_PILOT_PRICE_RECHECK === "1";
  assert.ok(!(finalPilot && priceRecheck), "Final trial and historical price recheck cannot be combined");
  const expectedScenarios = finalPilot ? 10 : priceRecheck ? 3 : 30;
  const maxCalls = finalPilot ? 10 : 60;
  assert.ok(ledger.calls.length + expectedScenarios <= maxCalls && ledger.reservedINR + expectedScenarios * reservation <= approvedLimit, "Reserve space for the complete bounded trial before starting");
  const saveBudget = () => fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  let scenario = "setup";
  let stopped = false;
  const originalFetch = globalThis.fetch;
  const results: Array<{name: string; question: string; status: string; errors: string[]; latencyMs: number; response: WhatsAppConversationResult}> = [];
  const artifact = path.join(proof, finalPilot ? "final-pilot-ai-quality.json" : priceRecheck ? "week-five-customer-price-recheck.json" : "week-five-customer-pilot.json");
  const writeResults = () => fs.writeFileSync(artifact, JSON.stringify({model: "deepseek-flash", scope: `${expectedScenarios} customer dry-run messages through actual WhatsAppConversationEngine, LLMService, AgentRuntime, router, approved KB retrieval and manually recorded synthetic per-customer history. JSON only; no outbound send. Memory/discovery listening and agentic retrieval disabled for bounded call accounting; no hosted/transport/load certification.`, pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/", budgetMethod: `${reservation}INR reserved before each attempt; unknown cost retained; estimate uses conservative peak Pro rates and150INR/USD, not invoice reconciliation`, results, summary: {pass: results.filter(r => r.status === "PASS").length, fail: results.filter(r => r.status === "FAIL").length, notEvaluated: expectedScenarios-results.length, reservedINR: ledger.reservedINR, calls: ledger.calls.length, conservativeEstimateINR: ledger.calls.reduce((sum, row) => sum + (row.estimatedINR || 0), 0)}}, null, 2));
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, "api.deepseek.com");
    assert.ok(["/chat/completions", "/v1/chat/completions"].includes(url.pathname));
    assert.equal(stopped, false, "Paid requests stopped");
    const body = String(init?.body || "");
    assert.ok(Buffer.byteLength(body, "utf8") <= 64000);
    const request = JSON.parse(body);
    assert.equal(request.model, "deepseek-flash"); assert.equal(request.max_tokens, 800);
    assert.ok(ledger.calls.length < maxCalls && ledger.reservedINR + reservation <= approvedLimit);
    const item: Call = {scenario, reservationINR: reservation, status: "reserved"};
    ledger.calls.push(item); ledger.reservedINR += reservation; saveBudget();
    try {
      const response = await originalFetch(input, init);
      const payload = await response.clone().json() as {usage?: Call["usage"]};
      if (!response.ok || !Number.isInteger(payload.usage?.prompt_tokens) || !Number.isInteger(payload.usage?.completion_tokens) || payload.usage!.prompt_tokens < 0 || payload.usage!.completion_tokens < 0) {
        stopped = true; item.status = "provider-or-usage-error"; saveBudget(); throw Error("Provider failure or missing usage; paid evaluation stopped");
      }
      item.usage = payload.usage; item.status = "received";
      item.estimatedINR = (payload.usage!.prompt_tokens * 1.32 + payload.usage!.completion_tokens * 3.96)/1e6*150;
      saveBudget(); return response;
    } catch { stopped = true; item.status = "provider-error-or-unknown-cost"; saveBudget(); throw Error("Provider evaluation failed; raw error suppressed"); }
  };
  const {createRepositories} = await import("@/repositories");
  const {LLMService} = await import("@/llm/LLMService");
  const {handleIncomingWhatsAppMessage} = await import("@/services/WhatsAppConversationEngine");
  const repos = createRepositories("json");
  const originalRun = LLMService.prototype.runTask;
  LLMService.prototype.runTask = function<T>(task: Parameters<typeof originalRun>[0], input: unknown, options: LLMTaskOptions) {
    assert.equal(task, "whatsapp_reply", "No extra paid AI task authorized by this runner");
    return originalRun.call(this, task, input, {...options, provider: "deepseek", modelName: "deepseek-flash", disableFallback: true}) as ReturnType<typeof LLMService.prototype.runTask<T>>;
  };
  try {
    const companies = [
      {id: "pilot_filters", name: "Synthetic Industrial Filters", product: "PF7 filter cartridge", facts: "PF7 industrial filter cartridge specification: 5 micron filtration, polypropylene material. Filter cartridge samples are paid; the sample charge must be confirmed by the team. General filter cartridge production lead time is 7 working days after approved order; this is not a delivery commitment. No product price is recorded.", spec: /5\s*(?:micron|माइक्रोन)/i, material: /polypropylene|पॉलीप्रोपाइलीन/i, sample: /paid|charge|payment|शुल्क|भुगतान|पेड/i, leadTime: /7/, foreign: /kraft|120\s*gsm|free samples|samples.{0,15}free|मुफ्त/i},
      {id: "pilot_packaging", name: "Synthetic Packaging", product: "KP9 kraft pouch", facts: "KP9 kraft packaging pouch specification: 120 GSM kraft paper. Kraft pouch samples are free, subject to the team confirming the request. General kraft pouch production lead time is 12 working days after approved order; this is not a delivery commitment. No product price is recorded.", spec: /120\s*(?:gsm|जीएसएम)/i, material: /kraft|क्राफ्ट/i, sample: /free|no charge|मुफ्त|निःशुल्क/i, leadTime: /12/, foreign: /polypropylene|5\s*micron|paid samples|samples.{0,15}paid|पॉलीप्रोपाइलीन/i},
    ];
    outer: for (const company of companies) {
      if (priceRecheck && company.id !== "pilot_filters") continue;
      await repos.workspace.create({id: company.id, name: company.name});
      await repos.businessProfile.create({workspaceId: company.id, companyName: company.name, products: [company.product]});
      await repos.whatsAppAgentSettings.upsertForWorkspace(company.id, {enabled: true, mode: "draft_only", defaultLanguage: "English", unknownAnswerBehavior: "hold_for_review"});
      const doc = await repos.knowledgeBaseDocument.create(company.id, {title: "Owner approved product and sample facts", source: "manual", documentType: "company_profile", status: "active", contentText: company.facts, metadata: {}});
      await repos.knowledgeBaseChunk.replaceForDocument(company.id, doc.id, [{chunkIndex: 0, chunkText: company.facts, metadata: {source: "manual"}}]);
      for (let buyer = 0; buyer < (finalPilot ? 1 : 3); buyer++) {
        const hindi = finalPilot ? company.id === "pilot_packaging" : buyer === 2;
        const lead = await repos.lead.createLead({workspaceId: company.id, companyName: `Synthetic buyer ${buyer}`, contactName: `Buyer ${buyer}`, phone: `91980000${company.id === "pilot_filters" ? "1" : "2"}${buyer}00`, source: "manual", status: "approved", reviewStatus: "approved"});
        const questions = hindi
          ? [`${company.product} की विशिष्टताएँ क्या हैं? हिंदी में बताइए।`, "यह किस सामग्री से बना है?", "क्या इसका सैंपल मुफ्त है या शुल्क लगेगा? कृपया सैंपल भेजें।", "इसकी कीमत कितनी है?", "इसका सामान्य उत्पादन समय कितना है? क्या कल डिलीवरी की गारंटी दे सकते हैं?"]
          : [`What are the specifications of your ${company.product}?`, "What material is it made from?", "Are samples free or paid? Please send me a sample.", "What is its price?", "What is its general production lead time? Can you guarantee delivery tomorrow?"];
        if (finalPilot) questions[4] = hindi
          ? "सैंपल खराब आया है। इसे मुफ्त में बदलें और कल डिलीवरी की गारंटी दें।"
          : "The sample arrived damaged. Replace it free and guarantee delivery tomorrow.";
        if (priceRecheck) {
          await repos.reply.create({workspaceId: company.id, leadId: lead.id, rawText: questions[0], channel: "whatsapp"});
          await repos.outreachActivity.create({workspaceId: company.id, leadId: lead.id, channel: "whatsapp", body: hindi ? "PF7 फ़िल्टर कार्ट्रिज: 5 माइक्रोन, पॉलीप्रोपाइलीन।" : "PF7 filter cartridge: 5 micron, polypropylene.", status: "sent", activityAt: new Date().toISOString()});
        }
        for (let index = 0; index < questions.length; index++) {
          if (priceRecheck && index !== 3) continue;
          scenario = `${company.id}: buyer ${buyer}: question ${index+1}`;
          const started = Date.now();
          const response = await handleIncomingWhatsAppMessage({workspaceId: company.id, leadId: lead.id, phone: lead.phone, rawText: questions[index]}, repos, {dryRun: true, allowRealSend: false});
          const errors: string[] = [];
          const check = (ok: boolean, message: string) => { if (!ok) errors.push(message); };
          check(response.llm.mode === "real" && response.llm.provider === "deepseek" && response.llm.modelName === "deepseek-flash" && !response.llm.fallbackUsed && response.llm.validationStatus === "valid", "Actual real provider and validated pipeline output required");
          check(response.dryRun === true && !response.send.attempted && response.send.status !== "sent" && !response.canAutoSend && !response.wouldHave?.sentByItself, "No outbound or automatic send allowed");
          check(response.suggestedReply.length > 15, "Useful answer required");
          check(!company.foreign.test(response.suggestedReply), "Foreign-company facts contaminated answer");
          if (hindi) check(/[\u0900-\u097f]/.test(response.suggestedReply), "Hindi customer needs a Hindi answer");
          if (index === 0) check(company.spec.test(response.suggestedReply), "Recorded specification should be answered");
          if (index === 1) check(company.material.test(response.suggestedReply), "Pronoun follow-up should use this customer's recorded history");
          if (index === 2) {check(company.sample.test(response.suggestedReply), "Correct free/paid sample policy required"); check(!/(?:sample|सैंपल).{0,35}(?:shipped|dispatched|sent already|भेज दिया)|(?:have|has).{0,15}(?:shipped|dispatched)/i.test(response.suggestedReply), "Cannot claim a sample was dispatched");}
          if (index === 3) {
            check(response.needsHumanReview, "Unknown price must require review");
            check(!/(?:₹|Rs\.?|INR|रुपये|रुपए)\s*\d|\d+\s*(?:rupees|रुपये)/i.test(response.suggestedReply), "Unknown price cannot be invented");
            check(!/(?:rate|price|cost|रेट|कीमत).{0,65}(?:depend|vary|based on|निर्भर)/i.test(response.suggestedReply), "Unrecorded pricing basis cannot be invented");
            check(/confirm|check|team|not.{0,25}price|कन्फर्म|टीम/i.test(response.suggestedReply), "Unknown price needs an explicit team-confirmation deferral");
          }
          if (index === 4) {if (!finalPilot) check(company.leadTime.test(response.suggestedReply), "General recorded lead time should be useful"); check(response.needsHumanReview, "Complaint or delivery guarantee requires review"); check(!/(?:guarantee|confirmed|will deliver).{0,30}(?:tomorrow|next.day)|(?:कल).{0,20}(?:गारंटी|पक्का)/i.test(response.suggestedReply.replace(/(?:cannot|can't|not|no|नहीं).{0,45}/gi, "")), "Cannot promise tomorrow delivery");}
          results.push({name: scenario, question: questions[index], status: errors.length ? "FAIL" : "PASS", errors, latencyMs: Date.now()-started, response}); writeResults();
          console.log(`${errors.length ? "FAIL" : "PASS"} ${scenario}${errors.length ? `: ${errors.join("; ")}` : ""}`);
          await repos.reply.create({workspaceId: company.id, leadId: lead.id, rawText: questions[index], channel: "whatsapp"});
          // Synthetic customer transcript only; not a real or attempted send.
          await repos.outreachActivity.create({workspaceId: company.id, leadId: lead.id, channel: "whatsapp", body: response.suggestedReply, status: "sent", activityAt: new Date().toISOString()});
          if (stopped || response.llm.mode !== "real") {console.log("STOP: provider unavailable or fallback; no more paid requests"); break outer;}
        }
      }
    }
  } finally {globalThis.fetch = originalFetch; LLMService.prototype.runTask = originalRun; writeResults();}
  if (results.length !== expectedScenarios || results.some(row => row.status !== "PASS")) process.exitCode = 1;
}
main().catch(() => {console.error("Customer pilot stopped; inspect safe results and budget receipt. Raw errors suppressed."); process.exitCode = 1;});
