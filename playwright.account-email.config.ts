import { defineConfig } from "@playwright/test";
import journey from "./playwright.journey-audit.config";
export default defineConfig({ ...journey, testMatch: /account-email-journey\.spec\.ts/ });
