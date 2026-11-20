import { defineConfig } from '@playwright/test';
import base from './playwright.config';
const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer!;
export default defineConfig({ ...base, retries: 0, reporter: 'list',
  testMatch: /(nested-ui-journey|full-button-coverage|depth-(crm|commercial|knowledge|profile-icp-campaign|info-review-replies|settings|tickets|workspace-compliance|media-analytics-whatsapp-export))\.spec\.ts/,
  webServer: { ...server, command: `"${process.execPath}" node_modules/next/dist/bin/next start`, reuseExistingServer: false },
});
