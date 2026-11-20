// PRISMA_GOLDEN — disposable localhost database only; no hosted data permitted.
import "./_helpers/readiness-prisma-environment";
import { readinessFixtureCleanup } from "./_helpers/readiness-fixture-cleanup";
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {repositories} from '@/repositories';
import {prisma} from '@/lib/prisma';
import {signup, verifyEmail, resendVerification} from '@/services/SignupService';
import {createInvite, acceptInvite} from '@/services/InviteService';
const hash=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const fixtures = readinessFixtureCleanup();
fixtures.attach(repositories);
async function main(){
 let passed=0;
 const email=`concurrent_${Date.now()}@example.com`;
 const outcomes=await Promise.allSettled([signup({email,password:'OriginalPass123!'}),signup({email,password:'OriginalPass123!'})]);
 assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);
 const credentials=await prisma.userCredential.findMany({where:{email}});assert.equal(credentials.length,1);passed++;console.log('PASS concurrent owner signups create exactly one workspace');
 const owner=await signup({email:`owner_${Date.now()}@example.com`,password:'OriginalPass123!'});
 const invite=await createInvite({workspaceId:owner.user.workspaceId,invitedByUserId:owner.user.id,inviteeEmail:email,role:'viewer'});
 await acceptInvite({rawToken:invite.rawToken,name:'Invited',password:'InvitedPass123!'});
 assert.equal((await prisma.userCredential.findMany({where:{email}})).length,2);passed++;console.log('PASS same email may still join a second company by invite');
 const raw='real-db-concurrent-reset';
 await repositories.passwordResetToken.create({userId:owner.user.id,workspaceId:owner.user.workspaceId,tokenHash:hash(raw),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),issuedByAdminId:'test'});
 const resets=await Promise.all([repositories.passwordResetToken.redeem(hash(raw),'replacement-one'),repositories.passwordResetToken.redeem(hash(raw),'replacement-two')]);
 assert.equal(resets.filter(Boolean).length,1);assert.equal((await prisma.userCredential.findFirst({where:{userId:owner.user.id}}))?.sessionVersion,2);passed++;console.log('PASS concurrent reset claims spend one link and bump session once');
 const rollback='real-db-rollback-reset';
 await repositories.passwordResetToken.create({userId:owner.user.id,workspaceId:owner.user.workspaceId,tokenHash:hash(rollback),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),issuedByAdminId:'test'});
 const before=await prisma.userCredential.findFirst({where:{userId:owner.user.id}});
 await prisma.$executeRawUnsafe("CREATE FUNCTION readiness_reject_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected readiness write failure'; END $$");
 await prisma.$executeRawUnsafe('CREATE TRIGGER readiness_reject_credential BEFORE UPDATE ON user_credentials FOR EACH ROW EXECUTE FUNCTION readiness_reject_write()');
 try{await assert.rejects(()=>repositories.passwordResetToken.redeem(hash(rollback),'must-not-persist'));assert.equal((await repositories.passwordResetToken.findByTokenHash(hash(rollback)))?.consumedAt,undefined);assert.equal((await prisma.userCredential.findFirst({where:{userId:owner.user.id}}))?.passwordHash,before?.passwordHash)}finally{await prisma.$executeRawUnsafe('DROP TRIGGER readiness_reject_credential ON user_credentials')}
 passed++;console.log('PASS reset transaction rolls back claim when password write fails');
 await prisma.$executeRawUnsafe('CREATE TRIGGER readiness_reject_user BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION readiness_reject_write()');
 try{await assert.rejects(()=>verifyEmail(owner.emailVerificationToken));assert.equal((await repositories.emailVerificationToken.findByTokenHash(hash(owner.emailVerificationToken)))?.consumedAt,undefined);assert.equal(Boolean((await repositories.user.findById(owner.user.id))?.emailVerifiedAt),false)}finally{await prisma.$executeRawUnsafe('DROP TRIGGER readiness_reject_user ON users')}
 passed++;console.log('PASS verification transaction rolls back claim when user write fails');
 const results=await Promise.all([verifyEmail(owner.emailVerificationToken),verifyEmail(owner.emailVerificationToken)]);assert.ok(results.every(row=>row.verified));assert.equal(results[0].verifiedAt,results[1].verifiedAt);assert.equal((await verifyEmail(owner.emailVerificationToken)).verified,true);passed++;console.log('PASS simultaneous verification and repeat click remain idempotent');
 const later=await signup({email:`reissue_${Date.now()}@example.com`,password:'OriginalPass123!'});
 const newest=await resendVerification({userId:later.user.id});await assert.rejects(()=>verifyEmail(later.emailVerificationToken));assert.equal((await verifyEmail(newest)).verified,true);passed++;console.log('PASS reissue invalidates old verification link');
 await prisma.$executeRawUnsafe('DROP FUNCTION readiness_reject_write()');
 console.log(`readiness-foundation-prisma: ${passed}/7 passed on disposable PostgreSQL`);
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async () => { try { await fixtures.cleanup(); } finally { await prisma.$disconnect(); } });
