import './_helpers/force-json-provider';
import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { withJsonFileIO } from '@/lib/json-file-io';
import { readData, writeData, mutateData } from '@/lib/db';

async function main() {
  const initial = await readData();
  const destination = path.join(process.env.LEADGEN_DATA_DIR!, 'app-data.json');
  let release!: () => void, opened!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { opened = resolve; });
  const oldBytes = await readFile(destination, 'utf8');
  const reader = withJsonFileIO(async () => {
    const handle = await open(destination, 'r');
    try { opened(); await hold; return await handle.readFile('utf8'); }
    finally { await handle.close(); }
  });
  await ready;
  const changed = structuredClone(initial);
  changed.workspaces[0].name = 'Exactly persisted after held read';
  let saved = false;
  const writer = writeData(changed).then(() => { saved = true; });
  // Test an actual held OS read handle while writeData prepares a real temp file.
  // The destination must retain its previous bytes until the read completes.
  await new Promise(resolve => setTimeout(resolve, 50));
  try {
    assert.equal(saved, false);
    assert.equal(await readFile(destination, 'utf8'), oldBytes);
  } finally { release(); }
  assert.equal(await reader, oldBytes);
  await writer;
  assert.equal((await readData()).workspaces[0].name, changed.workspaces[0].name);
  console.log('PASS actual held read prevents atomic replacement; subsequent reader sees exact persisted value');

  await assert.rejects(withJsonFileIO(async () => { throw new Error('Injected read failure'); }), /Injected read failure/);
  const later = structuredClone(changed); later.workspaces[0].name = 'Queue recovered';
  await writeData(later);
  assert.equal((await readData()).workspaces[0].name, 'Queue recovered');
  console.log('PASS failed IO releases queue; later actual write/read succeeds');

  await mutateData(data => { data.workspaces[0].name = 'Business transaction remains live'; });
  assert.equal((await readData()).workspaces[0].name, 'Business transaction remains live');
  console.log('PASS business mutation lock and file IO queue do not deadlock');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
