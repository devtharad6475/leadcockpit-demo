import { defineConfig } from '@playwright/test';
import base from './playwright.week-six-access.config';
export default defineConfig({ ...base, testMatch: /customer-business-playtest\.spec\.ts/ });
