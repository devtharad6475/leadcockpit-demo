import './_helpers/force-json-provider';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PAID_KEY_ENV_NAMES } from '../../playwright.config';
import { createJsonRepos } from './_helpers/provider';

async function main() {
  const root = process.cwd(), folder = path.join(root, process.env.LEADGEN_DIST_DIR || '.next', 'standalone');
  assert(fs.existsSync(path.join(folder, 'server.js')), 'Build the isolated production artifact first');
  const dataDir = process.env.LEADGEN_DATA_DIR!;
  fs.mkdirSync(dataDir, { recursive: true });
  // Fresh checkouts have no browser snapshot. Create the fixture through the
  // real repository in the isolated directory chosen before module imports.
  const repos = createJsonRepos();
  await repos.workspace.create({ id: 'workspace_demo', name: 'Standalone PDF fixture', status: 'active' });
  await repos.businessProfile.create({ workspaceId: 'workspace_demo', companyName: 'Standalone PDF fixture', industry: 'Packaging', products: ['Shipping cartons'] });
  // Reproduce the Dockerfile's explicit runtime public/worker asset copies.
  fs.cpSync(path.join(root, 'public', 'fonts', 'pdf'), path.join(folder, 'public', 'fonts', 'pdf'), { recursive: true });
  const worker = path.join(folder, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs');
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  fs.copyFileSync(path.join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs'), worker);
  const env: NodeJS.ProcessEnv = { ...process.env, ...Object.fromEntries(PAID_KEY_ENV_NAMES.map(name => [name, ''])), NODE_ENV: 'production', PORT: '3216', HOSTNAME: '127.0.0.1', AUTH_MODE: 'demo', PERSISTENCE_PROVIDER: 'json', DATABASE_URL: '', LEADGEN_DATA_DIR: dataDir };
  const server = spawn(process.execPath, ['server.js'], { cwd: folder, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; server.stdout.on('data', value => { output += value.toString(); }); server.stderr.on('data', value => { output += value.toString(); });
  try {
    let ready = false;
    for (let index = 0; index < 60; index++) {
      if (server.exitCode !== null) throw new Error(`Standalone stopped (${server.exitCode}): ${output.slice(-1000)}`);
      try { const response = await fetch('http://127.0.0.1:3216/api/health', { signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch { /* Wait for owned server startup. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert(ready, 'Owned standalone server did not become ready');
    const response = await fetch('http://127.0.0.1:3216/api/knowledge/questionnaire/pdf', { headers: { cookie: 'lc_demo=1' }, signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200, await response.clone().text().then(text => text.slice(0, 300)));
    assert.match(response.headers.get('content-type') || '', /application\/pdf/);
    const pdf = Buffer.from(await response.arrayBuffer()); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert(pdf.length > 10000, 'Questionnaire must include real document content');
    const proof = path.join(root, 'docs', 'system-workflow', 'readiness-proof');
    fs.mkdirSync(proof, { recursive: true });
    fs.writeFileSync(path.join(proof, 'standalone-questionnaire.pdf'), pdf);
    console.log(`PASS standalone runtime generated ${pdf.length} PDF bytes with bundled fonts, using a separate disposable data directory; no provider calls`);
  } finally { server.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
