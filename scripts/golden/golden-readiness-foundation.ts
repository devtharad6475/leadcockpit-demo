import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { repositories } from '@/repositories';
import { signup, PUBLIC_SIGNUP_MESSAGE, publicSignup, resendVerification, verifyEmail } from '@/services/SignupService';
import { redeemPasswordReset } from '@/services/PasswordResetService';
import { mutateData } from '@/lib/db';
import { verifyPassword } from '@/lib/password';
process.env.RESEND_API_KEY = '';
const cases: Array<[string, () => Promise<void>]> = [];
cases.push(['mock email is not reported as delivered', async () => {
  const result = await signup({email:`mock_${Date.now()}@example.com`,password:'OriginalPass123!'});
  assert.equal(result.emailSent,false);
  assert.doesNotMatch(PUBLIC_SIGNUP_MESSAGE,/we.ve sent/i);
}]);
cases.push(['reset updates password and consumes link through one atomic repository operation', async () => {
 const owner=await signup({email:`atomic_${Date.now()}@example.com`,password:'OriginalPass123!'});
 const raw='atomic-reset-test-token';
 const token=await repositories.passwordResetToken.create({userId:owner.user.id,workspaceId:owner.user.workspaceId,tokenHash:createHash('sha256').update(raw).digest('hex'),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),issuedByAdminId:'test'});
 // A separate consume call must never run; both writes use the atomic repository.
 const credential=await repositories.userCredential.findByUserId(owner.user.id);
 assert.ok(credential);
 const mark=repositories.passwordResetToken.markConsumed.bind(repositories.passwordResetToken);
 repositories.passwordResetToken.markConsumed=async()=>{throw new Error('injected consume failure')};
 try { await redeemPasswordReset({rawToken:raw,newPassword:'ReplacementPass123!'}); }
 finally {repositories.passwordResetToken.markConsumed=mark;}
 const after=await repositories.userCredential.findByUserId(owner.user.id);
 assert.ok(after);
 assert.equal(await verifyPassword('ReplacementPass123!',after.passwordHash),true,'reset must update password');
 assert.ok((await repositories.passwordResetToken.findByTokenHash(token.tokenHash))?.consumedAt);
}]);
cases.push(['missing credential rolls back token claim', async () => {
 const owner=await signup({email:`rollback_${Date.now()}@example.com`,password:'OriginalPass123!'});
 const tokenHash=createHash('sha256').update('rollback-test-token').digest('hex');
 await repositories.passwordResetToken.create({userId:owner.user.id,workspaceId:owner.user.workspaceId,tokenHash,issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),issuedByAdminId:'test'});
 await mutateData(data=>{data.userCredentials=(data.userCredentials||[]).filter(row=>row.userId!==owner.user.id)});
 await assert.rejects(()=>repositories.passwordResetToken.redeem(tokenHash,'hash'),/credential not found/);
 assert.equal((await repositories.passwordResetToken.findByTokenHash(tokenHash))?.consumedAt,undefined);
}]);
cases.push(['two concurrent reset attempts spend exactly one link', async () => {
 const owner=await signup({email:`concurrent_${Date.now()}@example.com`,password:'OriginalPass123!'});
 const raw='concurrent-reset-test-token';
 await repositories.passwordResetToken.create({userId:owner.user.id,workspaceId:owner.user.workspaceId,tokenHash:createHash('sha256').update(raw).digest('hex'),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),issuedByAdminId:'test'});
 const attempts=await Promise.allSettled([repositories.passwordResetToken.redeem(createHash('sha256').update(raw).digest('hex'),'hash-one'),repositories.passwordResetToken.redeem(createHash('sha256').update(raw).digest('hex'),'hash-two')]);
 assert.equal(attempts.filter(row=>row.status==='fulfilled'&&row.value).length,1);
 const credential=await repositories.userCredential.findByUserId(owner.user.id);
 assert.equal(credential?.sessionVersion,2); // initial version 1 + exactly one redemption
}]);
cases.push(['provider failure is honest and resend cannot report success', async () => {
 const originalFetch=globalThis.fetch;
 const originalKey=process.env.RESEND_API_KEY;
 const originalSender=process.env.TRANSACTIONAL_EMAIL_FROM;
 process.env.RESEND_API_KEY='test-only-resend-key';
 process.env.TRANSACTIONAL_EMAIL_FROM='Synthetic trial <accounts@example.com>';
 globalThis.fetch=async()=>new Response(JSON.stringify({message:'Injected offline provider outage'}),{status:503});
 try {
  const owner=await signup({email:`failedmail_${Date.now()}@example.com`,password:'OriginalPass123!'});
  assert.equal(owner.emailSent,false);
  await assert.rejects(()=>resendVerification({userId:owner.user.id}),error => Boolean(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 503));
 }finally{globalThis.fetch=originalFetch;process.env.RESEND_API_KEY=originalKey ?? ''; if(originalSender===undefined)delete process.env.TRANSACTIONAL_EMAIL_FROM;else process.env.TRANSACTIONAL_EMAIL_FROM=originalSender;}
}]);
cases.push(['taken-email notice remains mock and public message cannot leak account existence', async () => {
 const email=`taken_${Date.now()}@example.com`;
 await signup({email,password:'OriginalPass123!'});
 const again=await publicSignup({email,password:'AnotherPass123!'});
 assert.deepEqual(again,{created:false,noticeSent:false});
 assert.doesNotMatch(PUBLIC_SIGNUP_MESSAGE,/already exists|we.ve sent/i);
}]);
cases.push(['verification failure never spends a link without verifying its user', async () => {
 const owner=await signup({email:`verifyrollback_${Date.now()}@example.com`,password:'OriginalPass123!'});
 const hash=createHash('sha256').update(owner.emailVerificationToken).digest('hex');
 await mutateData(data=>{data.users=data.users.filter(row=>row.id!==owner.user.id)});
 await assert.rejects(()=>verifyEmail(owner.emailVerificationToken));
 assert.equal((await repositories.emailVerificationToken.findByTokenHash(hash))?.consumedAt,undefined,'failed verification must not consume link');
}]);
async function main(){let failed=0;
for(const [name,fn] of cases){try{await fn(); console.log(`PASS ${name}`)}catch(e){failed++; console.error(`FAIL ${name}: ${(e as Error).message}`)}}
console.log(`foundation-regressions: ${cases.length-failed}/${cases.length} passed`);
process.exitCode=failed?1:0;

} main().catch(e=>{console.error(e);process.exitCode=1});
