/**
 * PROBE — Q-7, in a real browser, in production auth mode, on Postgres.
 *
 * The golden (scripts/golden/golden-essential-setup-stage.ts) proves the
 * grouping function divides the backlog correctly. It cannot prove a customer
 * ever SEES that division: the function could be perfect and the screen could
 * still render all 81 backlog cards, because the screen chooses which list to
 * walk. That gap is exactly the shape of the P0 this project already shipped
 * once — server correct, screen sending something else.
 *
 * So this probe signs up a real new tenant against a production-auth server,
 * opens the product in Chromium, and reads what that owner actually faces on
 * their first day.
 *
 * What it asserts:
 *   1. the shell hydrated at all                          (count guard)
 *   2. the landing screen offers the ESSENTIALS, not "523 setup questions"
 *   3. the Questions screen opens on the start-here stage, not the backlog
 *   4. that stage is at most 12 cards, and fewer than the full backlog
 *   5. the deeper backlog is still reachable, not deleted
 *   6. answering a start-here card writes through the SAME endpoint (200)
 *   7. the essential open count really drops on the server afterwards
 *   8. the neighbouring tenant is untouched
 *   9. no console errors
 *
 * Usage:  npx tsx scripts/probes/essential-stage-ui.ts http://localhost:3021
 *
 * SAFETY — no credential appears in this file's output. Passwords are generated
 * with crypto.randomBytes, used once in-process against the local server, and
 * never printed, never written to disk, never typed into a form. Only the
 * resulting session cookie reaches the browser context, and it is never logged.
 * Fixture contact details are unroutable by construction (N-SAFETY-1): RFC 2606
 * `.example` domains.
 */
import { randomBytes } from "node:crypto";
import { chromium } from "@playwright/test";

const BASE = process.argv[2] || "http://localhost:3021";
const SESSION_COOKIE = "lc_session";

/** A live shell issues ~17 GETs on load. 8 is a floor no dead page clears. */
const MIN_CALLS = 8;

/** The stage is bounded by the 12 core domains. That bound is the whole point. */
const MAX_STAGE_CARDS = 12;

type Signed = { workspaceId: string; cookieValue: string; email: string };

type UnknownQuestion = { id: string; questionText: string; status: string; isEssential?: boolean };

type GroupsResponse = {
  groups: Array<{ groupKey: string }>;
  rawOpenCount: number;
  essential: {
    groups: Array<{ groupKey: string; title: string; questionsCount: number }>;
    essentialOpenCount: number;
    essentialTotalCount: number;
    remainingOpenCount: number;
  };
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
  if (res.status !== 200 && res.status !== 201) throw new Error(`signup for ${email} returned HTTP ${res.status}`);

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

async function getJson<T>(who: Signed, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: `${SESSION_COOKIE}=${who.cookieValue}` } });
  if (res.status !== 200) throw new Error(`GET ${path} returned HTTP ${res.status}`);
  return (await res.json()) as T;
}

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}

