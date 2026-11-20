// Explicit paid evaluation only. Never invoked by golden/Playwright suites.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {parse} from 'dotenv';
import {brainPrompt,parseBrainDecision,type BrainContext} from '@/services/OwnerConversationBrain';
import {DeepSeekProvider} from '@/llm/providers/DeepSeekProvider';

const proof=path.resolve('docs/system-workflow/readiness-proof');
const ledgerPath=path.join(proof,'week1-ai-budget.json');
type Ledger={limitINR:number;reservedINR:number;calls:Array<{name:string;reservationINR:number;status:string;usage?:unknown;estimatedINR?:number}>};
async function main(){
 assert.equal(process.env.READINESS_LIVE_AI,'1','Explicit live evaluation flag required');
 const config=parse(fs.readFileSync('.env'));
 const key=config.PLATFORM_DEEPSEEK_API_KEY||config.DEEPSEEK_API_KEY;
 assert.ok(key,'No configured DeepSeek key');
 process.env.LLM_MAX_OUTPUT_TOKENS='800';process.env.LLM_PROVIDER_TIMEOUT_MS='60000';
 const provider=new DeepSeekProvider({apiKey:key,modelName:'deepseek-chat'});
 const ledger:Ledger=fs.existsSync(ledgerPath)?JSON.parse(fs.readFileSync(ledgerPath,'utf8')):{limitINR:200,reservedINR:0,calls:[]};
 assert.equal(ledger.limitINR,200);assert.ok(ledger.calls.length<20,'Cumulative20-call safety limit reached');
 const save=()=>fs.writeFileSync(ledgerPath,JSON.stringify(ledger,null,2));
 const history:BrainContext['history']=[];
 const tests:Array<{name:string;context:BrainContext;check:(d:NonNullable<ReturnType<typeof parseBrainDecision>>)=>void}>=[
  {name:'friendly greeting',context:{history,ownerText:'Hello. What can you help me with?'},check:d=>{assert.equal(d.intent,'reply');assert.ok(d.reply.length>15)}},
  {name:'Hindi greeting',context:{history,ownerText:'नमस्ते, आप मेरी किस तरह मदद कर सकते हैं?'},check:d=>{assert.equal(d.intent,'reply');assert.match(d.reply,/[\u0900-\u097f]/)}},
  {name:'vague answer needs clarification',context:{history,ownerText:'It depends.',pendingSetupQuestion:'What is your minimum order quantity?',openSetupQuestions:[{ref:'q1',question:'What is your minimum order quantity?'}],nextSetupQuestion:'What products do you sell?',setupProgress:'2 details still missing'},check:d=>{assert.equal(d.intent,'ask');assert.ok(d.reply.length>5)}},
  {name:'exact owner answer identifies the pending question',context:{history,ownerText:'Our minimum order is 50 kg.',pendingSetupQuestion:'What is your minimum order quantity?',openSetupQuestions:[{ref:'q1',question:'What is your minimum order quantity?'}],nextSetupQuestion:'What products do you sell?',setupProgress:'2 details still missing'},check:d=>{assert.equal(d.intent,'record_answer');assert.equal(d.answers,'q1');assert.match(d.answerText,/50\s*kg/i)}},
  {name:'customer context uses recorded facts',context:{history,ownerText:'What do we know about this customer?',businessName:'Synthetic Supplier',activeLeadName:'Context Alpha',activeLeadDetails:'Company: Context Alpha\nLast order:2 sample bags\nDelivery promise: not recorded'},check:d=>{assert.equal(d.intent,'reply');assert.match(d.reply,/Alpha|2/);assert.match(d.reply,/not|missing|record|know/i);assert.doesNotMatch(d.reply,/no contact details|no.*notes or conversation history|(?:notes|history).{0,30}(?:not saved|not recorded)/i,'Omitted fields are unknown, not proof of absent records')}},
  {name:'follow-up resolves customer names',context:{history:[{role:'owner',text:'The approved leads are Context Alpha and Context Beta.'},{role:'copilot',text:'I can prepare first-message drafts for those two.'}],ownerText:'Draft those two first messages.'},check:d=>{assert.equal(d.intent,'draft_first_message');assert.match(d.request,/Context Alpha/);assert.match(d.request,/Context Beta/)}},
  {name:'missing price does not become invented quote',context:{history,ownerText:'Make a quote for a customer, but I do not have the product, quantity or price yet.'},check:d=>{assert.ok(['ask','draft_quote'].includes(d.intent));assert.doesNotMatch(d.reply,/₹\s*\d|\$\s*\d/)}},
  {name:'explanation keeps a pending answer proposal conversational',context:{history:[{role:'copilot',text:'This answers the delivery question instead. Shall I save it there?'}],ownerText:'What do you mean?',awaitingConfirmation:{question:'What is the delivery time?',answer:'7 days'},pendingSetupQuestion:'What is your minimum order quantity?',setupProgress:'2 details still missing'},check:d=>{assert.ok(['reply','ask'].includes(d.intent));assert.ok(d.reply.length>10)}},
 ];
 assert.ok(ledger.calls.length+tests.length<=20,'Insufficient remaining slots for a complete evaluation; stop before any paid request');
 const results:Array<{name:string;status:string;decision?:unknown;error?:string;durationMs:number}>=[];
 for(const test of tests){
  if(ledger.reservedINR+6>ledger.limitINR||ledger.calls.length>=20)throw Error('Cumulative paid evaluation limit reached');
  const prompt=brainPrompt(test.context);assert.ok(Buffer.byteLength(prompt,'utf8')<16000,'Prompt exceeds bounded input size');
  // Reserve before request; a failed/unknown request never releases its allowance.
  // Conservative ceiling: peak Pro rates$1.32/$3.96 per million, no cache
  // discount,150INR/USD buffer, at most~17k input +800 output tokens per call.
  const item:Ledger['calls'][number]={name:test.name,reservationINR:6,status:'reserved'};ledger.calls.push(item);ledger.reservedINR+=6;save();
  const start=Date.now();let result;
  try{result=await provider.runJsonTask<Record<string,unknown>>({taskName:'knowledge_answer',modelTier:'balanced',modelName:'deepseek-chat',prompt,input:{purpose:'owner_conversation'}})}
  catch{item.status='provider-error-or-timeout';save();results.push({name:test.name,status:'NOT_EVALUATED',error:'Provider request failed; no raw credential-bearing error logged',durationMs:Date.now()-start});break;}
  item.usage=result.usage;
  if(!Number.isFinite(result.usage?.promptTokens)||!Number.isFinite(result.usage?.completionTokens)){item.status='usage-unavailable';save();throw Error('Provider usage accounting unavailable; stop paid evaluation');}
  item.estimatedINR=((result.usage!.promptTokens!*1.32+result.usage!.completionTokens!*3.96)/1e6)*150;
  item.status='received';save();
  const decision=parseBrainDecision(result.output,test.context.ownerText);
  try{assert.ok(decision,'Invalid structured decision');test.check(decision);results.push({name:test.name,status:'PASS',decision,durationMs:Date.now()-start})}
  catch(e){results.push({name:test.name,status:'FAIL',decision,error:e instanceof Error?e.message:'Expected behavior failed',durationMs:Date.now()-start})}
  fs.writeFileSync(path.join(proof,'week1-real-conversation.json'),JSON.stringify({model:'deepseek-chat',scope:'Real product brain prompt/provider/decision parser with synthetic context; not every downstream tool or end-to-end hosted UI',results},null,2));
 }
 const summary={pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length,notEvaluated:tests.length-results.filter(r=>r.status!=='NOT_EVALUATED').length,reservedINR:ledger.reservedINR,conservativeEstimateINR:ledger.calls.reduce((sum,row)=>sum+(row.estimatedINR||0),0)};
 fs.writeFileSync(path.join(proof,'week1-real-conversation.json'),JSON.stringify({model:'deepseek-chat',scope:'Real product brain prompt/provider/decision parser, synthetic context only; not every downstream tool or hosted UI',pricingSource:'https://api-docs.deepseek.com/quick_start/pricing/',budgetMethod:'6INR reserved per attempt; estimates use peak Pro/no-cache rates and150INR/USD buffer; actual invoice/FX not reconciled',results,summary},null,2));
 console.log(JSON.stringify(summary));if(summary.fail||summary.notEvaluated)process.exitCode=1;
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Evaluation stopped');process.exitCode=1});
