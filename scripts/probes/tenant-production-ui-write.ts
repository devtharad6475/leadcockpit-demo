/**
 * PROBE — a real UI-driven WRITE in production mode (the gap the other two left).
 *
 * tenant-production-proof.ts proves the SERVER refuses a body naming the wrong
 * workspace. tenant-production-browser.ts proves the SHELL boots and its
 * load-time traffic is clean. Neither proves the thing the P0 actually was:
 * all 90 write call sites sent a hardcoded "workspace_demo", and every one of
 * them was refused in production. The browser probe's own output says so —
 * "0 of 19 name one" — because everything a page issues on load is a GET, and
 * a GET carries no workspaceId at all. It is scoped from the session.
 *
 * So this probe types into the product and presses the button.
 *
 * The write it drives is answering a setup question, chosen because it needs no
 * prerequisites: "Needs you" is the default landing screen (src/app/page.tsx
 * `useState<TabId>("needsYou")`) and a freshly signed-up tenant lands there with
 * a backlog already waiting. No campaign, no profile, no ICP, no AI call.
 *
 * What it asserts, in order of what each one is worth:
 *
 *   1. the shell hydrated at all                      (count guard — see below)
 *   2. the write went out, and its body named THIS customer's workspace
 *   3. the server accepted it — not 403
 *   4. the answer is DURABLE: read back over the API, the exact sentence typed
 *      into the browser is stored against that tenant
 *   5. a SECOND tenant cannot see that question or that answer
 *
 * 4 and 5 are the point. A correct request body proves the shell; only reading
 * the row back proves it landed in the right tenant's data.
 *
 * Usage:  npm run probe:tenant-prod-ui-write -- http://localhost:3021
 *
 * SAFETY — no credential appears in this file's output.
 *  Passwords are generated with crypto.randomBytes, used once in-process
 *  against the local server, and never printed, never written to disk, never
 *  typed into a form. Only the resulting session cookie reaches the browser
 *  context, and it is never logged. Fixture contact details are unroutable by
 *  construction (N-SAFETY-1): RFC 2606 `.example` domains.
 */
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";

const BASE = process.argv[2] || "http://localhost:3021";
const SESSION_COOKIE = "lc_session";

/** A live shell issues ~17 GETs on load. 8 is a floor no dead page clears. */
const MIN_CALLS = 8;

type Signed = { workspaceId: string; cookieValue: string; email: string };

type UnknownQuestion = {
  id: string;
  questionText: string;
  status: string;
  finalAnswer?: string | null;
};

