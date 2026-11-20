import {test,expect} from '@playwright/test';
import {loginDemo} from './helpers/login';
import {restoreDemoData,waitForServerQuiescent} from './helpers/demo-data-snapshot';
test.beforeEach(async()=>{restoreDemoData();await waitForServerQuiescent();});
async function open(page:import('@playwright/test').Page){await loginDemo(page);await page.getByRole('button',{name:'Assistant',exact:true}).click();await expect(page.getByRole('textbox',{name:'Message your assistant'})).toBeEnabled({timeout:20000});}

test('restores the conversation customer and retains safe refusal after refresh',async({page,request})=>{
 const leads=await (await request.get('/api/leads',{headers:{cookie:'lc_demo=1'}})).json();
 const lead=leads[0];expect(lead.id).toBeTruthy();
 const convo=await (await request.post('/api/copilot/conversations',{headers:{cookie:'lc_demo=1'},data:{leadId:lead.id}})).json();
 const initial=await request.post('/api/copilot/message',{headers:{cookie:'lc_demo=1'},data:{conversationId:convo.id,text:'delete all leads',leadId:lead.id}});expect(initial.ok()).toBe(true);const response=await initial.json();expect(response.response.tier).toBe('T5');expect(response.response.intent).toBe('delete_blocked');
 await open(page);await expect(page.getByText(lead.companyName,{exact:true}).last()).toBeVisible();
 await expect(page.getByRole('region',{name:'Conversation',exact:true}).getByText('delete all leads',{exact:true})).toBeVisible();
 await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'Assistant',exact:true}).click();await expect(page.getByRole('textbox',{name:'Message your assistant'})).toBeEnabled({timeout:20000});
 await expect(page.getByRole('region',{name:'Conversation',exact:true}).getByText('delete all leads',{exact:true})).toBeVisible();
 await expect(page.getByText(lead.companyName,{exact:true}).last()).toBeVisible();
 await page.screenshot({path:'docs/system-workflow/readiness-proof/week1-assistant-restored.png'});
});

test('an interrupted save never promises that nothing changed',async({page})=>{
 await open(page);
 await page.route('**/api/copilot/message',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,error:{code:'TEST_INTERRUPTED',message:'The response was interrupted'}})}));
 await page.getByRole('textbox',{name:'Message your assistant'}).fill('Please record my business detail');await page.getByRole('button',{name:'Send',exact:true}).click();
 await expect(page.getByText(/The response was interrupted/)).toBeVisible();
 await expect(page.getByText(/could not confirm what was saved/i)).toBeVisible();
 await expect(page.getByText(/Something went wrong:.*The response was interrupted/)).not.toContainText('Nothing was changed');
 await page.screenshot({path:'docs/system-workflow/readiness-proof/week1-assistant-error.png'});
});

test('late confirmed result cannot appear in a newly selected conversation',async({page,request})=>{
 const headers={cookie:'lc_demo=1'};
 const convo=await (await request.post('/api/copilot/conversations',{headers,data:{}})).json();
 await request.post('/api/copilot/message',{headers,data:{conversationId:convo.id,text:'delete all leads'}});
 const proposal={id:'synthetic-proposal',role:'copilot',kind:'copilot_confirm',text:'Confirm this synthetic plan',tier:'T3',pendingAction:{intent:'icp_generation',entityId:'synthetic-action',entityType:'icp'},createdAt:new Date().toISOString()};
 await page.route('**/api/copilot/conversations/'+convo.id+'/messages',route=>route.fulfill({contentType:'application/json',body:JSON.stringify([proposal])}));
 let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve});
 await page.route('**/api/copilot/confirm',async route=>{await gate;await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,response:{text:'Late result belongs to the old thread',kind:'copilot_action_done',tier:'T3',intent:'icp_generation'}})});});
 await open(page);await page.getByRole('button',{name:'Yes, run it',exact:true}).click();
 await page.getByRole('button',{name:'New conversation',exact:true}).click();await expect(page.getByRole('heading',{name:'What should we work on?'})).toBeVisible();
 const finished=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/copilot/confirm');
 release();await finished;
 // Ensure the delayed request finished before the negative assertion is accepted.
 await expect(page.getByText('Late result belongs to the old thread',{exact:true})).toHaveCount(0);
});
