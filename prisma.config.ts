import { defineConfig } from "prisma/config";
import { existsSync, readFileSync } from "node:fs";

// Load .env so `npx prisma migrate/generate/db` commands read DATABASE_URL
// the same way the Next.js dev server does. Prisma CLI does NOT auto-load .env
// when prisma.config.ts is present (it reads prisma.config.ts instead), so
// without this every `prisma migrate` command fails with the placeholder URL.
// Guarded with existsSync so a fresh clone without .env still works.
if (!process.env.DATABASE_URL) {
  try {
    const envPath = ".env";
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
    // Missing .env is fine — falls back to the placeholder below.
  }
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/leadgen_placeholder",
  },
});
