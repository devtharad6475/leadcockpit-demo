/**
 * Production-readiness gate.
 *
 * Phase 1.7 audit fix: now checks the ACTUAL auth provider this codebase uses
 * (AUTH_SESSION_SECRET), not legacy NextAuth/Clerk. In --strict mode, also
 * scans the data store for real users and unencrypted credentials, and exits 1
 * on any gap regardless of AUTH_MODE.
 *
 * Usage:
 *   npx tsx scripts/check-production-readiness.ts          # report only
 *   npx tsx scripts/check-production-readiness.ts --strict # exit 1 on any fail
 */

// Load .env so this standalone `tsx` script reads the same config the Next.js
// dev server does (tsx does NOT auto-load .env). Guarded so a missing .env is
// fine. Never overwrites an existing process.env value.
import { existsSync, readFileSync } from "node:fs";
if (existsSync(".env")) {
  for (const rawLine of readFileSync(".env", "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*"?(.*?)"?\s*$/);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2];
    }
  }
}

export {};

type Check = { name: string; status: "pass" | "warn" | "fail"; message: string };

function hasValue(value: string | undefined) {
  return Boolean(value && value.trim() && !value.includes("changeme") && !value.includes("placeholder"));
}

const isStrict = process.argv.includes("--strict");
const checks: Check[] = [];
const authMode = process.env.AUTH_MODE || "demo";
const persistence = process.env.PERSISTENCE_PROVIDER || "json";
const nodeEnv = process.env.NODE_ENV || "development";

checks.push({
  name: "AUTH_MODE",
  status: authMode === "production" ? "pass" : "fail",
  message: authMode === "production" ? "Production auth mode requested." : "AUTH_MODE is not production.",
});

// Phase 1.4: check the ACTUAL provider — AUTH_SESSION_SECRET (not legacy).
checks.push({
  name: "Session secret",
  status: hasValue(process.env.AUTH_SESSION_SECRET) && String(process.env.AUTH_SESSION_SECRET).length >= 32 ? "pass" : "fail",
  message: "AUTH_SESSION_SECRET must be a random value of at least 32 characters (the built-in session auth provider).",
});

checks.push({
  name: "Persistence provider",
  status: persistence === "prisma" ? "pass" : "fail",
  message: persistence === "prisma" ? "Prisma requested." : "Production should use PERSISTENCE_PROVIDER=prisma after real DB testing.",
});

checks.push({
  name: "DATABASE_URL",
  status: hasValue(process.env.DATABASE_URL) ? "pass" : "fail",
  message: "PostgreSQL DATABASE_URL must point to a real production database.",
});

// 2026-09-27 (CEO): AI usage caps are off while the product is being built.
// They must be on before customers get the product.
checks.push({
  name: "AI_USAGE_CAPS",
  status: (process.env.AI_USAGE_CAPS || "").trim().toLowerCase() === "on" ? "pass" : "fail",
  message: "AI usage caps are off (development). Set AI_USAGE_CAPS=on before giving the product to customers.",
});

checks.push({
  name: "ENCRYPTION_KEY",
  status: hasValue(process.env.ENCRYPTION_KEY) && String(process.env.ENCRYPTION_KEY).length >= 16 ? "pass" : "fail",
  message: "ENCRYPTION_KEY must be at least 16 characters to protect stored provider keys (AES-256-GCM).",
});

checks.push({
  name: "Webhook/API secrets",
  status: hasValue(process.env.INBOUND_WEBHOOK_SECRET) && hasValue(process.env.API_SHARED_SECRET) ? "pass" : "fail",
  message: "Configure inbound webhook and shared API secrets.",
});

checks.push({
  name: "WhatsApp webhook signature",
  status: hasValue(process.env.WHATSAPP_APP_SECRET) ? "pass" : "fail",
  message: "WHATSAPP_APP_SECRET is required to verify inbound webhook signatures (X-Hub-Signature-256).",
});

checks.push({
  name: "WhatsApp verify token",
  status: hasValue(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) ? "pass" : "fail",
  message: "WHATSAPP_WEBHOOK_VERIFY_TOKEN must be set (no longer has a default).",
});

checks.push({
  name: "NODE_ENV",
  status: nodeEnv === "production" ? "pass" : "warn",
  message: nodeEnv === "production" ? "Production Node environment." : "NODE_ENV is not production in this check.",
});

checks.push({
  name: "Rate limits",
  status: hasValue(process.env.RATE_LIMIT_BACKEND) ? "pass" : "warn",
  message: hasValue(process.env.RATE_LIMIT_BACKEND)
    ? `Rate-limit backend set (${process.env.RATE_LIMIT_BACKEND}).`
    : "In-memory demo rate limits exist; production should configure Redis/database-backed rate limits (RATE_LIMIT_BACKEND=redis + REDIS_URL).",
});

