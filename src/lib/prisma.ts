// Load .env so standalone `tsx` scripts (db:check, db:import-json,
// bootstrap:owner, prisma smokes/goldens) read DATABASE_URL the same way the
// Next.js dev server does. Node 24's process.loadEnvFile() exists, but it
// THROWS on a missing .env — so we guard with existsSync. This MUST run before
// the PrismaClient reads process.env.DATABASE_URL below. The Next.js dev server
// already loads .env itself, so this is a no-op there (we never overwrite an
// existing process.env value — `if (!(k in process.env))`).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

if (!process.env.DATABASE_URL) {
  try {
    // Resolve the project root: from this source file down 2 levels (src/lib -> root).
    const here = typeof __dirname !== "undefined"
      ? __dirname
      : dirname(fileURLToPath(import.meta.url));
    const envPath = join(here, "..", "..", ".env");
    if (existsSync(envPath)) {
      for (const rawLine of readFileSync(envPath, "utf8").split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*"?(.*?)"?\s*$/);
        if (match && !(match[1] in process.env)) {
          process.env[match[1]] = match[2];
        }
      }
    }
  } catch {
    // A missing/unreadable .env is fine — the app falls back to JSON demo mode.
  }
}

import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL || "postgresql://user:pass@localhost:5432/leadgen?schema=public",
});

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * Interactive-transaction options for every `prisma.$transaction(async (tx) => …)`.
 *
 * WHY THIS EXISTS (build-right ripple fix, 2026-07-31):
 * Prisma's DEFAULT interactive-transaction timeout is 5 seconds. That is too
 * short for this app: several writes bundle many upserts into one transaction
 * (e.g. `persistSnapshot` writes every changed record back to Postgres), and
 * under the high-latency link between the dev machine and the cloud DB the
 * whole batch can take ~30s. The 5s default then expires the transaction
 * before it commits, throwing `Transaction API error: … timeout for this
 * transaction was 5000 ms`. Two Prisma goldens
 * (`golden:prisma-commercial-parity`, `golden:webhook-dedup-prisma`) caught
 * this as a regression.
 *
 * This is the CHOKEPOINT: every `$transaction(async …)` call-site imports and
 * spreads `TX_OPTS` so the policy is defined in ONE place. A single value to
 * tune, not 8 magic numbers. `maxWait` = how long to wait for a connection
 * slot before giving up; `timeout` = how long the transaction body may run
 * before Prisma cancels it. 45s comfortably covers the largest observed
 * batch (~33s) while still failing fast on a genuinely stuck transaction.
 */
export const TX_OPTS = {
  maxWait: 10_000, // ms — wait up to 10s for a free connection slot
  timeout: 45_000, // ms — allow the transaction body up to 45s to commit
} as const;

/**
 * Interactive-transaction wrapper that bakes in {@link TX_OPTS}. This is the
 * CHOKEPOINT for transaction options: prefer `runTx(async (tx) => …)` over a
 * bare `prisma.$transaction(async …)`, so the timeout policy lives in ONE
 * place. The callback receives the transaction client as `unknown` to match
 * the existing cast convention in the Prisma repository
 * (`(tx as Record<string, Delegate>)["model"]`).
 */
const transactionContext = new AsyncLocalStorage<unknown>();

/** Repository delegates must use the current transaction, not the root pool. */
export function currentPrismaClient(): unknown {
  return transactionContext.getStore() ?? prisma;
}

export async function runTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const existing = transactionContext.getStore();
  if (existing) return fn(existing);
  return prisma.$transaction(tx => transactionContext.run(tx, () => fn(tx)), TX_OPTS);
}
