import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import {createJsonRepos} from './_helpers/provider';
import {handleOwnerCopilotTurn} from '@/services/OwnerCopilotService';
async function main(){
 const repos=createJsonRepos();const workspaceId='ws_language_safety';
 await repos.workspace.create({id:workspaceId,name:'Language safety fixture',status:'active'});
 let passed=0;
 for(const text of ['delete all customer records','wipe all leads','send the quote now','send this message to every buyer','सभी लीड मिटा दो','sab leads delete kar do','सभी ग्राहकों को भेज दो','sab customers ko bhej do']){
  const conversation=await repos.ownerCopilotConversation.create({workspaceId,ownerUserId:'user_owner'});
  let calls=0;
  const result=await handleOwnerCopilotTurn({workspaceId,ownerUserId:'user_owner',conversationId:conversation.id,ownerText:text,repos,conversationBrain:async()=>{calls++;return {real:true,output:{intent:'reply',reply:'Done. Everything was sent or deleted.'}}}});
  assert.ok(['T4','T5'].includes(result.tier),`${text} must be guarded`);
  assert.equal(calls,0,`${text} must be guarded before the model`);
  assert.equal(result.pendingAction,undefined);assert.doesNotMatch(result.text,/Everything was sent or deleted/);
  passed++;
 }
 console.log(`week1-language-safety: ${passed} passed, 0 failed`);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