// Stage C.3 — Sentry monitoring (warn, not fail). Monitoring is strongly
// recommended but not a launch blocker (operator's risk tolerance per Q20's
// "backup is not a gate" principle applied to monitoring too).
checks.push({
  name: "Monitoring (Sentry)",
  status: hasValue(process.env.SENTRY_DSN) ? "pass" : "warn",
  message: hasValue(process.env.SENTRY_DSN)
    ? "Sentry DSN set — errors will flow to Sentry/GlitchTip."
    : "Sentry DSN not set — errors will only be in console logs. Set SENTRY_DSN (Sentry SaaS or self-hosted GlitchTip) before launch.",
});

// Stage 5 / WP5 (2026-07-29) — Operator alerting (warn, not fail). When
// unset, SEV1 incidents silently drop (routeAlert returns routed:false
// reason:"no_recipient"). The operator sees errors in Sentry + the in-app
// status page, but is NOT paged. Pair this with Sentry for full coverage.
checks.push({
  name: "Operator alerting (SEV1 email)",
  status: hasValue(process.env.OPERATOR_ALERT_EMAIL) ? "pass" : "warn",
  message: hasValue(process.env.OPERATOR_ALERT_EMAIL)
    ? `OPERATOR_ALERT_EMAIL set (${process.env.OPERATOR_ALERT_EMAIL}) — SEV1 incidents will page you.`
    : "OPERATOR_ALERT_EMAIL not set — SEV1 incidents will silently drop (routeAlert returns no_recipient). Set it to an address you check on a push-notification device before launch.",
});

// Stage C.2 — Worker process (informational warn). The in-process queue
// works for single-VPS; the durable worker is recommended for any
// multi-instance or retry/backoff requirement.
checks.push({
  name: "Worker process",
  status: hasValue(process.env.REDIS_URL) ? "pass" : "warn",
  message: hasValue(process.env.REDIS_URL)
    ? "REDIS_URL set — run `npm run worker` on the VPS for durable jobs (BullMQ)."
    : "No REDIS_URL — jobs use the in-process queue (lost on restart). Acceptable for demo/single-VPS; set REDIS_URL + run npm run worker for durability.",
});

// Stage D.6 — Deployment config (warn, not fail). BASE_URL is required by
// Caddy to provision a cert + by the WhatsApp webhook subscription. Without
// it the deploy is incomplete, but it's not a launch blocker in the same
// sense as missing auth — it's an ops step.
checks.push({
  name: "Deployment config (BASE_URL)",
  status: hasValue(process.env.BASE_URL) ? "pass" : "warn",
  message: hasValue(process.env.BASE_URL)
    ? `BASE_URL set (${process.env.BASE_URL}). Caddy will provision a cert for this domain.`
    : "BASE_URL not set — Caddy won't know which domain to provision a cert for. Set BASE_URL=https://your-domain.com in .env (Stage D).",
});

// 2026-08-04 (audit finding A): migration-drift gate. A committed-but-unapplied
// migration silently breaks features in the Prisma runtime — the Owner Copilot
// was completely non-functional for this exact reason (its chat tables existed
// in code/migrations but not in the connected DB). When DATABASE_URL is set we
// shell out to `prisma migrate status` and FAIL if any migration is pending.
// This catches the gap between "migration committed" and "migration applied".
if (hasValue(process.env.DATABASE_URL)) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("node:child_process") as { execSync: (cmd: string, opts: { encoding: BufferEncoding; stdio: string }) => string };
    const statusOut = execSync("npx prisma migrate status", { encoding: "utf8", stdio: "pipe" });
    const pending = /have not yet been applied/i.test(statusOut) || /following migrations.*not.*applied/i.test(statusOut);
    checks.push({
      name: "DB migration drift",
      status: pending ? "fail" : "pass",
      message: pending
        ? "Prisma reports UNAPPLIED migrations. Run `DATABASE_URL=... npx prisma migrate deploy` — features whose tables are pending will 500 at runtime."
        : "Database schema is up to date with prisma/migrations.",
    });
  } catch (error) {
    // `migrate status` exits non-zero when drift exists OR when it can't connect.
    const out = String((error as { stdout?: string; stderr?: string; message?: string }).stdout || (error as Error).message || "");
    const drift = /have not yet been applied/i.test(out);
    checks.push({
      name: "DB migration drift",
      status: drift ? "fail" : "warn",
      message: drift
        ? "Prisma reports UNAPPLIED migrations. Run `DATABASE_URL=... npx prisma migrate deploy`."
        : `Could not verify migration status: ${(error as Error).message?.slice(0, 120)}`,
    });
  }
}

