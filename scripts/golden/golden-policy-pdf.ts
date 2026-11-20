import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import { buildPolicyPdf } from '@/services/PolicyPdfService';
import type { Lead, BusinessProfile, PolicySettings } from '@/lib/types';
import { inspectPdf } from './_helpers/pdf-inspection';
const lead = { id:'pdf-lead', workspaceId:'pdf-workspace', companyName:'Acme Customer', status:'approved' } as Lead;
const profile = { companyName:'Example Company' } as BusinessProfile;
const policies = {} as PolicySettings;
async function main() {
  const base = await buildPolicyPdf({title:'Customer Policy Summary',lead,profile,policies});
  const inspected = await inspectPdf(base);
  assert(base.subarray(0,8).toString().startsWith('%PDF-1.4'));
  assert(inspected.pages.length >= 1);
  console.log('PASS A: generated PDF opens and exposes actual pages');
  for (const sentence of ['Delivery terms should be confirmed before sharing.','Cancellation terms should be confirmed before sharing.','Sample terms should be confirmed before sharing.']) assert(inspected.text.includes(sentence), sentence);
  console.log('PASS B: missing policy guardrail clauses remain readable');
  const clause = 'Bulk orders above 500 kg receive a 5 percent volume discount, applied at invoice.';
  const custom = await inspectPdf(await buildPolicyPdf({title:'Customer Policy Summary',lead,profile,policies,customClauses:clause}));
  assert(custom.text.includes(clause));
  console.log('PASS C: negotiated custom clause survives document generation');
  const token = 'SKU' + 'W'.repeat(250);
  const long = await inspectPdf(await buildPolicyPdf({title:'W'.repeat(110),lead,profile,policies,customClauses:token+'\n'+Array.from({length:120},(_,i)=>`Policy clause ${i+1}: Please ask the owner before promising credit or delivery dates.`).join('\n')+'\nFINAL CLAUSE PRESERVED'}));
  assert(long.pages.length >= 3);
  assert(long.text.replace(/\s/g,'').includes(token));
  assert(long.text.includes('FINAL CLAUSE PRESERVED'));
  for (const page of long.pages) for (const item of page.items.filter(item=>item.text.trim())) {
    assert(item.x >= 47.8 && item.x + item.width <= 547.6, `horizontal overflow: ${JSON.stringify(item)}`);
    assert(item.y >= 47.8 && item.y + item.height <= 794.3, `vertical overflow: ${JSON.stringify(item)}`);
  }
  console.log('PASS D: long tokens, wide headings and multipage clauses fit actual page margins');
  console.log('policy-pdf: 4 passed, 0 failed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
