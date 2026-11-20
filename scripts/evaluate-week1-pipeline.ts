// Deliberate paid evaluation: full service/router/runtime, synthetic isolated data.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {parse} from 'dotenv';

async function main(){
 assert.equal(process.env.READINESS_LIVE_AI,'1');
 const config=parse(fs.readFileSync('.env'));
 const key=config.PLATFORM_DEEPSEEK_API_KEY||config.DEEPSEEK_API_KEY;
 assert.ok(key,'DeepSeek key missing');
 for(const name of Object.keys({...process.env,...config})){
  if(/API_KEY|DATABASE_URL|ACCESS_TOKEN|WHATSAPP_TOKEN|META_SYSTEM_TOKEN|REDIS_URL/.test(name))process.env[name]='';
 }
 process.env.PLATFORM_DEEPSEEK_API_KEY=key;
 process.env.PLATFORM_DEFAULT_PROVIDER='deepseek';
 process.env.PERSISTENCE_PROVIDER='json';process.env.AUTH_MODE='demo';
 process.env.LEADGEN_DATA_DIR=path.resolve('.golden-scratch',`week1-paid-pipeline-${Date.now()}`);
 process.env.LLM_MAX_OUTPUT_TOKENS='800';process.env.LLM_PROVIDER_TIMEOUT_MS='60000';
 process.env.AI_USAGE_CAPS='off';process.env.RATE_LIMIT_BACKEND='memory';
 const proof=path.resolve('docs/system-workflow/readiness-proof');
 const ledgerPath=path.join(proof,'week1-ai-budget.json');
 const ledger=JSON.parse(fs.readFileSync(ledgerPath,'utf8'));
 assert.equal(ledger.limitINR,200);
 const draftRecheck=process.env.READINESS_PIPELINE_DRAFT_RECHECK==='1';
 // Two additional requests solely to verify repaired KB grounding; owner budget remains200.
 const maxCalls=draftRecheck?22:20;const requiredCalls=draftRecheck?2:4;
 const artifact=path.join(proof,draftRecheck?'week1-full-pipeline-draft-recheck.json':'week1-full-pipeline.json');
 assert.ok(ledger.calls.length+requiredCalls<=maxCalls,'Cumulative call slots required');
 assert.ok(ledger.reservedINR+requiredCalls*15<=200,'15INR reservations required');
 const originalFetch=globalThis.fetch;
 let scenario='';let accountingFailed=false;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
  assert.equal(url.hostname,'api.deepseek.com','Only authorized provider network requests allowed');
  assert.ok(['/chat/completions','/v1/chat/completions'].includes(url.pathname));
  assert.ok(!accountingFailed,'Accounting unavailable; paid requests stopped');
  const body=String(init?.body||'');
  assert.ok(Buffer.byteLength(body,'utf8')<=64000,'Full request exceeds conservative input ceiling');
  assert.equal(JSON.parse(body).max_tokens,800);
  assert.equal(JSON.parse(body).model,'deepseek-chat');
  assert.ok(ledger.calls.length<maxCalls&&ledger.reservedINR+15<=200,'Cumulative budget exhausted');
  const item={name:`full pipeline: ${scenario}`,reservationINR:15,status:'reserved',usage:undefined as unknown,estimatedINR:undefined as number|undefined};
  ledger.calls.push(item);ledger.reservedINR+=15;
  fs.writeFileSync(ledgerPath,JSON.stringify(ledger,null,2));
  // 64k UTF8 bytes +800 output conservatively costs <15INR at peak Pro
  // 1.32/3.96 USD per million and150INR/USD buffer. Reservation retained on errors.
  try{
   const response=await originalFetch(input,init);
   const payload=await response.clone().json() as {usage?:{prompt_tokens:number;completion_tokens:number}};
   if(!Number.isFinite(payload.usage?.prompt_tokens)||!Number.isFinite(payload.usage?.completion_tokens)){
    accountingFailed=true;item.status='usage-unavailable';
   }else{
    item.usage=payload.usage;item.status='received';
    item.estimatedINR=(payload.usage!.prompt_tokens*1.32+payload.usage!.completion_tokens*3.96)/1e6*150;
   }
   fs.writeFileSync(ledgerPath,JSON.stringify(ledger,null,2));return response;
  }catch{item.status='provider-error';accountingFailed=true;fs.writeFileSync(ledgerPath,JSON.stringify(ledger,null,2));throw Error('Provider evaluation failed; raw error suppressed');}
 };
 try{
  const {createJsonRepos}=await import('./golden/_helpers/provider');
  const {handleOwnerCopilotTurn}=await import('@/services/OwnerCopilotService');
  const repos=createJsonRepos();const workspaceId='ws_paid_week1';
  await repos.workspace.create({id:workspaceId,name:'Synthetic Loom Supplier',status:'active'});
  await repos.businessProfile.create({workspaceId,companyName:'Synthetic Loom Supplier',products:['cotton yarn'],checklistKinds:['trader'],checklistExports:false,checklistConfirmedAt:new Date().toISOString()});
  const doc=await repos.knowledgeBaseDocument.create(workspaceId,{title:'Owner approved pilot facts',source:'manual',documentType:'company_profile',status:'active',contentText:'Our minimum order quantity (MOQ) is 100 metres. Samples are available on request.',metadata:{}});
  await repos.knowledgeBaseChunk.replaceForDocument(workspaceId,doc.id,[{chunkText:'Our minimum order quantity (MOQ) is 100 metres. Samples are available on request.',chunkIndex:0,metadata:{source:'owner_approved'}}]);
  const lead=await repos.lead.createLead({workspaceId,companyName:'Synthetic Pilot Buyer',contactName:'Pilot Buyer',status:'approved',reviewStatus:'approved',source:'manual'});
  const convo=await repos.ownerCopilotConversation.create({workspaceId,ownerUserId:'user_owner',activeLeadId:lead.id});
  const input={workspaceId,ownerUserId:'user_owner',conversationId:convo.id,leadId:lead.id,repos};
  scenario='company fact';
  const fact=draftRecheck?undefined:await handleOwnerCopilotTurn({...input,ownerText:'What is our minimum order quantity?'});
  const results:Array<{name:string;response:Awaited<ReturnType<typeof handleOwnerCopilotTurn>>}> =fact?[{name:scenario,response:fact}]:[];
  fs.writeFileSync(artifact,JSON.stringify({results},null,2));
  if(fact){assert.equal(fact.aiStatus,'real');assert.match(fact.text,/100/);assert.match(fact.text,/metre|meter/i);}
  scenario='customer draft';
  const draft=await handleOwnerCopilotTurn({...input,ownerText:'Draft a reply to this customer asking whether samples are available. Use only our approved facts.'});
  results.push({name:scenario,response:draft});
  fs.writeFileSync(artifact,JSON.stringify({results},null,2));
  assert.equal(draft.kind,'copilot_draft');assert.equal(draft.aiStatus,'real');assert.match(draft.text,/sample/i);if(draftRecheck){assert.match(draft.text,/available|provide|offer/i,'Draft must use recorded sample availability');assert.doesNotMatch(draft.text,/confirm.*(?:availability|available)/i);}
  const template=await repos.messageTemplate.getById(workspaceId,draft.pendingAction!.entityId!);
  assert.equal(template?.status,'draft');assert.equal(template?.leadId,lead.id);
  const messages=await repos.ownerCopilotMessage.listByConversation(workspaceId,convo.id);
  assert.ok((!fact||messages.some(m=>m.text===fact.text))&&messages.some(m=>m.text===draft.text));
  assert.equal(accountingFailed,false);
  fs.writeFileSync(artifact,JSON.stringify({status:'PASS',scope:'Actual OwnerCopilot turn, LLMService, AgentRuntime instructions, ModelRouter, DeepSeek, knowledge retrieval, saved conversation and draft. Synthetic JSON; browser rendering verified separately; no customer send.',results,messages,template,calls:ledger.calls.length,reservedINR:ledger.reservedINR,conservativeEstimateINR:ledger.calls.reduce((s:number,c:{estimatedINR?:number})=>s+(c.estimatedINR||0),0)},null,2));
  console.log(JSON.stringify({status:'PASS',calls:ledger.calls.length,reservedINR:ledger.reservedINR}));
 }finally{globalThis.fetch=originalFetch;}
}
main().catch(async error=>{const message=String(error?.message||'Unknown failure');console.error('Full pipeline evaluation did not pass:', /provider|api.?key|token|authorization/i.test(message)?'Provider failure details suppressed':message);process.exitCode=1;});