// 2026-08-05 (audit finding F-13): SCHEMA-vs-MIGRATIONS drift gate.
//
// The check above answers "are all migration FILES applied to the DB?".
// It does NOT answer "does every field in schema.prisma HAVE a migration?" —
// and that second gap is the one that actually bit us. `AutoReplyLog
// .internalNote` was added to schema.prisma, to the TS type, to the Replies
// UI, and to AutoReplyLogPrismaRepository.updateNote(), but no migration was
// ever generated. `migrate status` happily reported "up to date" (every
// migration file WAS applied) while the column did not exist in Postgres and
// `updateNote` threw on every production call.
//
// This check closes that hole with a purely local, read-only comparison: for
// every model/field in schema.prisma, confirm the table/column name appears
// in the committed migration SQL. No database connection required, so it runs
// in CI and in demo mode too.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync, readdirSync } = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require("node:path") as typeof import("node:path");

  const schemaSrc: string = readFileSync("prisma/schema.prisma", "utf8");
  let migrationSql = "";
  for (const dir of readdirSync("prisma/migrations")) {
    try {
      migrationSql += readFileSync(nodePath.join("prisma/migrations", dir, "migration.sql"), "utf8") + "\n";
    } catch { /* migration_lock.toml and other non-dirs */ }
  }

  const scalarTypes = /^(String|Int|Float|Boolean|DateTime|Json|Decimal|BigInt|Bytes)$/;
  const missingColumns: string[] = [];
  const missingTables: string[] = [];

  for (const block of schemaSrc.split(/\nmodel\s+/).slice(1)) {
    const modelName = block.slice(0, block.indexOf(" ")).trim();
    const body = block.slice(block.indexOf("{") + 1, block.indexOf("\n}"));
    const tableMatch = body.match(/@@map\("([^"]+)"\)/);
    const table = tableMatch ? tableMatch[1] : modelName;
    if (!migrationSql.includes(`"${table}"`)) { missingTables.push(`${modelName} (table "${table}")`); continue; }
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const fieldMatch = line.match(/^(\w+)\s+(\w+)/);
      if (!fieldMatch) continue;
      const [, field, type] = fieldMatch;
      // Relation fields point at other models and have no column of their own.
      if (/^[A-Z]/.test(type) && !scalarTypes.test(type)) continue;
      const mapMatch = line.match(/@map\("([^"]+)"\)/);
      const column = mapMatch ? mapMatch[1] : field;
      if (!migrationSql.includes(`"${column}"`)) missingColumns.push(`${modelName}.${field} (column "${column}")`);
    }
  }

  const drifted = [...missingTables, ...missingColumns];
  checks.push({
    name: "Schema/migration drift",
    status: drifted.length > 0 ? "fail" : "pass",
    message: drifted.length > 0
      ? `${drifted.length} schema element(s) have NO migration and do not exist in Postgres: ${drifted.slice(0, 5).join(", ")}${drifted.length > 5 ? ` (+${drifted.length - 5} more)` : ""}. Generate a migration — the Prisma runtime will throw on any query touching them.`
      : "Every model and column in schema.prisma is covered by a committed migration.",
  });
} catch (error) {
  checks.push({
    name: "Schema/migration drift",
    status: "warn",
    message: `Could not compare schema.prisma against prisma/migrations: ${(error as Error).message?.slice(0, 120)}`,
  });
}

// --- Strict-mode checks: data-store integrity ---
if (isStrict) {
  try {
    // Use require (not top-level await import) — esbuild CJS doesn't support TLA.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync, existsSync } = require("node:fs");
    const dataPath = ".leadgen-data/app-data.json";
    if (existsSync(dataPath)) {
      const raw = readFileSync(dataPath, "utf8");
      const data = JSON.parse(raw);

      // Check for at least one real user credential (password hash).
      const credentials = data.userCredentials || [];
      const realCreds = credentials.filter((c: { passwordHash?: string }) => c.passwordHash && c.passwordHash.startsWith("scrypt:"));
      checks.push({
        name: "Real user exists",
        status: realCreds.length > 0 ? "pass" : "fail",
        message: realCreds.length > 0 ? `${realCreds.length} user credential(s) with real scrypt hashes.` : "No user credentials with real password hashes. Run bootstrap to create the owner.",
      });

      // Scan for unencrypted (legacy base64) credentials in storage.
      const allCreds = data.llmProviderCredentials || [];
      const insecure = allCreds.filter((c: { encryptedApiKey?: string }) => {
        const key = c.encryptedApiKey || "";
        return key.startsWith("demo_encrypted:") || key.startsWith("placeholder_encrypted_");
      });
      checks.push({
        name: "No legacy-insecure credentials",
        status: insecure.length === 0 ? "pass" : "fail",
        message: insecure.length === 0 ? "All stored credentials use AES-256-GCM." : `${insecure.length} credential(s) still use legacy base64/placeholder format. Re-save them to migrate.`,
      });
    } else {
      checks.push({ name: "Data store", status: "warn", message: "No .leadgen-data/app-data.json found (may be using Prisma)." });
    }
  } catch (error) {
    checks.push({ name: "Data store scan", status: "warn", message: `Could not scan data store: ${error instanceof Error ? error.message : "unknown error"}` });
  }
}

const failed = checks.filter((check) => check.status === "fail");
const warnings = checks.filter((check) => check.status === "warn");

console.log("LeadCockpit production-readiness check" + (isStrict ? " (--strict)" : ""));
console.table(checks);
console.log(`Critical blockers: ${failed.length}`);
console.log(`Warnings: ${warnings.length}`);

if (failed.length) {
  console.log("Do not go live until critical blockers are resolved.");
  // In strict mode, always exit 1 on failures. Otherwise, only in production env.
  if (isStrict || nodeEnv === "production" || authMode === "production") process.exitCode = 1;
}
