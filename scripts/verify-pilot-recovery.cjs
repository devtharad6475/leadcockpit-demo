// Isolated proof only: never a production backup scheduler or restore tool.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), container = 'leadcockpit-ci-readiness';
const proof = path.join(root, 'readiness-proof', 'pilot-recovery');
fs.mkdirSync(proof, { recursive: true });
const inspected = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
assert.equal(inspected.Name, '/' + container);
assert.ok(inspected.NetworkSettings.Ports['5432/tcp'].some(p => p.HostIp === '127.0.0.1' && p.HostPort === '54389'));
const config = Object.fromEntries(inspected.Config.Env.map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
const name = 'readiness_pilot_' + Date.now(), recovered = name + '_restored';
const created = [];
function sql(db, query) {
  assert.ok(db === config.POSTGRES_DB || created.includes(db));
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-U', config.POSTGRES_USER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-At'], { input: query, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}
function env(db) {
  const value = { ...process.env, DATABASE_URL: `postgresql://${encodeURIComponent(config.POSTGRES_USER)}:${encodeURIComponent(config.POSTGRES_PASSWORD)}@127.0.0.1:54389/${db}`, PERSISTENCE_PROVIDER: 'prisma', AUTH_MODE: 'production', AUTH_SESSION_SECRET: 'isolated-pilot-proof-session-secret-2026', ENCRYPTION_KEY: 'isolated-pilot-proof-encryption-key-2026', REDIS_URL: '', RATE_LIMIT_BACKEND: 'memory', PILOT_PROOF_DIR: proof };
  for (const key of Object.keys(value)) if (/API_KEY|ACCESS_TOKEN|SYSTEM_TOKEN|WHATSAPP_TOKEN/.test(key)) value[key] = '';
  for (const key of ['RESEND_API_KEY','PLATFORM_DEEPSEEK_API_KEY','PLATFORM_OPENAI_API_KEY','PLATFORM_SERPAPI_API_KEY','SERPAPI_API_KEY','WHATSAPP_CLOUD_ACCESS_TOKEN']) value[key] = '';
  return value;
}
function run(db, label, args) {
  const r = spawnSync(process.execPath, args, { cwd: root, env: env(db), encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  fs.writeFileSync(path.join(proof, label + '.log'), (r.stdout || '') + (r.stderr || ''));
  assert.equal(r.error, undefined, label);
  assert.equal(r.status, 0, `${label} failed; inspect its proof log`);
  console.log('PASS ' + label);
}
function snapshot(db) {
  const tables = sql(db, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename").split('\n').filter(Boolean);
  const queries = tables.map(table => {
    assert.match(table, /^[A-Za-z_][A-Za-z0-9_]*$/);
    return `SELECT '${table}' AS name, (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) FROM public."${table}" t) AS payload`;
  });
  return JSON.parse(sql(db, `SELECT jsonb_object_agg(name, payload ORDER BY name)::text FROM (${queries.join(' UNION ALL ')}) q`));
}
try {
  for (const db of [name, recovered]) {
    assert.match(db, /^readiness_pilot_\d+(?:_restored)?$/);
    sql(config.POSTGRES_DB, `CREATE DATABASE ${db}`); created.push(db);
  }
  run(name, 'migrations', ['node_modules/prisma/build/index.js', 'migrate', 'deploy']);
  run(name, 'fixture-and-concurrent-work', ['node_modules/tsx/dist/cli.mjs', 'scripts/pilot-recovery-fixture.ts', 'seed']);
  if (process.env.PILOT_HTTP_PROOF === '1') run(name, 'concurrent-http', ['scripts/pilot-concurrent-http.cjs']);
  const before = snapshot(name);
  const dump = execFileSync('docker', ['exec', container, 'pg_dump', '-U', config.POSTGRES_USER, '-d', name, '-Fc', '--no-owner', '--no-acl'], { maxBuffer: 32 * 1024 * 1024 });
  fs.writeFileSync(path.join(proof, 'synthetic-backup.dump'), dump);
  const start = Date.now();
  execFileSync('docker', ['exec', '-i', container, 'pg_restore', '-U', config.POSTGRES_USER, '-d', recovered, '--no-owner', '--no-acl', '--exit-on-error'], { input: dump, stdio: ['pipe', 'pipe', 'pipe'] });
  const restored = snapshot(recovered);
  assert.deepEqual(restored, before, 'Every public table including auth, chats, files, counters and migrations must match exactly');
  console.log(`PASS exact complete restore: ${Object.keys(before).length} public tables`);
  // Damage ONLY the new disposable source, proving recovery is independent.
  sql(name, "DELETE FROM workspaces WHERE id IN (SELECT id FROM workspaces)");
  assert.equal(sql(name, 'SELECT count(*) FROM workspaces'), '0');
  assert.deepEqual(snapshot(recovered), before);
  run(recovered, 'restored-business-values', ['node_modules/tsx/dist/cli.mjs', 'scripts/pilot-recovery-fixture.ts', 'verify']);
  fs.writeFileSync(path.join(proof, 'receipt.json'), JSON.stringify({ date: new Date().toISOString(), release: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), substrate: 'disposable loopback PostgreSQL; never hosted', tableCount: Object.keys(before).length, restoreAndVerifyMs: Date.now() - start, fullTableValuesEqual: true, originalDisposableSourceErased: true, noPaidCallsOrCustomerSends: true }, null, 2));
  console.log('PASS recovery independent of damaged disposable source');
} finally {
  for (const db of created.reverse()) sql(config.POSTGRES_DB, `DROP DATABASE ${db} WITH (FORCE)`);
}
