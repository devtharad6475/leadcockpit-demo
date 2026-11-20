import { defineConfig } from '@playwright/test';
import access from './playwright.week-six-access.config';
export default defineConfig({ ...access, testMatch: /workspace-ui-cleanup\.spec\.ts/ });
