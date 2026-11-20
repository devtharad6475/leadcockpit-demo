import {test,expect} from '@playwright/test';
import {loginDemo} from './helpers/login';
import {openTabByLabel} from './helpers/nav';

test('commercial load failure is explicit and retry recovers the actual list',async({page})=>{
  await loginDemo(page);
  await page.route('**/api/orders',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,error:{code:'TEST_UNAVAILABLE',message:'Orders temporarily unavailable'}})}));
  await openTabByLabel(page,'Quotes & Orders');
  await expect(page.getByText('Orders temporarily unavailable',{exact:true})).toBeVisible();
  await expect(page.getByText('No orders yet',{exact:true})).toHaveCount(0);
  await page.screenshot({path:'docs/system-workflow/readiness-proof/commercial-load-error.png'});
  await page.unroute('**/api/orders');
  await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByRole('table',{name:'Orders',exact:true})).toBeVisible();
  await page.screenshot({path:'docs/system-workflow/readiness-proof/commercial-retry-recovered.png'});
});

test('new buyers failure is shown rather than silently disappearing',async({page})=>{
  await page.route('**/api/new-buyers/today',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,error:{code:'TEST_UNAVAILABLE',message:'Registry unavailable'}})}));
  await loginDemo(page);
  await expect(page.getByRole('alert').filter({hasText:"Today's new buyers could not be checked"})).toBeVisible();
  await page.screenshot({path:'docs/system-workflow/readiness-proof/new-buyers-error.png'});
});
