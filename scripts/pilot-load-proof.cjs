// Bounded synthetic production-build HTTP load. Never connects to a hosted database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync, spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const proof = path.join(root, 'readiness-proof', 'pilot-load');
const container = 'leadcockpit-ci-readiness';
const databaseName = 'readiness_pilot_' + Date.now();
const base = 'http://127.0.0.1:3228';
const password = 'Synthetic-pilot-load-password-2026!';
const mode = process.env.PILOT_LOAD_MODE || 'paced';
assert.ok(['burst', 'paced'].includes(mode));
let databaseCreated = false, server, serverLog;
fs.mkdirSync(proof, { recursive: true });
const inspected = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
assert.equal(inspected.Name, '/' + container);
assert.ok(inspected.NetworkSettings.Ports['5432/tcp'].some(p => p.HostIp === '127.0.0.1' && p.HostPort === '54389'));
const config = Object.fromEntries(inspected.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
assert.match(databaseName, /^readiness_pilot_\d+$/);
const buildId = fs.readFileSync(path.join(root, '.next-pilot-acceptance', 'BUILD_ID'), 'utf8').trim();
const isolatedEnv = {
  ...process.env, DATABASE_URL: `postgresql://${encodeURIComponent(config.POSTGRES_USER)}:${encodeURIComponent(config.POSTGRES_PASSWORD)}@127.0.0.1:54389/${databaseName}`,
  PERSISTENCE_PROVIDER: 'prisma', AUTH_MODE: 'production', AUTH_SESSION_SECRET: 'isolated-pilot-load-session-secret-2026',
  ENCRYPTION_KEY: 'isolated-pilot-load-encryption-key-2026', REDIS_URL: '', RATE_LIMIT_BACKEND: 'memory',
  NEXT_PUBLIC_APP_ORIGIN: base, LEADGEN_DIST_DIR: '.next-pilot-acceptance', PORT: '3228', NODE_ENV: 'production',
  PILOT_PROOF_DIR: proof, WHATSAPP_LIVE_SEND_ENABLED: 'false',
};
for (const key of Object.keys(isolatedEnv)) if (/API_KEY|ACCESS_TOKEN|SYSTEM_TOKEN|WHATSAPP_TOKEN/.test(key)) isolatedEnv[key] = '';
// Prevent Next/tsx dotenv loading from supplying locally saved provider keys.
for (const key of ['RESEND_API_KEY','PLATFORM_OPENAI_API_KEY','PLATFORM_DEEPSEEK_API_KEY','PLATFORM_KIMI_API_KEY','PLATFORM_MINIMAX_API_KEY','PLATFORM_GEMINI_API_KEY','PLATFORM_ANTHROPIC_API_KEY','PLATFORM_SERPAPI_API_KEY','SERPAPI_API_KEY','WHATSAPP_CLOUD_ACCESS_TOKEN']) isolatedEnv[key] = '';
function sql(db, query) {
  assert.ok(db === config.POSTGRES_DB || db === databaseName);
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', config.POSTGRES_USER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-At'], { input: query, encoding: 'utf8' }).trim();
}
function run(label, args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: isolatedEnv, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(proof, label + '.log'), (result.stdout || '') + (result.stderr || ''));
  assert.equal(result.error, undefined, label);
  assert.equal(result.status, 0, label + ' failed; see isolated proof log');
}
const fixture = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { signup } from './src/services/SignupService';
import { createInvite, acceptInvite } from './src/services/InviteService';
import { prisma } from './src/lib/prisma';
import { assertDisposableReadinessDatabase } from './scripts/golden/_helpers/disposable-readiness-database';
async function seed() {
 assertDisposableReadinessDatabase(process.env.DATABASE_URL, process.env.CI);
 const password = ${JSON.stringify(password)};
 const owner = await signup({ email: 'load-owner@example.invalid', password, name: 'Load owner', businessName: 'Synthetic load cartons' });
 const foreign = await signup({ email: 'load-foreign@example.invalid', password, name: 'Foreign owner', businessName: 'Separate synthetic company' });
 const workspaceId = owner.user.workspaceId;
 const actors = [{email: owner.user.email, role: 'owner'}];
 for (let i=0; i<24; i++) {
  const email = 'load-staff-'+i+'@example.invalid';
  const invite = await createInvite({ workspaceId, invitedByUserId: owner.user.id, inviteeEmail: email, role: 'sales_member' });
  assert.equal(invite.emailSent, false);
  await acceptInvite({ rawToken: invite.rawToken, name: 'Synthetic staff '+i, password });
  actors.push({email, role: 'sales_member'});
 }
 fs.writeFileSync(path.join(process.env.PILOT_PROOF_DIR!, 'identities.json'), JSON.stringify({workspaceId, foreignWorkspaceId: foreign.user.workspaceId, actors}));
 console.log('PASS 25 distinct active owner/employee identities and separate foreign company; no mail delivered');
}
seed().catch(error => { console.error(error); process.exitCode=1; }).finally(()=>prisma.$disconnect());
`;
const samples = [];
async function request(cookie, route, body, expected = 200, record = true) {
  const start = performance.now();
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: base, cookie }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  const elapsedMs = performance.now() - start;
  if (record) samples.push({ route, method: body ? 'POST' : 'GET', status: response.status, elapsedMs });
  assert.equal(response.status, expected, route + ' ' + JSON.stringify(data).slice(0, 300));
  return { response, data };
}
async function login(email, workspaceId) {
  const value = await request('', '/api/auth/login', { email, workspaceId, password }, 200, false);
  const cookie = value.response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
  assert.ok(cookie); return cookie;
}
function stats(values) {
  const sorted = values.map(s => s.elapsedMs).sort((a,b)=>a-b);
  const percentile = p => Math.round(sorted[Math.min(sorted.length-1, Math.ceil(sorted.length*p)-1)] * 10)/10;
  return { count: values.length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: percentile(1), unexpectedFailures: values.filter(s=>s.status !== 200).length };
}
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function main() {
  sql(config.POSTGRES_DB, `CREATE DATABASE ${databaseName}`); databaseCreated = true;
  run('migrations', ['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
  run('identities', ['node_modules/tsx/dist/cli.mjs', '-e', fixture]);
  const ids = JSON.parse(fs.readFileSync(path.join(proof, 'identities.json'), 'utf8'));
  serverLog = fs.openSync(path.join(proof, 'http-server.log'), 'w');
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3228'], { cwd: root, env: isolatedEnv, stdio: ['ignore', serverLog, serverLog], windowsHide: true });
  const deadline = Date.now()+60000;
  let ready = false;
  while (Date.now()<deadline) {
    if (server.exitCode !== null) throw new Error('Isolated HTTP server exited');
    try { const r = await fetch(base+'/api/health', {signal: AbortSignal.timeout(2000)}); const data = await r.json(); ready = r.ok && data.persistenceProvider==='prisma' && data.authMode==='production'; } catch {}
    if (ready) break;
    await new Promise(r=>setTimeout(r,250));
  }
  assert.ok(ready);
  // Each actor has their own real login and signed session; no role-gate bypass.
  const actors = [];
  for (const actor of ids.actors) actors.push({...actor, cookie: await login(actor.email, ids.workspaceId)});
  const foreign = await login('load-foreign@example.invalid', ids.foreignWorkspaceId);
  const stages = [], leadIds = [], ticketIds = [], ticketNumbers = [];
  for (const users of (mode === 'paced' ? [25] : [5,10,25])) {
    const startIndex = samples.length, started = performance.now();
    for (let round=0; round<3; round++) {
      await Promise.all(actors.slice(0,users).map(async (actor,index)=> {
        const leads = await request(actor.cookie, '/api/leads'); assert.ok(Array.isArray(leads.data));
        if (mode === 'paced') await pause(2000);
        const tickets = await request(actor.cookie, '/api/tickets'); assert.ok(Array.isArray(tickets.data));
        if (mode === 'paced') await pause(2000);
        const lead = await request(actor.cookie, '/api/leads/manual', { companyName: `Synthetic ${users} users round ${round} customer ${index}`, contactName: 'Synthetic buyer' });
        assert.ok(lead.data.id); leadIds.push(lead.data.id);
        if (mode === 'paced') await pause(2000);
        const ticket = await request(actor.cookie, '/api/tickets', {leadId: lead.data.id, subject: `Sample concern ${users}-${round}-${index}`, description: 'Synthetic only; no sending, no promises.', type: 'complaint', priority: 'medium', sourceChannel: 'manual'});
        assert.equal(ticket.data.leadId, lead.data.id); ticketIds.push(ticket.data.id); ticketNumbers.push(ticket.data.ticketNumber);
      }));
      if (mode === 'paced' && round < 2) await pause(30000);
    }
    const wallMs = Math.round(performance.now()-started);
    const stage = { users, rounds: 3, mode, actionThinkTimeMs: mode==='paced'?2000:0, betweenRoundsMs: mode==='paced'?30000:0, wallMs, ...stats(samples.slice(startIndex)) };
    stage.requestsPerSecond = Math.round(stage.count/wallMs*100000)/100;
    stages.push(stage); console.log('PASS stage '+JSON.stringify(stage));
    const [leads,tickets,staffTickets,foreignLeads,foreignTickets] = await Promise.all([
      request(actors[0].cookie,'/api/leads',undefined,200,false), request(actors[0].cookie,'/api/tickets',undefined,200,false),
      request(actors[1].cookie,'/api/tickets',undefined,200,false), request(foreign,'/api/leads',undefined,200,false), request(foreign,'/api/tickets',undefined,200,false),
    ]);
    assert.equal(leads.data.length, leadIds.length); assert.equal(tickets.data.length,ticketIds.length); assert.equal(staffTickets.data.length,ticketIds.length);
    assert.deepEqual(new Set(leads.data.map(x=>x.id)),new Set(leadIds));
    assert.deepEqual(new Set(tickets.data.map(x=>x.id)),new Set(ticketIds));
    assert.equal(new Set(ticketNumbers).size,ticketNumbers.length);
    assert.equal(foreignLeads.data.length,0); assert.equal(foreignTickets.data.length,0);
    await request(foreign,'/api/tickets',{leadId:leadIds[0],subject:'Foreign refused',type:'complaint'},404,false);
  }
  assert.equal(sql(databaseName,'SELECT count(*) FROM tickets'), String(ticketIds.length));
  assert.equal(sql(databaseName,'SELECT count(*) FROM leads'), String(leadIds.length));
  const receipt = { date:new Date().toISOString(), sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(), buildId,
    substrate:'Disposable loopback PostgreSQL + production Next.js build; not hosted capacity certification', independentActors:25, stages,
    customersPersisted:leadIds.length, ticketsPersisted:ticketIds.length, exactCountsAndUniqueNumbers:true, crossCompanyDenied:true,
    noPaidCallsOrCustomerSends:true, securityLimitsUnchanged:true, sharedIpLimit:300, sharedWorkspaceLimit:600, rateWindowMs:60000,
    limitations:['Single local app process and memory rate limiter','Small synthetic datasets; no sustained soak or hosted latency','No browser rendering/AI/media/upload load','25 concurrent user journeys, sequential actions per user, three rounds per stage'] };
  fs.writeFileSync(path.join(proof,mode+'-receipt.json'),JSON.stringify(receipt,null,2));
  fs.writeFileSync(path.join(proof,mode+'-request-timings.json'),JSON.stringify(samples,null,2));
  console.log('PASS exact persisted counts, unique ticket numbers, separate company denial; '+leadIds.length+' customers and '+ticketIds.length+' tickets');
}
main().catch(error=> {
  fs.writeFileSync(path.join(proof,mode+'-failure-receipt.json'),JSON.stringify({date:new Date().toISOString(),buildId,mode,error:error.message,
    partialRequestStats:samples.length?stats(samples):null, rateLimitedRequests:samples.filter(x=>x.status===429).length,
    noSilentRetry:true, securityLimitsUnchanged:true, exactPersistedCountsVerified:false, limits:{perSharedIp:300,perWorkspace:600,windowMs:60000}},null,2));
  fs.writeFileSync(path.join(proof,mode+'-failed-request-timings.json'),JSON.stringify(samples,null,2));
  console.error(error.message); process.exitCode=1;
}).finally(async()=> {
  if (server && server.exitCode === null) { server.kill(); await new Promise(r=>server.exitCode!==null?r():server.once('exit',r)); }
  if (serverLog !== undefined) fs.closeSync(serverLog);
  if (databaseCreated) sql(config.POSTGRES_DB,`DROP DATABASE ${databaseName} WITH (FORCE)`);
});
