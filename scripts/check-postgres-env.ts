import { prisma } from "../src/lib/prisma";

function redactUrl(raw: string) {
  try {
    const url = new URL(raw);
    const password = url.password ? "****" : "";
    const user = url.username ? `${url.username}${password ? `:${password}` : ""}@` : "";
    return `${url.protocol}//${user}${url.host}${url.pathname}${url.search}`;
  } catch {
    return "(invalid DATABASE_URL)";
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.includes("user:pass@localhost") || databaseUrl.includes("leadgen_placeholder")) {
    console.log("DATABASE_URL is missing or placeholder. PostgreSQL runtime is not ready yet.");
    console.log("Set DATABASE_URL to a safe local/dev PostgreSQL database, then run:");
    console.log("  npx prisma migrate dev --name init");
    console.log("  npm run db:import-json -- --dry-run");
    console.log("  npm run test:prisma-runtime");
    return;
  }

  console.log(`DATABASE_URL target: ${redactUrl(databaseUrl)}`);
  try {
    await (prisma as unknown as { $queryRaw(strings: TemplateStringsArray): Promise<unknown> }).$queryRaw`SELECT 1`;
    console.log("Prisma connection check passed.");
  } finally {
    await (prisma as unknown as { $disconnect(): Promise<void> }).$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
