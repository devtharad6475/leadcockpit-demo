#!/usr/bin/env tsx
/**
 * bootstrap-admin.ts — Stage 5 / WP3 CLI for creating a PlatformAdmin (operator).
 *
 * The operator admin panel (/admin/*) is production-only and requires a
 * PlatformAdmin account. This CLI creates the first one (or an additional
 * support_agent). Mirrors the proven bootstrap-owner.ts pattern: refuses if the
 * email already exists, fails loudly on missing env, atomic write.
 *
 * Usage:
 *   npx tsx scripts/bootstrap-admin.ts \
 *     --email you@yourcompany.in \
 *     --password '...' \
 *     --name "Your Name" \
 *     --role operator   # or support_agent (default: operator)
 *
 * Env (must be set BEFORE running, same as the dev server):
 *   AUTH_MODE=production                # required (admin panel is production-only)
 *   PLATFORM_ADMIN_SESSION_SECRET=<32+> # required in production (falls back to AUTH_SESSION_SECRET)
 *   ENCRYPTION_KEY=<16+ chars>          # required to save credentials in prod
 *   PERSISTENCE_PROVIDER=prisma         # optional (default json); prisma needs DATABASE_URL
 *
 * Exit codes:
 *   0 — admin created (or already existed and --allow-existing was passed)
 *   1 — admin with that email already exists (use --allow-existing to suppress)
 *   2 — missing env / bad args
 */
// N-ENV-2 (2026-08-26): FIRST import, deliberately. `.env` used to arrive here
// by accident, as a side effect of Prisma being imported - and Prisma skips that
// load when DATABASE_URL is already set, which is exactly what a container does.
// See scripts/_helpers/load-env-first.ts.
import "./_helpers/load-env-first";
import { bootstrapPlatformAdmin } from "../src/services/PlatformAdminAuthService";
import { getAuthMode } from "../src/lib/auth";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(`Usage: npx tsx scripts/bootstrap-admin.ts --email <email> --password <password> [--name <name>] [--role operator|support_agent] [--allow-existing]

Required:
  --email       Admin email (also the login username)
  --password    Admin password (min 8 chars)

Optional:
  --name              Display name (defaults to "Operator")
  --role              operator (default, full power) | support_agent (tickets only)
  --allow-existing    Exit 0 even if an admin with this email already exists
  --help, -h          Show this help

Environment (must match the dev/prod server):
  AUTH_MODE=production                          required (admin panel is production-only)
  PLATFORM_ADMIN_SESSION_SECRET=<32+ chars>    required in production (falls back to AUTH_SESSION_SECRET)
  ENCRYPTION_KEY=<16+ chars>                   required to save the credential in production
  PERSISTENCE_PROVIDER=prisma                  optional (default json); prisma also needs DATABASE_URL
`);
    process.exit(0);
  }

  // --- Validate env (fail loudly, never silently) ---
  const mode = getAuthMode();
  if (mode !== "production") {
    console.error(`ERROR: AUTH_MODE is "${mode}", not "production". The admin panel is production-only; bootstrap does nothing in demo mode.`);
    console.error("       Set AUTH_MODE=production plus PLATFORM_ADMIN_SESSION_SECRET (or AUTH_SESSION_SECRET) + ENCRYPTION_KEY, then re-run.");
    process.exit(2);
  }
  const sessionSecret = process.env.PLATFORM_ADMIN_SESSION_SECRET || process.env.AUTH_SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    console.error("ERROR: PLATFORM_ADMIN_SESSION_SECRET (or AUTH_SESSION_SECRET) must be set and at least 32 characters in production mode.");
    process.exit(2);
  }
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 16) {
    console.error("ERROR: ENCRYPTION_KEY must be set and at least 16 characters in production mode.");
    process.exit(2);
  }
  if (process.env.PERSISTENCE_PROVIDER === "prisma" && !process.env.DATABASE_URL) {
    console.error("ERROR: PERSISTENCE_PROVIDER=prisma but DATABASE_URL is not set.");
    process.exit(2);
  }

  // --- Validate args ---
  const email = args.email;
  const password = args.password;
  if (!email || !email.includes("@")) {
    console.error("ERROR: --email <valid-email> is required.");
    process.exit(2);
  }
  if (!password || password.length < 8) {
    console.error("ERROR: --password <min-8-chars> is required.");
    process.exit(2);
  }
  const role = args.role === "support_agent" ? "support_agent" : "operator";
  const name = args.name || (role === "operator" ? "Operator" : "Support Agent");

  console.log(`bootstrap-admin: creating ${role} ${email} (persistence=${process.env.PERSISTENCE_PROVIDER || "json"})...`);

  try {
    const admin = await bootstrapPlatformAdmin({ email, password, name, role });
    console.log(`✅ Platform admin created: id=${admin.id}, email=${admin.email}, role=${admin.role}, status=${admin.status}`);
    console.log("   You can now sign in at /admin with this email + password.");
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists/i.test(message)) {
      console.error(`NOTE: an admin with this email already exists. Use a different email, or pass --allow-existing to suppress this exit code.`);
      process.exit(args["allow-existing"] ? 0 : 1);
    }
    console.error(`ERROR: bootstrap failed: ${message}`);
    process.exit(1);
  }
}

main();
