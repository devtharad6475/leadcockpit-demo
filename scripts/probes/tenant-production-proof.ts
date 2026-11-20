/**
 * PROBE — does this product actually work for a REAL customer? (P0-TENANT)
 *
 * Everything about the P0-TENANT fix has so far been verified in DEMO mode,
 * which is the one mode in which the bug cannot appear: demo mode returns early
 * from resolveMutationWorkspace and never compares the body's workspace to the
 * session's, so the old hardcoded "workspace_demo" was correct by accident.
 * That is precisely how this survived a month of testing.
 *
 * This probe runs the thing that actually matters: AUTH_MODE=production, two
 * real tenants signed up through the product's own signup endpoint, and the same
 * write issued three ways.
 *
 *   body says MY workspace      -> 200   the fix; what the browser now sends
 *   body says "workspace_demo"  -> 403   what the browser used to send, for all 90 call sites
 *   body says THEIR workspace   -> 403   July's cross-tenant guard, still intact
 *
 * The middle row is the whole before/after in one line.
 *
 * It is a PROBE, not a golden: it needs a server running in production mode on a
 * port it does not control, so it cannot be a member of the regression suite.
 * Once it passes, the outcomes get pinned by golden-tenant-production-mode.ts.
 *
 * Usage:  npx tsx scripts/probes/tenant-production-proof.ts http://localhost:3021
 *
 * SAFETY
 *  - Fixture passwords are generated here with crypto.randomBytes, live only in
 *    this process's memory, and are NEVER printed, logged or written to disk.
 *    They are throwaway credentials for a local dev database and are handled
 *    like real ones anyway.
 *  - Contact details are unroutable BY CONSTRUCTION (N-SAFETY-1): RFC 2606
 *    `.example` domains, and phone numbers in the reserved +91 00000 000NN
 *    block. Nothing seeded here can be messaged by accident.
 */
import { randomBytes } from "node:crypto";

const BASE = process.argv[2] || "http://localhost:3021";

/** A fresh password per run. Never leaves this process. */
function throwawayPassword(): string {
  return `Fx-${randomBytes(24).toString("base64url")}`;
}

type Jar = { cookie: string };

