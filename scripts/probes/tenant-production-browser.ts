/**
 * PROBE — the BROWSER half of the P0-TENANT proof (runbook Step 4).
 *
 * tenant-production-proof.ts proves the SERVER: it refuses a body that names
 * the wrong workspace and accepts one that names the right one. What it cannot
 * prove is the half the bug actually lived in — whether the SHELL puts the
 * signed-in customer's workspace into those bodies at runtime. The golden
 * asserts that structurally (adopt happens before loadAll); only a real browser
 * against a real production-mode server shows it happening.
 *
 * So this drives the app the way a customer does and watches the wire:
 *
 *   1. every request the shell sends carries the SESSION's workspace
 *   2. not one of them carries "workspace_demo"
 *   3. not one comes back 403
 *   4. the app renders — no permanent "Opening your workspace…" spinner
 *
 * Point 2 is the whole bug: before the fix, all 90 write call sites sent the
 * hardcoded demo id, and in production every one of them was refused.
 *
 * Usage:  npx tsx scripts/probes/tenant-production-browser.ts http://localhost:3021
 *
 * SAFETY — why there is no password anywhere in this file's output
 *  A password is generated here, used once against the local dev server, and
 *  never printed, never written to disk, and never typed into a form. The login
 *  happens over the API inside this process; only the resulting session cookie
 *  is handed to the browser context, and that cookie is likewise never logged.
 *  Contact details are unroutable by construction (N-SAFETY-1): RFC 2606
 *  `.example` domains and the reserved +91 00000 000NN phone block.
 */
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";

const BASE = process.argv[2] || "http://localhost:3021";
const SESSION_COOKIE = "lc_session";

type Signed = { workspaceId: string; cookieValue: string };

/**
 * Create (or re-enter) a tenant over the API and return its session cookie.
 * Runs in THIS process so the password never reaches the browser or a log.
 */
async function signInFresh(email: string, businessName: string): Promise<Signed> {
  const password = `Fx-${randomBytes(24).toString("base64url")}`;
  const post = async (path: string, body: unknown) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify(body),
      redirect: "manual",
    });

  let res = await post("/api/auth/signup", { email, password, name: `${businessName} Owner`, businessName });
  if (res.status !== 200 && res.status !== 201) {
    res = await post("/api/auth/login", { email, password });
  }
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(
      `could not sign in ${email}: HTTP ${res.status}. A previous run may have created this tenant with a ` +
        "different throwaway password; use a fresh email or clear the fixture rows.",
    );
  }

  const cookieValue = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!cookieValue) throw new Error(`sign-in for ${email} returned no ${SESSION_COOKIE} cookie`);

  const status = await fetch(`${BASE}/api/auth/status`, { headers: { cookie: `${SESSION_COOKIE}=${cookieValue}` } });
  const json = (await status.json()) as { user?: { workspaceId?: string } };
  const workspaceId = json.user?.workspaceId ?? "";
  if (!workspaceId) throw new Error(`session for ${email} carries no workspace`);
  return { workspaceId, cookieValue };
}

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