async function main() {
  console.log(`\nQ-7 start-here stage proof (production mode) against ${BASE}\n`);

  const mode = (await (await fetch(`${BASE}/api/auth/status`)).json()) as { authMode?: string };
  console.log(`  server reports authMode: ${JSON.stringify(mode.authMode)}`);
  if (mode.authMode !== "production") {
    console.error(
      "\nREFUSING TO RUN. Demo mode shares one seeded workspace, so a fresh-tenant backlog would not be fresh\n" +
        "and the counts below would measure leftovers. Start the server with AUTH_MODE=production.\n",
    );
    process.exit(2);
  }

  const tenant = await signUpFresh("meridian-valves");
  const neighbour = await signUpFresh("cobalt-textiles");
  console.log(`  tenant    workspace: ${tenant.workspaceId}`);
  console.log(`  neighbour workspace: ${neighbour.workspaceId}`);

  const before = await getJson<GroupsResponse>(tenant, "/api/unknown-questions/groups");
  console.log(
    `  fresh tenant faces: ${before.groups.length} backlog cards, or ${before.essential.groups.length} start-here cards ` +
      `(${before.essential.essentialOpenCount} essential open, ${before.essential.remainingOpenCount} deferred)\n`,
  );
  if (before.essential.essentialOpenCount === 0) {
    console.error("CANNOT RUN: this tenant has no open essential question, so there is no start-here stage to drive.\n");
    process.exit(2);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const url = new URL(BASE);
  await context.addCookies([
    { name: SESSION_COOKIE, value: tenant.cookieValue, domain: url.hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" },
  ]);

  const sent: { url: string; method: string }[] = [];
  const page = await context.newPage();
  page.on("request", (req) => {
    if (req.url().includes("/api/")) sent.push({ url: req.url(), method: req.method() });
  });
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);

  // 1. COUNT GUARD. A dead shell makes every check below true for the wrong reason.
  check(
    sent.length >= MIN_CALLS,
    `the shell hydrated and talked to the server (${sent.length} calls, floor ${MIN_CALLS})`,
    sent.length < MIN_CALLS ? "too few calls for a live app; every check below is vacuous until this passes" : "",
  );

  // 2. The landing screen. Before Q-7 this offered "Work through the setup
  //    questions" against a 400-question backlog. It should now name the
  //    essentials, because that is the promise the owner can actually keep.
  const essentialsButton = page.getByRole("button", { name: "Answer the setup essentials" });
  const foundEssentialsButton = await essentialsButton.isVisible().catch(() => false);
  check(foundEssentialsButton, "the landing screen offers the setup ESSENTIALS, not the whole backlog");

  const landingText = await page.locator("body").innerText();
  check(
    /essential answer/i.test(landingText) && /minute/i.test(landingText),
    "the landing screen tells the owner how many essentials are left and roughly how long it takes",
    /essential answer/i.test(landingText) ? "" : "no essential count offered on the landing screen",
  );

  await essentialsButton.click({ timeout: 15000 });

  // 3 + 4. The Questions screen must OPEN on the start-here stage.
  const answerBox = page.getByPlaceholder(/MOQ is 150 kg/);
  await answerBox.waitFor({ state: "visible", timeout: 20000 });

  const stageButton = page.getByRole("button", { name: /^Setup essentials \(\d+\)$/ });
  await stageButton.waitFor({ state: "visible", timeout: 15000 });
  const stageLabel = (await stageButton.innerText()).trim();
  const stageCards = Number(stageLabel.match(/\((\d+)\)/)?.[1] ?? "0");
  check(
    stageCards > 0 && stageCards <= MAX_STAGE_CARDS,
    `the start-here stage is at most ${MAX_STAGE_CARDS} cards (screen says ${stageCards})`,
    stageCards > MAX_STAGE_CARDS ? `${stageCards} cards is not a first stage, it is the backlog again` : "",
  );
  check(
    stageCards < before.groups.length,
    `the start-here stage is smaller than the backlog it replaces (${stageCards} vs ${before.groups.length})`,
  );

  // The card walker's own counter is the honest test of which list is on screen.
  const walker = await page.getByText(/^\d+ of \d+$/).first().innerText();
  const walkerTotal = Number(walker.split(" of ")[1] ?? "0");
  check(
    walkerTotal === stageCards,
    `the card walker is walking the start-here stage, not the backlog (says "${walker}")`,
    walkerTotal !== stageCards ? `walker total ${walkerTotal} disagrees with the stage's ${stageCards}` : "",
  );

  // 4b. A-12 (2026-08-25). The screen used to re-sort the cards with a
  //     comparator that contradicted itself, so it walked the curated stage
  //     BACKWARDS: the owner opened on "Analytics & Learning" (1 question)
  //     instead of "Brand Identity" (7). Nothing failed — the card count was
  //     still 12 and the save still returned 200 — which is exactly why this
  //     assertion has to name the card, not count them.
  const serverFirst = before.essential.groups[0];
  const onScreenTitle = (await page.locator("p.text-lg.font-semibold").first().innerText()).trim();
  check(
    onScreenTitle === serverFirst.title,
    `the owner opens on the card the server put first ("${onScreenTitle}")`,
    onScreenTitle !== serverFirst.title ? `the server ordered "${serverFirst.title}" first; the screen is showing "${onScreenTitle}"` : "",
  );

  const badge = await page.getByText(/^\d+ knowledge items$/).first().innerText();
  const cardQuestions = Number(badge.match(/^(\d+)/)?.[1] ?? "0");
  check(
    cardQuestions === serverFirst.questionsCount,
    `the card says how many questions it really covers (${cardQuestions})`,
    cardQuestions !== serverFirst.questionsCount ? `screen says ${cardQuestions}, server says ${serverFirst.questionsCount}` : "",
  );

  // 5. Nothing was deleted. The depth is still one click away.
  const everythingButton = page.getByRole("button", { name: /^Everything else \(\d+\)$/ });
  const everythingLabel = (await everythingButton.innerText()).trim();
  const everythingCards = Number(everythingLabel.match(/\((\d+)\)/)?.[1] ?? "0");
  check(
    everythingCards > stageCards,
    `the deeper backlog is still reachable and still larger (screen says ${everythingCards})`,
    everythingCards <= stageCards ? "the deferred questions have gone missing, which is not what Q-7 asked for" : "",
  );

  // 6. Answering a start-here card must go through the ONE existing write path.
  //    A second save path would be a second thing to keep correct.
  const marker = randomBytes(6).toString("hex");
  const typed = `We supply across three states and dispatch within 72 hours. Reference ${marker}.`;
  await answerBox.fill(typed);

  // The timeout is deliberately generous. Answering a seven-question card runs
  // seven knowledge mappings server-side and took past 45s on the first run of
  // this probe — and the probe then measured the counts MID-WRITE and reported a
  // bug that was not there. Reading a database while it is still being written
  // to is how a proof invents its own failure. (The latency itself is real and
  // is recorded as a finding; see docs/SYSTEM-AUDIT.md A-13.)
  const writeResponse = page.waitForResponse(
    (res) => res.url().endsWith("/api/unknown-questions/groups/answer") && res.request().method() === "POST",
    { timeout: 240000 },
  );
  const writeStartedAt = Date.now();
  await page.getByRole("button", { name: "Save and next" }).click();

  let writeStatus = 0;
  try {
    writeStatus = (await writeResponse).status();
  } catch {
    // Handled by the check below — writeStatus stays 0.
  }
  const writeMs = Date.now() - writeStartedAt;
  check(writeStatus === 200, `the start-here card saved through the existing endpoint (HTTP ${writeStatus || "no response"}, ${(writeMs / 1000).toFixed(1)}s)`);

  await page.waitForTimeout(2500);

  // 7. The count really moved on the server. A progress bar that animates while
  //    the database sits still is worse than no progress bar.
  const after = await getJson<GroupsResponse>(tenant, "/api/unknown-questions/groups");
  // A-11 (2026-08-25). "It went down" is too weak an assertion: the card that
  // hid the cross-domain bug held seven questions and resolved four, and a
  // greater-than test called that a pass. The count must drop by the WHOLE card.
  const expectedOpen = before.essential.essentialOpenCount - cardQuestions;
  check(
    after.essential.essentialOpenCount === expectedOpen,
    `answering a ${cardQuestions}-question card resolved all ${cardQuestions} (essential open ${before.essential.essentialOpenCount} -> ${after.essential.essentialOpenCount})`,
    after.essential.essentialOpenCount !== expectedOpen
      ? `expected ${expectedOpen}. ${after.essential.essentialOpenCount - expectedOpen} question(s) the owner just answered are still open, and the screen said nothing.`
      : "",
  );
  check(
    after.essential.essentialTotalCount === before.essential.essentialTotalCount,
    "the essential TOTAL did not move — answering a question resolves it, it does not delete it",
  );
  check(
    after.essential.essentialOpenCount + after.essential.remainingOpenCount === after.rawOpenCount,
    "essential + deferred still adds up to the open backlog",
    `${after.essential.essentialOpenCount} + ${after.essential.remainingOpenCount} vs ${after.rawOpenCount}`,
  );

  // 8. The neighbour is untouched. Same assertion the P0-TENANT probe makes,
  //    repeated here because this change added a new server-side derivation
  //    (isEssential) that reads framework state while serving tenant data.
  const neighbourAfter = await getJson<GroupsResponse>(neighbour, "/api/unknown-questions/groups");
  check(
    neighbourAfter.essential.essentialOpenCount === before.essential.essentialOpenCount,
    `the neighbouring tenant's essentials are untouched (${neighbourAfter.essential.essentialOpenCount} of its own)`,
  );
  const neighbourQuestions = await getJson<UnknownQuestion[]>(neighbour, "/api/unknown-questions");
  check(
    !neighbourQuestions.some((q) => (q as { finalAnswer?: string }).finalAnswer?.includes(marker)),
    "the neighbouring tenant cannot see this tenant's answer",
  );
  check(
    neighbourQuestions.some((q) => q.isEssential === true),
    "the derived isEssential flag reaches the client for a real tenant",
  );

  // 9.
  check(consoleErrors.length === 0, "no console errors", consoleErrors.slice(0, 3).join("\n        "));

  await browser.close();
  console.log(failures === 0 ? "\nALL GREEN\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