async function call(
  path: string,
  init: { method?: string; body?: unknown; jar?: Jar } = {},
): Promise<{ status: number; json: Record<string, unknown>; setCookie: string[] }> {
  // Origin is not optional here. In production mode src/lib/csrf.ts rejects any
  // state-changing request that carries neither Origin nor Referer, because a
  // real browser always sends one. Without this every POST below would come
  // back 403 CSRF_REJECTED and look exactly like the tenant block it is meant
  // to be measuring. Sending the same Origin a browser would send is faithful
  // to the real request, not a way around the check.
  const headers: Record<string, string> = { "content-type": "application/json", origin: BASE };
  if (init.jar?.cookie) headers.cookie = init.jar.cookie;
  const res = await fetch(`${BASE}${path}`, {
    method: init.method || "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "manual",
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    // Some failures return HTML. The status is what this probe asserts on.
  }
  return { status: res.status, json: parsed, setCookie: res.headers.getSetCookie?.() ?? [] };
}

/** Keep only the name=value pairs; the attributes would confuse the server. */
function jarFrom(setCookie: string[]): Jar {
  return { cookie: setCookie.map((c) => c.split(";")[0]).join("; ") };
}

type Tenant = { label: string; email: string; workspaceId: string; jar: Jar };

async function signUp(label: string, email: string, businessName: string): Promise<Tenant> {
  const password = throwawayPassword();
  const res = await call("/api/auth/signup", {
    method: "POST",
    body: { email, password, name: `${businessName} Owner`, businessName },
  });

  if (res.status !== 200 && res.status !== 201) {
    // 409 means a previous run already created it — sign in instead of failing.
    const login = await call("/api/auth/login", { method: "POST", body: { email, password } });
    if (login.status !== 200) {
      throw new Error(
        `could not create OR sign in tenant ${label}. signup=${res.status} ` +
          `${JSON.stringify(res.json)} login=${login.status}. If signup said 409, an earlier run left ` +
          "this tenant behind with a DIFFERENT throwaway password — drop the fixture rows and re-run.",
      );
    }
    const jar = jarFrom(login.setCookie);
    const status = await call("/api/auth/status", { jar });
    return { label, email, workspaceId: String((status.json.user as { workspaceId?: string })?.workspaceId ?? ""), jar };
  }

  const jar = jarFrom(res.setCookie);
  const status = await call("/api/auth/status", { jar });
  const user = status.json.user as { workspaceId?: string } | undefined;
  const workspaceId = user?.workspaceId ?? "";
  if (!workspaceId) {
    throw new Error(
      `tenant ${label} signed up but /api/auth/status reports no workspace on the session ` +
        `(${JSON.stringify(status.json)}). That is the exact condition adoptWorkspaceId returns false for.`,
    );
  }
  return { label, email, workspaceId, jar };
}

/** One manual-lead write, with whatever workspace the caller wants in the body. */
async function writeAs(tenant: Tenant, bodyWorkspaceId: string, marker: string) {
  return call("/api/leads/manual", {
    method: "POST",
    jar: tenant.jar,
    body: {
      workspaceId: bodyWorkspaceId,
      companyName: marker,
      email: `buyer@${marker.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.example`,
      phone: "+91 00000 00042",
    },
  });
}

let failures = 0;
function check(label: string, actual: number, expected: number, detail: string) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}\n        expected ${expected}, got ${actual} — ${detail}`);
}

async function main() {
  console.log(`\nP0-TENANT production-mode proof against ${BASE}\n`);

  const mode = await call("/api/auth/status");
  const authMode = mode.json.authMode;
  console.log(`  server reports authMode: ${JSON.stringify(authMode)}`);
  if (authMode !== "production") {
    console.error(
      `\nREFUSING TO RUN. This probe only means something in production mode; in demo mode the check it\n` +
        `exercises is deliberately bypassed and every assertion below would pass for the wrong reason.\n` +
        `Start the server with AUTH_MODE=production and point this probe at it.\n`,
    );
    process.exit(2);
  }

  const acme = await signUp("acme", "owner@acme-pipes.example", "Acme Pipes");
  const borealis = await signUp("borealis", "owner@borealis-chem.example", "Borealis Chemicals");
  console.log(`  tenant A ${acme.label}: workspace ${acme.workspaceId}`);
  console.log(`  tenant B ${borealis.label}: workspace ${borealis.workspaceId}`);
  if (acme.workspaceId === borealis.workspaceId) {
    console.error("\nBoth tenants landed in the SAME workspace. Multi-tenancy is broken at signup.\n");
    process.exit(1);
  }

  console.log("\n  --- the three writes, all from Acme's session ---");

  const own = await writeAs(acme, acme.workspaceId, "Acme Own Workspace Write");
  check(
    "body carries the session's OWN workspace",
    own.status,
    200,
    "this is what the browser sends after the fix. A 403 here means the product is still broken for real customers.",
  );

  const demo = await writeAs(acme, "workspace_demo", "Acme Hardcoded Demo Write");
  check(
    'body carries the hardcoded "workspace_demo"',
    demo.status,
    403,
    "this is exactly what all 90 UI call sites sent BEFORE the fix. A 403 here is the bug, reproduced on demand.",
  );

  const cross = await writeAs(acme, borealis.workspaceId, "Acme Cross Tenant Write");
  check(
    "body carries ANOTHER tenant's workspace",
    cross.status,
    403,
    "July's cross-tenant guard. If this ever returns 200, one customer can write into another's account.",
  );

  console.log("\n  --- and the data actually landed where it should ---");

  const acmeLeads = await call("/api/leads", { jar: acme.jar });
  const borealisLeads = await call("/api/leads", { jar: borealis.jar });
  const nameOf = (rows: unknown) =>
    Array.isArray(rows) ? rows.map((r) => String((r as { companyName?: string }).companyName ?? "")) : [];
  const acmeNames = nameOf(acmeLeads.json);
  const borealisNames = nameOf(borealisLeads.json);

  const acmeSees = acmeNames.includes("Acme Own Workspace Write");
  const borealisSees = borealisNames.includes("Acme Own Workspace Write");
  console.log(`  ${acmeSees ? "PASS" : "FAIL"}  Acme can see the lead it just created (${acmeNames.length} leads)`);
  console.log(
    `  ${!borealisSees ? "PASS" : "FAIL"}  Borealis CANNOT see Acme's lead (${borealisNames.length} leads)` +
      (borealisSees ? " — CROSS-TENANT READ LEAK" : ""),
  );
  if (!acmeSees) failures += 1;
  if (borealisSees) failures += 1;

  console.log(
    failures === 0
      ? "\nALL GREEN — the product works for a real customer, and the two tenants cannot reach each other.\n"
      : `\n${failures} CHECK(S) FAILED. Stage 1 is not done.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  // Exit 1, not 0. A probe that could not run must never report "fine".
  console.error("\nPROBE COULD NOT COMPLETE:", error instanceof Error ? error.message : error, "\n");
  process.exit(1);
});
