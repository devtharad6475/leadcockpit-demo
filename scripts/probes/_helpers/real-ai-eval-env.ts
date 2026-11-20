/**
 * real-ai-eval-env.ts — preload for scripts/probes/real-ai-eval.ts.
 *
 * Must run as a --import preload: src/lib/db.ts reads LEADGEN_DATA_DIR into a
 * module-level const at import time.
 *
 *   - Loads the MAIN project's .env (the worktree has none, and it must never be
 *     copied into one). Path comes from REAL_AI_EVAL_ENV_FILE or the default below.
 *     Values are only placed in process.env — never printed or written anywhere.
 *   - Forces the JSON store into a fresh temp directory. Whatever .env says,
 *     this can never reach Postgres.
 *   - Fakes the WhatsApp credentials (the eval stubs graph.facebook.com and
 *     captures every send) and switches off the per-message background AI
 *     calls (customer memory, discovery) so the call budget measures replies.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const envFile = process.env.REAL_AI_EVAL_ENV_FILE
  || "C:\\Users\\Admin\\Desktop\\Development phase\\Lead Generator\\.env";
try { process.loadEnvFile(envFile); } catch { console.log("[eval] no .env loaded — real calls will fall back to mock"); }

process.env.PERSISTENCE_PROVIDER = "json";
delete process.env.DATABASE_URL;
delete process.env.DIRECT_URL;
delete process.env.RESEND_API_KEY;
delete process.env.AI_USAGE_CAPS;
delete process.env.LEADGEN_AGENTIC_RETRIEVAL;
process.env.LEADGEN_LEAD_MEMORY = "0";
process.env.LEADGEN_DISCOVERY_LISTEN = "0";
process.env.AUTH_MODE = "demo";
process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = "fake-token-for-eval";
process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = "123";
delete process.env.WHATSAPP_ALLOW_REAL_SEND_DISABLED;

const dir = path.join(os.tmpdir(), "leadgen-real-ai-eval", `run-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
process.env.LEADGEN_DATA_DIR = dir;
process.env.REAL_AI_EVAL_DATA_DIR = dir;
