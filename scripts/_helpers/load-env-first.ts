/**
 * load-env-first.ts — put `.env` into the environment before anything reads it.
 *
 * WHY THIS FILE EXISTS (N-ENV-2, 2026-08-26)
 * -----------------------------------------
 * A standalone `tsx` script does NOT load `.env`. Until now the operator-facing
 * scripts got it anyway, by accident: they import the repository bundle, which
 * imports `@prisma/client`, and the Prisma client loads `.env` when it is
 * imported. Nobody wrote that down because nobody chose it.
 *
 * Prisma skips that load when `DATABASE_URL` is ALREADY set in the environment,
 * on the reasonable assumption that a configured environment needs no file. A
 * container sets `DATABASE_URL` as an environment variable — that is how you
 * configure one — so on the deployment shape we actually ship (decision D3),
 * the accident stops happening and `.env` is never read at all.
 *
 * The visible symptom, reproduced before this file was written:
 *
 *   AUTH_MODE=production npx tsx scripts/bootstrap-owner.ts
 *     -> ERROR: --email <valid-email> is required.        (env was fine)
 *
 *   AUTH_MODE=production DATABASE_URL=... npx tsx scripts/bootstrap-owner.ts
 *     -> ERROR: AUTH_SESSION_SECRET must be set and at least 32 characters
 *
 * Same machine, same `.env`, one extra variable. The second is what a new
 * operator sees on their first command, and the message sends them looking for
 * a setting that is already sitting in their config file.
 *
 * WHY A SIDE-EFFECT IMPORT AND NOT A FUNCTION CALL
 * -----------------------------------------------
 * ES module imports are hoisted: every `import` in a file is evaluated before
 * the first statement of that file's body runs. So a script cannot load `.env`
 * from inside its own `main()`, or even from a top-level call — by then the
 * modules it imported have already read (or failed to read) the environment.
 * Importing THIS module first works because import evaluation follows source
 * order, so its top-level code runs before the imports below it.
 *
 * Use it as the FIRST import in the file:
 *
 *     import "./_helpers/load-env-first";
 *     import { bootstrapOwner } from "../src/lib/auth-service";
 *
 * PRECEDENCE. Same rule dotenv uses, and the same rule the previous accident
 * had: a variable already present in the real environment WINS over the file.
 * An operator who exports `AUTH_MODE=production` for one command still gets
 * production, even though `.env` says demo.
 *
 * SAFETY. Values are never logged. `.env` carries a database password and live
 * API keys, and a script that prints its own config is a script that pastes
 * credentials into a terminal history.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env");

if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(rawLine);
    if (!match) continue; // comment, blank, or a form this loader does not support
    const [, name, rawValue] = match;
    if (name in process.env) continue; // the real environment wins
    process.env[name] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
}

export {};
