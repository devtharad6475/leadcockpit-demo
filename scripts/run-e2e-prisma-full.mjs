/**
 * run-e2e-prisma-full.mjs — `npm run test:e2e:prisma-full`.
 *
 * Runs the MUTATING e2e specs against Postgres instead of the JSON substrate,
 * which is the blind spot playwright.config.ts documents: production runs on
 * Postgres, and until this existed the behaviour of every button was only ever
 * proven on JSON.
 *
 * It never points at the operator's database. The fixture database is built by
 * `npm run e2e:pg-fixture`, which writes its URL to .env.e2e-pg; this refuses to
 * start if that file is missing rather than falling back to .env — the fallback
 * is exactly the accident the whole two-server split exists to prevent.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const URL_FILE = path.join(process.cwd(), ".env.e2e-pg");
if (!existsSync(URL_FILE)) {
  console.error(
    "No .env.e2e-pg found. Build the disposable fixture database first:\n\n  npm run e2e:pg-fixture\n\n" +
      "Refusing to fall back to DATABASE_URL from .env — that is the operator's database, and\n" +
      "the mutating specs would create and delete rows in it with nothing restoring anything.",
  );
  process.exit(1);
}

const match = /^DATABASE_URL=(.*)$/m.exec(readFileSync(URL_FILE, "utf8"));
if (!match) {
  console.error(".env.e2e-pg exists but has no DATABASE_URL. Re-run: npm run e2e:pg-fixture");
  process.exit(1);
}

const child = spawn("npx", ["playwright", "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: {
    ...process.env,
    E2E_TARGET: "prisma",
    E2E_PRISMA_FULL: "1",
    E2E_PG_URL: match[1].trim(),
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