async function main() {
  console.log(`\nP0-TENANT browser proof (production mode) against ${BASE}\n`);

  const mode = await (await fetch(`${BASE}/api/auth/status`)).json();
  console.log(`  server reports authMode: ${JSON.stringify((mode as { authMode?: string }).authMode)}`);
  if ((mode as { authMode?: string }).authMode !== "production") {
    console.error(
      "\nREFUSING TO RUN. In demo mode the shell is SUPPOSED to use the demo workspace, so every check below\n" +
        "would pass while proving nothing. Start the server with AUTH_MODE=production.\n",
    );
    process.exit(2);
  }

  // A tenant of its own per run, so a stale fixture password can never block this.
  const stamp = randomBytes(4).toString("hex");
  const tenant = await signInFresh(`owner-${stamp}@acme-pipes.example`, `Acme Pipes ${stamp}`);
  console.log(`  signed in; session workspace: ${tenant.workspaceId}`);

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const url = new URL(BASE);
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: tenant.cookieValue,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);

  // Everything the shell says on the wire, recorded before it is judged.
  const sent: { url: string; method: string; bodyWorkspace: string | null }[] = [];
  const refused: { url: string; status: number }[] = [];

  const page = await context.newPage();
  page.on("request", (req) => {
    if (!req.url().includes("/api/")) return;
    let bodyWorkspace: string | null = null;
    const raw = req.postData();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { workspaceId?: unknown };
        if (typeof parsed.workspaceId === "string") bodyWorkspace = parsed.workspaceId;
      } catch {
        // Not JSON (file upload, form post). Nothing to read; not a failure.
      }
    }
    sent.push({ url: req.url(), method: req.method(), bodyWorkspace });
  });
  page.on("response", (res) => {
    if (res.url().includes("/api/") && res.status() === 403) refused.push({ url: res.url(), status: res.status() });
  });

  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  // The shell loads the workspace after boot resolves; give it room to settle.
  await page.waitForTimeout(4000);

  const bodyText = (await page.locator("body").innerText()).slice(0, 4000);

  console.log(`\n  the shell made ${sent.length} API calls\n`);

  // 0. COUNT GUARD, and it is the most important check here.
  //
  // The first run of this probe reported four PASSes off ZERO API calls. React
  // had not hydrated at all (CSP blocked every inline script, P0-CSP), so
  // "no request carried workspace_demo" was true the way it is true of a brick.
  // A sweep that has lost its subject passes for the wrong reason, which is the
  // same failure mode as a golden whose regex no longer matches anything.
  // A live shell issues roughly 17 GETs on load; 8 is a floor no dead page clears.
  const MIN_CALLS = 8;
  check(
    sent.length >= MIN_CALLS,
    `the shell actually talked to the server (${sent.length} calls, floor ${MIN_CALLS})`,
    sent.length < MIN_CALLS
      ? "too few calls for a hydrated app — every check below is vacuous until this passes. Look for blocked " +
        "scripts in the console output above."
      : "",
  );

  // 1. Did it get past the gate at all?
  const stuck = /Opening your workspace/i.test(bodyText);
  check(
    !stuck,
    "the app rendered — no permanent workspace spinner",
    stuck ? 'page still shows "Opening your workspace…" after 4s; the gate never opened' : "",
  );

  // 2. Nothing on the wire claims the demo tenant. THIS is the bug.
  const demoCalls = sent.filter((s) => s.bodyWorkspace === "workspace_demo");
  check(
    demoCalls.length === 0,
    'no request carried the hardcoded "workspace_demo"',
    demoCalls.length ? `${demoCalls.length} did: ${demoCalls.map((d) => `${d.method} ${d.url}`).join(", ")}` : "",
  );

  // 3. Every request that names a workspace names the SESSION's one.
  const named = sent.filter((s) => s.bodyWorkspace !== null);
  const wrong = named.filter((s) => s.bodyWorkspace !== tenant.workspaceId);
  check(
    wrong.length === 0,
    `every request that names a workspace names this customer's (${named.length} of ${sent.length} name one)`,
    wrong.length ? `${wrong.length} named something else: ${wrong.map((w) => w.bodyWorkspace).join(", ")}` : "",
  );

  // 4. The server refused nothing.
  check(
    refused.length === 0,
    "not one request came back 403",
    refused.length ? refused.map((r) => r.url).join(", ") : "",
  );

  check(
    consoleErrors.length === 0,
    "no console errors",
    consoleErrors.length ? consoleErrors.slice(0, 5).join(" | ") : "",
  );

  await browser.close();

  console.log(
    failures === 0
      ? "\nALL GREEN — a real signed-in customer's browser talks about its OWN workspace, and the server accepts it.\n"
      : `\n${failures} CHECK(S) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nPROBE COULD NOT COMPLETE:", error instanceof Error ? error.message : error, "\n");
  process.exit(1);
});
