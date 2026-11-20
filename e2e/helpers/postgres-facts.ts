/**
 * postgres-facts.ts — read the ship database DIRECTLY, so the prod-prisma smoke
 * can assert "what is in Postgres is what is on the screen".
 *
 * WHY THIS EXISTS (2026-08-19, CEO-loop session 7).
 *
 * `prod-prisma-smoke.spec.ts` used to hard-code the values it expected to see:
 * "Balaji Zari Udyog", "Aarna Bridal Studio", "10,000". Those came from
 * `scripts/seed-demo-prisma.ts`, and when the seed rows were purged and the
 * real demo data set was migrated in, three of its five tests were asserting
 * against rows that no longer existed. Two of them still passed — by luck, on
 * strings the new data set happened to share — which is the worse outcome: a
 * green smoke test proving nothing.
 *
 * Hard-coding is what made that possible, so the fix is to stop hard-coding.
 * The spec now reads the expected values out of Postgres at run time and
 * asserts THOSE render. Change the data set again and the spec follows it.
 *
 * WHY RAW SQL AND NOT THE REPOSITORY LAYER. The thing under test is the path
 * `Postgres → Prisma repositories → API → screen`. Reading the expected values
 * through the same repositories would let a bug in them cancel itself out on
 * both sides of the assertion. `pg` talks to the database and nothing else.
 *
 * Reads only. Never writes.
 */
import { Client } from "pg";
import { loadEnvConfig } from "@next/env";
import { REPO_ROOT } from "./data-dir";

export type PostgresFacts = {
  workspaceName: string;
  leadNames: string[];
  /** Grand totals as the UI groups them, e.g. 6000 → "6,000". */
  orderTotalsGrouped: string[];
  quoteTotalsGrouped: string[];
  /** Inbound messages on auto_reply_logs — what the Replies inbox renders. */
  incomingMessages: string[];
};

/** Indian digit grouping, integer part only — matches formatINR's "₹6,000.00". */
function groupINR(n: number): string {
  return n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

/**
 * Playwright does not load `.env`; Next does. Use Next's own loader so the test
 * resolves DATABASE_URL exactly the way the server under test resolved it —
 * pointing the two at different databases would make every assertion a lie.
 */
export async function readPostgresFacts(): Promise<PostgresFacts> {
  loadEnvConfig(REPO_ROOT);
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. This spec asserts that real Postgres rows render, " +
        "so it cannot run without the database the server is reading.",
    );
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const one = async <T>(sql: string): Promise<T[]> => (await client.query(sql)).rows as T[];

    const ws = await one<{ name: string }>(`SELECT name FROM workspaces ORDER BY id LIMIT 1`);
    if (ws.length === 0) {
      throw new Error(
        "No workspaces in Postgres. Either the migration has not been run against this " +
          "database (npm run migrate:json-to-postgres) or DATABASE_URL points somewhere empty.",
      );
    }

    const leads = await one<{ company_name: string | null }>(
      `SELECT company_name FROM leads WHERE company_name IS NOT NULL ORDER BY company_name`,
    );
    const orders = await one<{ grand_total: string }>(
      `SELECT grand_total FROM orders ORDER BY order_number`,
    );
    const quotes = await one<{ grand_total: string }>(
      `SELECT grand_total FROM quotes ORDER BY quote_number`,
    );
    const logs = await one<{ incoming_message: string | null }>(
      `SELECT incoming_message FROM auto_reply_logs WHERE incoming_message IS NOT NULL`,
    );

    return {
      workspaceName: ws[0].name,
      leadNames: leads.map((r) => r.company_name!),
      // NUMERIC comes back from pg as a string, deliberately (it does not fit a
      // JS number in the general case). Number() is safe for rupee totals.
      orderTotalsGrouped: orders.map((r) => groupINR(Number(r.grand_total))),
      quoteTotalsGrouped: quotes.map((r) => groupINR(Number(r.grand_total))),
      incomingMessages: logs.map((r) => r.incoming_message!),
    };
  } finally {
    await client.end();
  }
}

/** Regex-escape, so a company name containing "(" or "." cannot break the match. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `/a|b|c/i` over the given strings — "at least one of these must render". */
export function anyOf(values: string[]): RegExp {
  if (values.length === 0) {
    throw new Error("anyOf() called with nothing to match — the query returned no rows");
  }
  return new RegExp(values.map(escapeRegex).join("|"), "i");
}
