/**
 * isolate-copy-demo-data.ts — preload for scripts/probes/*.
 *
 * Same hoisting problem as scripts/golden/_helpers/isolate-json-data.ts (see
 * that file's header for the full explanation): src/lib/db.ts reads
 * LEADGEN_DATA_DIR into a module-level const at import time, so the env var
 * must be set by a --import preload, not inside the probe's own main().
 *
 * Differs from the golden helpers in two ways, both deliberate:
 *   1. It loads .env itself (process.loadEnvFile) — tsx does not auto-load
 *      .env, and the probes need PLATFORM_DEEPSEEK_API_KEY /
 *      PLATFORM_ANTHROPIC_API_KEY to reach the real providers.
 *   2. It COPIES the real .leadgen-data/app-data.json into the isolated
 *      directory instead of starting empty. Goldens want a blank slate; a
 *      real-AI proof pass wants the actual Balaji Zari Udyog seed data
 *      (leads, business profile, KB chunks) so the model has real context to
 *      be grounded in and a human can judge whether the output is good.
 *
 * The isolated copy means this can never touch the shared demo file, no
 * matter what the probe does to llmModelRoutings or anything else — the
 * F-P0-5 lesson (2026-08-05 self-inflicted pollution incident) applies here
 * even though this is a new script tree.
 */
import fsSync from "node:fs";
import os from "node:os";
import pathMod from "node:path";

try { process.loadEnvFile(pathMod.resolve(process.cwd(), ".env")); } catch { /* no .env, fine */ }

process.env.PERSISTENCE_PROVIDER = "json";

const tempRoot = pathMod.join(os.tmpdir(), "leadgen-probe-data");
const isolatedDir = pathMod.join(tempRoot, `proof-pass-${process.pid}-${Date.now()}`);
fsSync.mkdirSync(isolatedDir, { recursive: true });

const sourceFile = pathMod.resolve(process.cwd(), ".leadgen-data", "app-data.json");
const destFile = pathMod.join(isolatedDir, "app-data.json");
fsSync.copyFileSync(sourceFile, destFile);

process.env.LEADGEN_DATA_DIR = isolatedDir;
// Surfaced so the probe's own log header can print exactly where it's reading from.
process.env.PROBE_ISOLATED_DIR = isolatedDir;
