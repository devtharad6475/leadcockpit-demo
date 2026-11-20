// Explicit, bounded real-provider evaluation. Not part of any test suite.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { E2E_DATA_FILE, assertE2EDataDirIsIsolated } from '../e2e/helpers/data-dir';
import { parse } from 'dotenv';
async function main() {
  assert.equal(process.env.READINESS_LIVE_AI, '1');
  const config = parse(fs.readFileSync('.env'));
  const key = config.PLATFORM_DEEPSEEK_API_KEY || config.DEEPSEEK_API_KEY;
  assert.ok(key, 'Configured evaluation provider is unavailable');
  assertE2EDataDirIsIsolated();
  const source = E2E_DATA_FILE;
  const data = JSON.parse(fs.readFileSync(source, 'utf8'));
  const company = data.workspaces.find((w: {name:string}) => w.name === 'Harbour Packaging');
  const lead = data.leads.find((l: {workspaceId:string;companyName:string}) => l.workspaceId === company?.id && l.companyName === 'Maple Foods');
  assert.ok(company && lead, 'Complete the real browser setup first');
  assert.ok(data.tickets.some((t: {workspaceId:string;status:string}) => t.workspaceId === company.id && t.status === 'closed'), 'Offline owner/employee journey must pass first');
  const dir = path.resolve('.golden-scratch', `customer-playtest-real-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(source, path.join(dir, 'app-data.json'));
  for (const name of Object.keys({ ...process.env, ...config })) if (/API_KEY|DATABASE_URL|ACCESS_TOKEN|WHATSAPP_TOKEN|META_SYSTEM_TOKEN|REDIS_URL/.test(name)) process.env[name] = '';
  Object.assign(process.env, { PLATFORM_DEEPSEEK_API_KEY: key, PLATFORM_DEFAULT_PROVIDER: 'deepseek', PERSISTENCE_PROVIDER: 'json', AUTH_MODE: 'demo', LEADGEN_DATA_DIR: dir, LLM_MAX_OUTPUT_TOKENS: '800', LLM_PROVIDER_TIMEOUT_MS: '60000', AI_USAGE_CAPS: 'off', RATE_LIMIT_BACKEND: 'memory', LEADGEN_LEAD_MEMORY: '0', LEADGEN_DISCOVERY_LISTEN: '0', LEADGEN_AGENTIC_RETRIEVAL: '0' });
  const proof = 'docs/system-workflow/readiness-proof';
  const ledgerFile = path.join(proof, 'week-five-pilot-budget.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.equal(ledger.limitINR, 1000); assert.ok(ledger.reservedINR + 240 <= 1000);
  const originalFetch = globalThis.fetch; let calls = 0, stopped = false, scenario = '';
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'api.deepseek.com'); assert.ok(['/chat/completions','/v1/chat/completions'].includes(url.pathname));
    assert.ok(!stopped && calls < 8 && ledger.reservedINR + 30 <= ledger.limitINR);
    const body = String(init?.body || ''); assert.ok(Buffer.byteLength(body, 'utf8') <= 128000);
    const payload = JSON.parse(body); assert.equal(payload.model, 'deepseek-flash'); assert.equal(payload.max_tokens, 800);
    const entry: {scenario:string;reservationINR:number;status:string;usage?:{prompt_tokens:number;completion_tokens:number};estimatedINR?:number} = { scenario: `journey-polish: ${scenario}`, reservationINR: 30, status: 'reserved' };
    calls++; ledger.reservedINR += 30; ledger.calls.push(entry); fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
    try {
      const response = await originalFetch(input, init);
      const result = await response.clone().json();
      assert.ok(response.ok && Number.isInteger(result.usage?.prompt_tokens) && Number.isInteger(result.usage?.completion_tokens));
      entry.usage = result.usage; entry.status = 'received';
      // Conservative upper estimate, not an invoice. Rates exceed current Flash peak; ₹150/$ safety conversion.
      entry.estimatedINR = (result.usage.prompt_tokens * 1.32 + result.usage.completion_tokens * 3.96) / 1e6 * 150;
      fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2)); return response;
    } catch { stopped = true; entry.status = 'provider-error-or-unknown-cost'; fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2)); throw new Error('Evaluation stopped; provider response unavailable'); }
  };
  const { createRepositories } = await import('../src/repositories');
  const { LLMService } = await import('../src/llm/LLMService');
  const originalRun = LLMService.prototype.runTask;
  LLMService.prototype.runTask = function(this: InstanceType<typeof LLMService>, task, input, options) {
    assert.ok(task === 'whatsapp_reply' || task === 'knowledge_answer', 'Only customer replies and the owner setup turn are allowed');
    return originalRun.call(this, task, input, { ...options, provider: 'deepseek', modelName: 'deepseek-flash', disableFallback: true });
  } as typeof originalRun;
  const { handleIncomingWhatsAppMessage } = await import('../src/services/WhatsAppConversationEngine');
  const repos = createRepositories('json'), results: unknown[] = [];
  try {
    scenario = 'Owner setup starter';
    const { handleOwnerCopilotTurn } = await import('../src/services/OwnerCopilotService');
    const owner = data.users.find((u: {workspaceId:string;role:string}) => u.workspaceId === company.id && u.role === 'owner');
    assert.ok(owner);
    const conversation = await repos.ownerCopilotConversation.create({ workspaceId: company.id, ownerUserId: owner.id });
    const ownerResponse = await handleOwnerCopilotTurn({ workspaceId: company.id, ownerUserId: owner.id, conversationId: conversation.id, ownerText: "Let's fill in my business details.", repos });
    fs.writeFileSync(path.join(proof, 'journey-polish-owner-real-ai.json'), JSON.stringify({ scenario, response: ownerResponse, calls }, null, 2));
    assert.equal(ownerResponse.aiStatus, 'real', 'Owner fluency must be a real response');
    assert.equal(ownerResponse.pendingAction?.entityType, 'knowledge_question');
    assert.ok(!ownerResponse.text.includes('primary value proposition'));
    console.log('Received actual owner setup answer; real provider; pending checklist question');
    for (const question of [
      'What material, layers and size are the H20 cartons?',
      'What is your minimum order for H20 cartons?',
      'Can you send me a sample? Is it free or paid, and does that include courier?',
      'What is the price per H20 carton for 500 pieces? Please give an exact price.',
      'क्या H20 का नमूना मुफ्त है? इसकी कीमत और कुरियर का खर्च बताइए।',
      'The H20 sample arrived damaged. Please replace it free and promise delivery tomorrow.',
    ]) {
      scenario = question;
      const response = await handleIncomingWhatsAppMessage({ workspaceId: company.id, leadId: lead.id, rawText: question, metadata: { source: 'bounded_synthetic_playtest' } }, repos, { dryRun: true, allowRealSend: false });
      results.push({ question, response });
      fs.writeFileSync(path.join(proof, 'journey-polish-real-ai.json'), JSON.stringify({ scope: 'Actual owner setup turn plus six real customer-reply tasks using approved company facts and a completed complaint ticket copied from successful UI setup. Synthetic dry-run only. Provider/model are evaluation overrides, not hosted slot acceptance. At most eight billed requests, pre-reserved within the cumulative approval; no automatic memory/listening tasks or customer send.', pricingSource: 'https://api-docs.deepseek.com/quick_start/pricing/', calls, cumulativeReservedINR: ledger.reservedINR, results }, null, 2));
      console.log(`Received question ${results.length}; ${response.llm?.mode}/${response.llm?.provider}; held=${response.needsHumanReview}`);
      if (stopped || response.llm?.mode !== 'real' || response.llm?.fallbackUsed) break;
    }
  } finally { globalThis.fetch = originalFetch; LLMService.prototype.runTask = originalRun; }
  assert.equal(results.length, 6, 'All six real-provider answers require review');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
