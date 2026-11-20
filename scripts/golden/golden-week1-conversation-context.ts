import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {GET,POST} from '@/app/api/[[...path]]/route';
import {repositories as repos} from '@/repositories';
process.env.AUTH_MODE='demo';
const workspaceId='workspace_demo';
async function get(query:string){return GET(new NextRequest('http://localhost:3215/api/copilot/conversations'+query,{headers:{cookie:'lc_demo=1'}}),{params:Promise.resolve({path:['copilot','conversations']})});}
async function post(path:string,body:object){return POST(new NextRequest('http://localhost:3215/api/copilot/'+path,{method:'POST',headers:{cookie:'lc_demo=1','content-type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({path:['copilot',path]})});}
async function main(){
 const a=await repos.lead.createLead({workspaceId,companyName:'Context Alpha',id:'week1_alpha'});
 const b=await repos.lead.createLead({workspaceId,companyName:'Context Beta',id:'week1_beta'});
 const first=await repos.ownerCopilotConversation.create({workspaceId,ownerUserId:'user_owner',activeLeadId:a.id});
 await repos.ownerCopilotMessage.create({workspaceId,conversationId:first.id,role:'owner',text:'About Context Alpha',kind:'owner_input',language:'en'});
 const opened=await get('?leadId='+b.id);assert.equal(opened.status,200);const second=await opened.json();
 assert.notEqual(second.id,first.id,'Choosing another customer must not rewrite an existing chat context');
 assert.equal((await repos.ownerCopilotConversation.getById(workspaceId,first.id))?.activeLeadId,a.id);console.log('PASS customer switch keeps original conversation/customer');
 const restored=await (await get('?id='+first.id)).json();assert.equal(restored.activeLeadName,'Context Alpha');console.log('PASS restored conversation exposes scoped customer name');
 const conflict=await post('message',{conversationId:first.id,text:'What do we know about this customer?',leadId:b.id});assert.equal(conflict.status,409);console.log('PASS request cannot mix another customer with existing history');
 const invalid=await post('conversations',{leadId:'outside-this-workspace'});assert.equal(invalid.status,404);console.log('PASS new conversation refuses absent/cross-company customer');
 const foreign=await repos.ownerCopilotConversation.create({workspaceId,ownerUserId:'other-owner'});
 const denied=await post('confirm',{conversationId:foreign.id,intent:'icp_generation',pendingActionId:'fake'});assert.equal(denied.status,404);console.log('PASS confirmation API enforces conversation ownership');
 const capture=await post('message',{conversationId:first.id,text:'draft quote',quoteCapture:{leadId:b.id,productName:'Sample',quantity:2,unit:'kg',unitPrice:50,currencyCode:'INR'}});assert.equal(capture.status,409);console.log('PASS quote capture cannot override the stored customer');
 const noFact=await post('save-fact',{conversationId:foreign.id,questionText:'Forged fact'});assert.equal(noFact.status,404);console.log('PASS missing-detail capture enforces conversation ownership');
 const genuineFact=await post('save-fact',{conversationId:first.id,questionText:'What is our credit policy?'});assert.equal(genuineFact.status,200);console.log('PASS legitimate missing-detail capture uses the conversation owner');
 console.log('week1-conversation-context: 8 passed, 0 failed');
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