async function signUpFresh(label: string): Promise<Signed> {
  const stamp = randomBytes(4).toString("hex");
  const email = `owner-${stamp}@${label}.example`;
  const password = `Fx-${randomBytes(24).toString("base64url")}`;

  const res = await fetch(`${BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password, name: `${label} Owner`, businessName: `${label} ${stamp}` }),
    redirect: "manual",
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`signup for ${email} returned HTTP ${res.status}`);
  }

  const cookieValue = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!cookieValue) throw new Error(`signup for ${email} returned no ${SESSION_COOKIE} cookie`);

  const status = await fetch(`${BASE}/api/auth/status`, { headers: { cookie: `${SESSION_COOKIE}=${cookieValue}` } });
  const json = (await status.json()) as { user?: { workspaceId?: string } };
  const workspaceId = json.user?.workspaceId ?? "";
  if (!workspaceId) throw new Error(`session for ${email} carries no workspace`);
  return { workspaceId, cookieValue, email };
}

async function questionsFor(who: Signed): Promise<UnknownQuestion[]> {
  const res = await fetch(`${BASE}/api/unknown-questions`, {
    headers: { cookie: `${SESSION_COOKIE}=${who.cookieValue}` },
  });
  if (res.status !== 200) throw new Error(`GET /api/unknown-questions returned HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  // jsonList returns a bare array; be tolerant of a wrapped shape anyway.
  if (Array.isArray(body)) return body as UnknownQuestion[];
  const wrapped = (body as { data?: unknown }).data;
  if (Array.isArray(wrapped)) return wrapped as UnknownQuestion[];
  throw new Error(`unexpected shape from /api/unknown-questions: ${JSON.stringify(body).slice(0, 200)}`);
}

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

async function main() {
  console.log(`\nP0-TENANT UI-write proof (production mode) against ${BASE}\n`);

  const mode = (await (await fetch(`${BASE}/api/auth/status`)).json()) as { authMode?: string };
  console.log(`  server reports authMode: ${JSON.stringify(mode.authMode)}`);
  if (mode.authMode !== "production") {
    console.error(
      "\nREFUSING TO RUN. In demo mode the shell is SUPPOSED to send the demo workspace, so the check below\n" +
        "would pass while proving nothing. Start the server with AUTH_MODE=production.\n",
    );
    process.exit(2);
  }

  const tenant = await signUpFresh("acme-pipes");
  const neighbour = await signUpFresh("borealis-cold-chain");
  console.log(`  tenant    workspace: ${tenant.workspaceId}`);
  console.log(`  neighbour workspace: ${neighbour.workspaceId}`);

  const before = await questionsFor(tenant);
  const openBefore = before.filter((q) => q.status === "open");
  console.log(`  tenant starts with ${before.length} setup questions (${openBefore.length} open)\n`);
  if (openBefore.length === 0) {
    console.error("CANNOT RUN: this tenant has no open setup question, so there is no write to drive.\n");
    process.exit(2);
  }

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

  const sent: { url: string; method: string; bodyWorkspace: string | null }[] = [];
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
        // Not JSON (upload, form post). Nothing to read; not a failure.
      }
    }
    sent.push({ url: req.url(), method: req.method(), bodyWorkspace });
  });

  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  // 1. COUNT GUARD. A dead shell makes every check below true for the wrong
  //    reason — this probe's sibling once reported four PASSes off zero calls.
  check(
    sent.length >= MIN_CALLS,
    `the shell hydrated and talked to the server (${sent.length} calls, floor ${MIN_CALLS})`,
    sent.length < MIN_CALLS ? "too few calls for a live app; every check below is vacuous until this passes" : "",
  );

  // Walk the route a real new customer walks.
  //
  // The landing screen is deliberately EMPTY for a fresh tenant: NeedsYou skips
  // any question with generatedBy === "framework" (isLiveQuestion), because the
  // setup backlog is not somebody waiting on a reply. So the queue shows its
  // empty state, and the only way through to those 523 questions is the button
  // that empty state offers. Clicking it is the honest path — a probe that
  // deep-linked past it would be testing a screen no customer reaches this way.
  await page.getByRole("button", { name: "Work through the setup questions" }).click({ timeout: 15000 });

  // Setup questions are answered a GROUP at a time (one business detail covers
  // many questions), so this is the group form, not the single-question one.
  const answerBox = page.getByPlaceholder(/MOQ is 150 kg/);
  await answerBox.waitFor({ state: "visible", timeout: 20000 });
  check(true, "reached the setup questions from the landing screen's own button");
  // The sentence is the evidence: unique per run, so finding it in the database
  // later cannot be a coincidence or a leftover from an earlier run.
  const marker = randomBytes(6).toString("hex");
  const typed = `We deliver across the metro in 48 hours. Reference ${marker}.`;
  await answerBox.fill(typed);

  const writeResponse = page.waitForResponse(
    (res) => res.url().endsWith("/api/unknown-questions/groups/answer") && res.request().method() === "POST",
    { timeout: 45000 },
  );
  await page.getByRole("button", { name: "Save and next" }).click();

  let writeStatus = 0;
  try {
    writeStatus = (await writeResponse).status();
  } catch {
    // Handled by the checks below — writeStatus stays 0.
  }

  const writeRequest = sent.find((s) => s.method === "POST" && s.url.endsWith("/groups/answer"));

  // 2. The write went out, and it named THIS customer's workspace. THE BUG.
  check(
    writeRequest !== undefined,
    "the button produced a POST to /api/unknown-questions/groups/answer",
    writeRequest ? "" : "no such request was seen; the click did nothing",
  );
  check(
    writeRequest?.bodyWorkspace === tenant.workspaceId,
    "the write body named this customer's workspace, not a hardcoded one",
    writeRequest && writeRequest.bodyWorkspace !== tenant.workspaceId
      ? `body said ${JSON.stringify(writeRequest.bodyWorkspace)}, session is ${tenant.workspaceId}`
      : "",
  );

  // 3. The server accepted it.
  check(
    writeStatus === 200 || writeStatus === 201,
    `the server accepted the write (HTTP ${writeStatus || "no response"})`,
    writeStatus === 403 ? "403 — this is exactly what the P0 looked like from the browser" : "",
  );

  const demoCalls = sent.filter((s) => s.bodyWorkspace === "workspace_demo");
  check(
    demoCalls.length === 0,
    'no request carried the hardcoded "workspace_demo"',
    demoCalls.length ? demoCalls.map((d) => `${d.method} ${d.url}`).join(", ") : "",
  );

  await page.waitForTimeout(1500);
  await browser.close();

  // 4. Durability. A correct request body is the shell doing its job; only
  //    reading the row back proves it landed in the right tenant's data.
  const after = await questionsFor(tenant);
  const stored = after.filter((q) => (q.finalAnswer ?? "").includes(marker));
  check(
    stored.length > 0,
    `reading it back, the sentence typed in the browser is stored against this tenant (${stored.length} question(s))`,
    stored.length ? "" : "no question in this tenant carries that answer; the click looked fine and nothing landed",
  );
  check(
    stored.every((q) => q.finalAnswer === typed),
    "the stored answer is the exact text typed, not a truncated or rewritten version",
    stored.length ? `first stored answer: ${JSON.stringify((stored[0].finalAnswer ?? "").slice(0, 90))}` : "",
  );
  check(
    stored.length > 0 && stored.every((q) => q.status === "added_to_knowledge"),
    `those questions left the open queue (statuses ${JSON.stringify([...new Set(stored.map((q) => q.status))])})`,
  );
  const openAfter = after.filter((q) => q.status === "open").length;
  check(
    openAfter < openBefore.length,
    `the open backlog actually shrank (${openBefore.length} before, ${openAfter} after)`,
  );

  // 5. The neighbour cannot see any of it.
  const neighbourQuestions = await questionsFor(neighbour);
  const storedIds = new Set(stored.map((q) => q.id));
  check(
    !neighbourQuestions.some((q) => storedIds.has(q.id)),
    `the neighbouring tenant cannot see those questions (${neighbourQuestions.length} of its own)`,
  );
  check(
    !neighbourQuestions.some((q) => (q.finalAnswer ?? "").includes(marker)),
    "the neighbouring tenant cannot see that answer",
  );
  check(
    neighbourQuestions.filter((q) => q.status === "open").length === openBefore.length,
    "the neighbour's own backlog is untouched by this tenant's answer",
  );

  check(
    consoleErrors.length === 0,
    "no console errors",
    consoleErrors.length ? consoleErrors.slice(0, 5).join(" | ") : "",
  );

  console.log(
    failures === 0
      ? "\nALL GREEN — a customer typed into the product, the write carried their OWN workspace, the server took it,\n" +
        "the row is theirs, and the tenant next door cannot see any of it.\n"
      : `\n${failures} CHECK(S) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nPROBE COULD NOT COMPLETE:", error instanceof Error ? error.message : error, "\n");
  process.exit(1);
});
