import {defineConfig} from "@playwright/test";
import base from "./playwright.config";
process.env.WEEK_FOUR_AUTH_PROOF = "1";
const server = Array.isArray(base.webServer) ? base.webServer[0] : base.webServer!;
export default defineConfig({...base,
  testMatch: /week-four-access\.spec\.ts/,
  globalSetup: require.resolve("./e2e/helpers/week-four-auth-setup.ts"),
  webServer: {...server, env: {...server.env,
    AUTH_MODE: "production", AUTH_SESSION_SECRET: "disposable-week-four-browser-auth-secret-2026",
    PLATFORM_ADMIN_SESSION_SECRET: "disposable-week-four-platform-admin-secret-2026",
    ENCRYPTION_KEY: "disposable-week-four-browser-encryption-key", DATABASE_URL: "",
  }},
});
