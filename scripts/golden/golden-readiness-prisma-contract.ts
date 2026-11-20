import './_helpers/isolate-standalone';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { PrismaAuthRepository, PasswordResetTokenPrismaRepository } from '@/repositories/prisma';
import type { Workspace, User, UserCredential, WorkspaceMember } from '@/lib/types';

// Adapter contract only: all transaction delegates below are fake. No database connection.
async function main() {
 const original = prisma.$transaction;
 let count=0;
 try {
  const calls:string[]=[];
  const tx={
   $executeRawUnsafe:async(query:string,key:string)=>{assert.match(query,/pg_advisory_xact_lock/);assert.equal(key,'owner-signup:same@example.com');calls.push('lock')},
   userCredential:{findFirst:async()=>{calls.push('collision');return{id:'existing'};}},
   workspace:{create:async()=>{throw new Error('must not create duplicate workspace')}}
  };
  Object.assign(prisma,{$transaction:async(fn:(tx:unknown)=>Promise<unknown>)=>fn(tx)});
  await assert.rejects(()=>new PrismaAuthRepository().createWorkspaceWithOwner({workspace:{} as Workspace,user:{} as User,credential:{email:' Same@Example.com '} as UserCredential,member:{} as WorkspaceMember}),/already exists/);
  assert.deepEqual(calls,['lock','collision']);count++;
  const events:string[]=[];
  Object.assign(prisma,{$transaction:async(fn:(tx:unknown)=>Promise<unknown>)=>fn({
   passwordResetToken:{findFirst:async()=>({id:'token',userId:'u',workspaceId:'w'}),updateMany:async(args:{where:{consumedAt:null};data:unknown})=>{assert.equal(args.where.consumedAt,null);events.push('claim');return{count:0}}},
   userCredential:{findFirst:async()=>{throw new Error('spent token must not write password')}}
  })});
  assert.equal(await new PasswordResetTokenPrismaRepository().redeem('hash','password-hash'),undefined);
  assert.deepEqual(events,['claim']);count++;
  console.log(`foundation-prisma-contract: ${count}/2 passed (stub delegates; live database unverified)`);
 }finally{Object.assign(prisma,{$transaction:original});await prisma.$disconnect()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
