import { defineConfig } from "@playwright/test";
import access from "./playwright.week-four.config";

const server = Array.isArray(access.webServer) ? access.webServer[0] : access.webServer!;
export default defineConfig({
  ...access,
  retries: 0,
  reporter: "list",
  // Keep the production server on the Node version that runs Playwright.
  // npm's Windows launcher can otherwise select a different installed Node.
  webServer: { ...server, command: `"${process.execPath}" node_modules/next/dist/bin/next start`, reuseExistingServer: false },
});
