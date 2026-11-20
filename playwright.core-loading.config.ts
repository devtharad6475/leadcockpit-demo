import { defineConfig } from '@playwright/test';
import access from './playwright.week-six-access.config';

// This journey creates its own company on a fresh server. Combining its signup
// with the five existing recovery signups correctly exhausts the production IP
// signup cap. Keep the cap intact and isolate this independently-owned journey.
export default defineConfig({ ...access, testMatch: /prototype-core-loading\.spec\.ts/ });
