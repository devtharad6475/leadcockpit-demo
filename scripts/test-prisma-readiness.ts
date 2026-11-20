const databaseUrl = process.env.DATABASE_URL;
const persistenceProvider = process.env.PERSISTENCE_PROVIDER || "json";

console.log("Prisma readiness check");
console.log(`PERSISTENCE_PROVIDER=${persistenceProvider}`);

if (!databaseUrl) {
  console.log("DATABASE_URL is not set. Prisma runtime test cannot run yet.");
  console.log("Set DATABASE_URL, run Prisma migration, run JSON import dry-run, then test with PERSISTENCE_PROVIDER=prisma.");
  process.exit(0);
}

if (databaseUrl.includes("user:pass@localhost")) {
  console.log("DATABASE_URL is the placeholder value. Replace it with a real local PostgreSQL database URL before runtime testing.");
  process.exit(0);
}

console.log("DATABASE_URL is present and does not look like the placeholder.");
console.log("Next commands:");
console.log("  npx prisma migrate dev --name init");
console.log("  npm run db:import-json -- --dry-run");
console.log("  $env:PERSISTENCE_PROVIDER='prisma'; npm run dev");
