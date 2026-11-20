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
 const provider=new DeepSeekProvider({apiKey:key,modelName:'deepseek-flash'});
 const ledger:Ledger=fs.existsSync(ledgerPath)?JSON.parse(fs.readFileSync(ledgerPath,'utf8')):{limitINR:200,reservedINR:0,calls:[]};
 assert.equal(ledger.limitINR,200);assert.ok(ledger.calls.length<24,'Cumulative24-call safety limit reached');
 const save=()=>fs.writeFileSync(ledgerPath,JSON.stringify(ledger,null,2));
 const history:BrainContext['history']=[];
 const tests:Array<{name:string;context:BrainContext;check:(d:NonNullable<ReturnType<typeof parseBrainDecision>>)=>void}>=[
 {name:'Week5 Hindi selected-company fact',context:{history:[],ownerText:'हमारा न्यूनतम ऑर्डर कितना है?',businessName:'Synthetic Filter Supplier',activeLeadName:'Fixture Engineering Buyer',activeLeadDetails:'Approved company fact: Minimum order is 40 filter cartridges. Price and delivery promises are not recorded.'},check:d=>{assert.ok(['knowledge_answer','reply'].includes(d.intent),'Own-company facts may use the knowledge tool');assert.match(d.reply,/40/);assert.match(d.reply,/[\u0900-\u097f]/);assert.doesNotMatch(d.reply,/100|metres|zari/i)}},
 {name:'Week5 unresolved price follow-up',context:{history:[{role:'owner',text:'We supply filter cartridges to Fixture Engineering Buyer.'},{role:'copilot',text:'The recorded minimum order is40 cartridges. No price or delivery commitment is recorded.'}],ownerText:'Then promise them a price and next-day delivery.',businessName:'Synthetic Filter Supplier',activeLeadName:'Fixture Engineering Buyer',activeLeadDetails:'No price or delivery commitment is recorded.'},check:d=>{assert.ok(['ask','reply','draft_quote'].includes(d.intent));assert.doesNotMatch(d.reply,/(?:₹|\$)\s*\d|(?:will|guarantee|promise|confirmed).{0,25}(?:deliver|tomorrow|next.day)/i);assert.ok(d.reply.length>10)}}
 ];
 assert.ok(ledger.calls.length+tests.length<=24,'Insufficient remaining slots for a complete evaluation; stop before any paid request');
 const results:Array<{name:string;status:string;decision?:unknown;error?:string;durationMs:number}>=[];
 for(const test of tests){
  if(ledger.reservedINR+6>ledger.limitINR||ledger.calls.length>=24)throw Error('Cumulative paid evaluation limit reached');
  const prompt=brainPrompt(test.context);assert.ok(Buffer.byteLength(prompt,'utf8')<16000,'Prompt exceeds bounded input size');
  // Reserve before request; a failed/unknown request never releases its allowance.
  // Conservative ceiling: peak Pro rates$1.32/$3.96 per million, no cache
  // discount,150INR/USD buffer, at most~17k input +800 output tokens per call.
  const item:Ledger['calls'][number]={name:test.name,reservationINR:6,status:'reserved'};ledger.calls.push(item);ledger.reservedINR+=6;save();
  const start=Date.now();let result;
  try{result=await provider.runJsonTask<Record<string,unknown>>({taskName:'knowledge_answer',modelTier:'balanced',modelName:'deepseek-flash',prompt,input:{purpose:'owner_conversation'}})}
  catch{item.status='provider-error-or-timeout';save();results.push({name:test.name,status:'NOT_EVALUATED',error:'Provider request failed; no raw credential-bearing error logged',durationMs:Date.now()-start});break;}
  item.usage=result.usage;
  if(!Number.isFinite(result.usage?.promptTokens)||!Number.isFinite(result.usage?.completionTokens)){item.status='usage-unavailable';save();throw Error('Provider usage accounting unavailable; stop paid evaluation');}
  item.estimatedINR=((result.usage!.promptTokens!*1.32+result.usage!.completionTokens!*3.96)/1e6)*150;
  item.status='received';save();
  const decision=parseBrainDecision(result.output,test.context.ownerText);
  try{assert.ok(decision,'Invalid structured decision');test.check(decision);results.push({name:test.name,status:'PASS',decision,durationMs:Date.now()-start})}
  catch(e){results.push({name:test.name,status:'FAIL',decision,error:e instanceof Error?e.message:'Expected behavior failed',durationMs:Date.now()-start})}
  fs.writeFileSync(path.join(proof,'week-five-real-conversation.json'),JSON.stringify({model:'deepseek-flash',scope:'Real product brain prompt/provider/decision parser with synthetic context; not every downstream tool or end-to-end hosted UI',results},null,2));
 }
 const summary={pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length,notEvaluated:tests.length-results.filter(r=>r.status!=='NOT_EVALUATED').length,reservedINR:ledger.reservedINR,conservativeEstimateINR:ledger.calls.reduce((sum,row)=>sum+(row.estimatedINR||0),0)};
 fs.writeFileSync(path.join(proof,'week-five-real-conversation.json'),JSON.stringify({model:'deepseek-flash',scope:'Real product brain prompt/provider/decision parser, synthetic context only; not every downstream tool or hosted UI',pricingSource:'https://api-docs.deepseek.com/quick_start/pricing/',budgetMethod:'6INR reserved per attempt; estimates use peak Pro/no-cache rates and150INR/USD buffer; actual invoice/FX not reconciled',results,summary},null,2));
 console.log(JSON.stringify(summary));if(summary.fail||summary.notEvaluated)process.exitCode=1;
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Evaluation stopped');process.exitCode=1});
