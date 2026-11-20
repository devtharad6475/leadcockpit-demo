// Throwaway server for the break test (scripts/probes/break-api.ts).
// Its own copy of the demo data, JSON store (never Postgres), demo login, and
// every AI / WhatsApp / search key replaced with a dummy so nothing is billed
// and nothing can reach a customer. Started through .claude/launch.json.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// `--production` runs the same throwaway copy with real sign-in, roles and
// CSRF on (port 3021), for probes that need them. The session secret is made
// fresh here and never printed.
const production = process.argv.includes("--production");
const port = production ? "3021" : "3020";

const dataDir = path.join(os.tmpdir(), `leadcockpit-break-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
if (fs.existsSync(".leadgen-data/app-data.json")) fs.copyFileSync(".leadgen-data/app-data.json", path.join(dataDir, "app-data.json"));

const dummy = "disabled-for-break-test";
const env = {
  ...process.env,
  PERSISTENCE_PROVIDER: "json",
  LEADGEN_DATA_DIR: dataDir,
  AUTH_MODE: production ? "production" : "demo",
  ...(production ? { AUTH_SESSION_SECRET: crypto.randomBytes(32).toString("hex") } : {}),
  DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:1/none",
  WHATSAPP_CLOUD_ACCESS_TOKEN: dummy,
  WHATSAPP_CLOUD_PHONE_NUMBER_ID: dummy,
  PLATFORM_SERPAPI_API_KEY: dummy,
};
for (const key of Object.keys(env)) if (/^PLATFORM_.*_API_KEY$/.test(key)) env[key] = dummy;
for (const key of ["PLATFORM_OPENAI_API_KEY", "PLATFORM_DEEPSEEK_API_KEY", "PLATFORM_KIMI_API_KEY", "PLATFORM_MINIMAX_API_KEY", "PLATFORM_GEMINI_API_KEY", "PLATFORM_ANTHROPIC_API_KEY"]) env[key] = dummy;
env.PLATFORM_OLLAMA_BASE_URL = "http://127.0.0.1:1";
console.log(`[break-server] data copy: ${dataDir}`);
const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "dev", "-p", port], { env, stdio: "inherit", shell: process.platform === "win32" });
child.on("exit", (code) => process.exit(code ?? 0));
