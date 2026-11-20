import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Final journeys use the built application and the existing disposable JSON
// fixtures/key isolation. No hosted data or customer channels are accessed.
export default defineConfig({
  ...base,
  retries: 0,
  reporter: "list",
  webServer: {
    ...base.webServer,
    command: "npm run start",
    reuseExistingServer: false,
  },
});
