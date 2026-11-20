import { defineConfig } from '@playwright/test';
import journeys from './playwright.journey-audit.config';
export default defineConfig({ ...journeys, testMatch: /(customer-business-playtest|employee-(memory-journey|ticket-loop))\.spec\.ts/ });
