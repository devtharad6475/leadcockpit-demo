// Synthetic, loopback-only authenticated HTTP proof. Never points at owner data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const database = new URL(process.env.DATABASE_URL);
assert.equal(database.hostname, '127.0.0.1');
assert.equal(database.port, '54389');
assert.match(database.pathname, /^\/readiness_pilot_\d+$/);
assert.equal(process.env.PERSISTENCE_PROVIDER, 'prisma');
assert.equal(process.env.AUTH_MODE, 'production');
const proof = process.env.PILOT_PROOF_DIR;
const ids = JSON.parse(fs.readFileSync(path.join(proof, 'fixture-identities.json'), 'utf8'));
const base = 'http://127.0.0.1:3227';
const output = fs.openSync(path.join(proof, 'http-server.log'), 'w');
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3227'], {
  env: { ...process.env, NODE_ENV: 'production', LEADGEN_DIST_DIR: '.next-pilot-acceptance', PORT: '3227' },
  stdio: ['ignore', output, output], windowsHide: true,
});
async function request(cookie, route, body) {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: base, cookie }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  return { response, data: await response.json() };
}
async function login(email, workspaceId) {
  const result = await request('', '/api/auth/login', { email, workspaceId, password: 'Synthetic-pilot-recovery-password-2026!' });
  assert.equal(result.response.status, 200, 'Synthetic normal sign-in must succeed');
  const cookie = result.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.ok(cookie);
  return cookie;
}
async function main() {
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Disposable HTTP server exited before readiness');
    try {
      const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(3000) });
      const value = await health.json();
      if (health.ok && value.persistenceProvider === 'prisma' && value.authMode === 'production') { ready = true; break; }
    } catch { /* bounded cold startup */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Disposable PostgreSQL server must actually be ready');
  const [owner, staff, foreign] = await Promise.all([
    login('pilot-owner@example.invalid', ids.workspaceId),
    login('pilot-employee@example.invalid', ids.workspaceId),
    login('pilot-foreign@example.invalid', ids.foreignWorkspaceId),
  ]);
  const before = await request(owner, '/api/tickets');
  assert.equal(before.response.status, 200);
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => request(index % 2 ? staff : owner, '/api/tickets', {
    leadId: ids.leadId, subject: `Concurrent HTTP complaint ${index}`, description: 'Synthetic customer issue; no external communication.', type: 'complaint', priority: 'medium', sourceChannel: 'manual',
  })));
  for (const result of results) { assert.equal(result.response.status, 200); assert.equal(result.data.leadId, ids.leadId); }
  assert.equal(new Set(results.map(result => result.data.ticketNumber)).size, 12);
  const [ownerView, staffView, otherView, denied] = await Promise.all([
    request(owner, '/api/tickets'), request(staff, '/api/tickets'), request(foreign, '/api/tickets'),
    request(foreign, '/api/tickets', { leadId: ids.leadId, subject: 'Refused cross-company issue', type: 'complaint' }),
  ]);
  assert.equal(ownerView.data.length, before.data.length + 12);
  assert.equal(staffView.data.length, ownerView.data.length);
  assert.equal(otherView.data.length, 0);
  assert.equal(denied.response.status, 404);
  console.log(`PASS three independent signed-in HTTP sessions, 12 simultaneous owner/staff tickets, exact persisted counts, unique numbers and foreign-company refusal (${Date.now()-started}ms)`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  child.kill();
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  fs.closeSync(output);
});
