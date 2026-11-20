import { defineConfig } from '@playwright/test';
import access from './playwright.week-six-access.config';
export default defineConfig({ ...access, testMatch: /(prototype-cleanup|prototype-ticket-retry|prototype-form-recovery|prototype-document-recovery|week-four-access)\.spec\.ts/ });
