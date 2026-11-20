import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import {createJsonRepos} from './_helpers/provider';
import {LLMService} from '@/llm/LLMService';
import {handleOwnerCopilotTurn} from '@/services/OwnerCopilotService';

async function main() {
 const repos=await createJsonRepos();
 const workspaceId='ws_week1_draft_honesty';
 await repos.workspace.create({id:workspaceId,name:'Synthetic Supplier',status:'active'});
 const lead=await repos.lead.createLead({workspaceId,companyName:'Synthetic Buyer',status:'approved',reviewStatus:'approved',source:'manual'});
 const conversation=await repos.ownerCopilotConversation.create({workspaceId,ownerUserId:'user_owner',activeLeadId:lead.id});
 const original=LLMService.prototype.runTask;
 try {
  for(const [name,output,status] of [
   ['empty real output',{suggestedReply:'   '},'mock'],
   ['valid real reply',{suggestedReply:'Thank you. Our team will review your request.'},'real'],
   ['empty fallback output',{},'mock'],
  ] as const) {
   LLMService.prototype.runTask=(async()=>({output,mode:name.includes('fallback')?'fallback':'real',fallbackUsed:name.includes('fallback'),provider:'deepseek'})) as unknown as typeof original;
   const result=await handleOwnerCopilotTurn({workspaceId,ownerUserId:'user_owner',conversationId:conversation.id,ownerText:'Draft a reply to this customer',leadId:lead.id,repos,conversationBrain:false});
   assert.equal(result.aiStatus,status,`${name} must report whether actual reply text exists`);
   if(status==='mock') assert.match(result.text,/mock draft/i,'placeholder must be visibly labelled');
   else assert.match(result.text,/Our team will review/);
   const draft=await repos.messageTemplate.getById(workspaceId,result.pendingAction!.entityId!);
   assert.equal(draft?.status,'draft');
   assert.equal(draft?.personalizationUsed?.aiStatus,status);
   console.log('PASS '+name);
  }
  for(const [suffix,fact] of [['alpha','Samples are available on request.'],['beta','Samples are not available.']] as const) {
   const scoped=workspaceId+'_'+suffix;
   await repos.workspace.create({id:scoped,name:'Supplier '+suffix,status:'active'});
   const doc=await repos.knowledgeBaseDocument.create(scoped,{title:'Approved sample policy',documentType:'policy',source:'manual',status:'active',contentText:fact});
   await repos.knowledgeBaseChunk.replaceForDocument(scoped,doc.id,[{chunkIndex:0,chunkText:fact,metadata:{source:'manual'}}]);
   const unverified=await repos.knowledgeBaseDocument.create(scoped,{title:'Unreviewed sample promise',documentType:'policy',source:'uploaded_document',status:'active',contentText:'Samples ship free within 1 hour.'});
   await repos.knowledgeBaseChunk.replaceForDocument(scoped,unverified.id,[{chunkIndex:0,chunkText:'Samples ship free within 1 hour.',metadata:{extractionUnverified:true}}]);
   const buyer=await repos.lead.createLead({workspaceId:scoped,companyName:'Buyer '+suffix,source:'manual',status:'approved'});
   const chat=await repos.ownerCopilotConversation.create({workspaceId:scoped,ownerUserId:'user_owner',activeLeadId:buyer.id});
   let passedContext='';
   LLMService.prototype.runTask=(async(_task:unknown,payload:{knowledgeContext?:string})=>{passedContext=payload.knowledgeContext||'';return{output:{suggestedReply:'Thank you for asking about samples.'},mode:'real',fallbackUsed:false,provider:'deepseek'};}) as unknown as typeof original;
   await handleOwnerCopilotTurn({workspaceId:scoped,ownerUserId:'user_owner',conversationId:chat.id,ownerText:'Draft a reply about samples availability',leadId:buyer.id,repos,conversationBrain:false});
   assert.ok(passedContext.includes(fact),'Draft task must receive approved sample facts from its company');
   assert.ok(!passedContext.includes('within 1 hour'),'Unreviewed extraction must not become approved draft context');
   assert.ok(!passedContext.includes(suffix==='alpha'?'Samples are not available.':'Samples are available on request.'),'Another company facts must not leak');
   console.log('PASS scoped approved draft knowledge '+suffix);
  }
 } finally {LLMService.prototype.runTask=original;}
 console.log('week1-draft-honesty: 5 passed, 0 failed');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
