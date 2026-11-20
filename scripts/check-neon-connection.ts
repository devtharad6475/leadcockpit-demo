/**
 * One-off Stage A.0 verification: prove the Neon DATABASE_URL in .env is
 * reachable from this machine via Prisma. Does NOT mutate the database —
 * runs SELECT 1, prints server time + database name, disconnects.
 *
 * Usage: npx tsx scripts/check-neon-connection.ts
 */
export {};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("FAIL: DATABASE_URL is not set in the environment.");
    process.exit(1);
  }
  // Sanity: avoid silently hitting the localhost placeholder.
  if (url.includes("localhost") || url.includes("postgres:postgres@")) {
    console.error("FAIL: DATABASE_URL still points at the localhost placeholder. Paste your Neon URL into .env.");
    process.exit(1);
  }
  console.log("DATABASE_URL present, host:", url.match(/@([^/?#]+)/)?.[1] ?? "(unparseable)");
  console.log("Connecting to Neon via Prisma...");

  const { PrismaClient } = await import("../src/generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  const t0 = Date.now();
  try {
    const rows = (await prisma.$queryRawUnsafe(
      "SELECT 1 AS ok, NOW() AS server_time, current_database() AS db_name, version() AS pg_version"
    )) as Array<{ ok: unknown; server_time: Date; db_name: string; pg_version: string }>;
    const elapsed = Date.now() - t0;
    console.log("✅ CONNECTED in", elapsed, "ms");
    console.log("   Server time:", rows[0].server_time.toISOString());
    console.log("   Database:", rows[0].db_name);
    console.log("   Postgres version:", rows[0].pg_version.split(",").slice(0, 2).join(","));
    console.log("\nConnection is good. Ready for A.1.");
  } catch (e) {
    console.error("❌ CONNECTION FAILED:", e instanceof Error ? `${e.name}: ${e.message}` : e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
