import fs from 'node:fs';
import setup from './week-four-auth-setup';
import { E2E_DATA_FILE, assertE2EDataDirIsIsolated } from './data-dir';
export default async function employeeSetup() {
  assertE2EDataDirIsIsolated();
  await setup();
  fs.copyFileSync(E2E_DATA_FILE, `${E2E_DATA_FILE}.employee-snapshot.json`);
}
