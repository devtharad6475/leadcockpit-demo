import { defineConfig } from '@playwright/test';
import access from './playwright.week-six-access.config';
export default defineConfig({ ...access, globalSetup: require.resolve('./e2e/helpers/employee-journey-setup.ts'), testMatch: /customer-ticket-editor\.spec\.ts/ });
