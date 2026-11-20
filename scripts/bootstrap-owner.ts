#!/usr/bin/env tsx
/**
 * bootstrap-owner.ts — Stage A.2 CLI for creating the first owner account.
 *
 * The web setup screen (production mode → "Set up the owner account") already
 * does this via POST /api/auth/bootstrap. This CLI is the headless mirror:
 * useful for CI, for scripted deployments, and for when you don't want to
 * open a browser. Calls the same `bootstrapOwner` function so behaviour is
 * identical to the web flow (atomic User + UserCredential + WorkspaceMember
 * write, refuses if an owner already exists).
 *
 * Usage:
 *   npx tsx scripts/bootstrap-owner.ts \
 *     --email owner@balajizari.in \
 *     --password '...' \
 *     --name "Balaji Owner" \
 *     --workspace-id ws_balaji_zari
 *
 * Env (must be set BEFORE running, same as the dev server):
 *   PERSISTENCE_PROVIDER=prisma        # or json (default)
 *   AUTH_MODE=production               # required so bootstrap doesn't no-op
 *   AUTH_SESSION_SECRET=<32+ chars>    # required in production mode
 *   ENCRYPTION_KEY=<16+ chars>         # required to save credentials in prod
 *   DATABASE_URL=<neon url>            # required when PERSISTENCE_PROVIDER=prisma
 *
 * Exit codes:
 *   0 — owner created (or already existed and --allow-existing was passed)
 *   1 — owner already exists (default; use --allow-existing to suppress)
 *   2 — missing env / bad args
 */
// N-ENV-2 (2026-08-26): FIRST import, deliberately. `.env` used to arrive here
// by accident, as a side effect of Prisma being imported - and Prisma skips that
// load when DATABASE_URL is already set, which is exactly what a container does.
// See scripts/_helpers/load-env-first.ts.
import "./_helpers/load-env-first";
import { bootstrapOwner, workspaceForNewOwner } from "../src/lib/auth-service";
import { getAuthMode } from "../src/lib/auth";
import { defaultWorkspaceId } from "../src/lib/db";

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
    console.log(`Usage: npx tsx scripts/bootstrap-owner.ts --email <email> --password <password> [--name <name>] [--workspace-id <id>] [--allow-existing]

Required:
  --email       Owner email (also the login username)
  --password    Owner password (min 8 chars)

Optional:
  --name              Owner display name (defaults to "Owner")
  --workspace-id      Workspace to attach the owner to (defaults to a NEW company of their own,
                      never the demo company the public tour shows)
  --allow-existing    Exit 0 even if an owner already exists (idempotent for scripts)
  --help, -h          Show this help

Environment (must match the dev/prod server):
  AUTH_MODE=production             required (otherwise bootstrap no-ops in demo mode)
  AUTH_SESSION_SECRET=<32+ chars>  required in production
  ENCRYPTION_KEY=<16+ chars>       required to save the credential in production
  PERSISTENCE_PROVIDER=prisma      optional (default json); prisma also needs DATABASE_URL
`);
    process.exit(0);
  }

  // --- Validate env (fail loudly, never silently) ---
  const mode = getAuthMode();
  if (mode !== "production") {
    console.error(`ERROR: AUTH_MODE is "${mode}", not "production". Bootstrap only creates a real owner in production mode (in demo it would no-op).`);
    console.error("       Set AUTH_MODE=production plus AUTH_SESSION_SECRET + ENCRYPTION_KEY, then re-run.");
    process.exit(2);
  }
  if (!process.env.AUTH_SESSION_SECRET || process.env.AUTH_SESSION_SECRET.length < 32) {
    console.error("ERROR: AUTH_SESSION_SECRET must be set and at least 32 characters in production mode.");
    process.exit(2);
  }
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 16) {
    console.error("ERROR: ENCRYPTION_KEY must be set and at least 16 characters in production mode (used to protect the credential).");
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

  // 2026-09-28 (S2): the owner gets their own new company unless one is named.
  // The demo company is what the public tour shows, so a real owner must not
  // land there by default.
  const requestedWorkspace = args["workspace-id"];
  if (requestedWorkspace === defaultWorkspaceId) {
    console.warn(`WARNING: ${defaultWorkspaceId} is the demo company. Once a real owner signs in there, the public demo tour is switched off for it.`);
  }
  const workspaceId = workspaceForNewOwner(requestedWorkspace);
  const name = args.name || "Owner";

  console.log(`bootstrap-owner: creating owner ${email} in workspace ${workspaceId} (persistence=${process.env.PERSISTENCE_PROVIDER || "json"})...`);

  try {
    const user = await bootstrapOwner({ email, password, name, workspaceId });
    console.log(`✅ Owner created: id=${user.id}, email=${user.email}, role=${user.role}, workspace=${user.workspaceId}`);
    console.log("   You can now sign in at the login screen with this email + password.");
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists/i.test(message)) {
      console.error(`NOTE: an owner account already exists. Sign in instead, or pass --allow-existing to suppress this exit code.`);
      process.exit(args["allow-existing"] ? 0 : 1);
    }
    console.error(`ERROR: bootstrap failed: ${message}`);
    process.exit(1);
  }
}

main();
