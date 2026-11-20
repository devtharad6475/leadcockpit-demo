/**
 * Break test (2026-09-26, CEO: "try to break the system and check what can
 * break"). Sends bad input to EVERY route the catch-all API has and reports
 * the ones that crash (HTTP 5xx) instead of answering with a clear 4xx.
 *
 * Run ONLY against a throwaway server (its own JSON data copy, AI keys blank
 * so every model call is the free mock):
 *   BREAK_BASE_URL=http://127.0.0.1:3020 npx tsx scripts/probes/break-api.ts
 * It refuses to run against a server that says it is on Postgres.
 */
import fs from "node:fs";

const BASE = process.env.BREAK_BASE_URL || "http://127.0.0.1:3020";
const source = fs.readFileSync("src/app/api/[[...path]]/route.ts", "utf8").split("\n");

type Route = { method: "GET" | "POST" | "PUT" | "DELETE"; path: string[]; line: number };
const lineOf = (text: string) => source.findIndex((line) => line.startsWith(text)) + 1;
const ranges: Array<[Route["method"], number, number]> = [
  ["GET", lineOf("async function handleGet("), lineOf("async function handlePlatformAdminGet(")],
  ["DELETE", lineOf("export async function DELETE("), lineOf("async function handlePost(")],
  ["POST", lineOf("async function handlePost("), lineOf("export async function PUT(")],
  ["PUT", lineOf("async function handlePut("), source.length + 1],
];
const routes: Route[] = [];
source.forEach((text, index) => {
  const line = index + 1;
  for (const match of text.matchAll(/match\(path, \[([^\]]*)\]\)/g)) {
    const parts = [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const range = ranges.find(([, from, to]) => line >= from && line < to);
    if (!range || !parts.length) continue;
    // A POST handler line that checks request.method explicitly keeps its method.
    const method = /request\.method === "(GET|POST|PUT|DELETE)"/.exec(text)?.[1] as Route["method"] | undefined;
    routes.push({ method: method || range[0], path: parts, line });
  }
});
const unique = [...new Map(routes.map((route) => [`${route.method} ${route.path.join("/")}`, route])).values()];

// Routes that reach outside this machine even with no AI key.
const SKIP = /^(crawl|website|prospecting|discovery|search|integrations\/test|whatsapp\/send|email)/;

const BODIES: Array<[string, string | undefined]> = [
  ["no body", undefined],
  ["broken JSON", "{\"a\": "],
  ["empty object", "{}"],
  ["wrong types", JSON.stringify({ id: 123, text: ["x"], name: { a: 1 }, answer: 5, kinds: "manufacturer", status: 42, leadId: [], workspaceId: 7, email: 99, amount: "lots" })],
  ["huge + odd text", JSON.stringify({ text: "ज़री ✨ <script>alert(1)</script> ".repeat(8000), name: "x".repeat(300000), answer: "\u0000‮", title: "a".repeat(5000) })],
];

(async () => {
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null) as { persistenceProvider?: string } | null;
  if (!health) { console.log(`No server at ${BASE}.`); process.exit(2); }
  if (health.persistenceProvider !== "json") { console.log(`Refusing: ${BASE} is on "${health.persistenceProvider}", not a throwaway JSON store.`); process.exit(3); }
  // BREAK_SIGNED_IN=1 (production-mode server, port 3021): sign up a fresh
  // owner and send every request as them, so the code behind the sign-in
  // gate is reached too. Sign-in / sign-out routes are skipped so the run
  // keeps its session; the password is made here and never printed.
  let cookie = "";
  if (process.env.BREAK_SIGNED_IN) {
    const { randomBytes } = await import("node:crypto");
    const signup = await fetch(`${BASE}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: `fuzz.${Date.now()}@break.example`, password: `Fx-${randomBytes(24).toString("base64url")}`, name: "Fuzz Owner", businessName: `Fuzz ${Date.now()}` }) });
    cookie = (signup.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    if (!cookie) { console.log(`Could not sign up on ${BASE} (${signup.status}).`); process.exit(4); }
  }
  console.log(`${unique.length} routes. Sending ${BODIES.length} kinds of bad input to each write route, 1 to each read route.`);
  const crashes: string[] = [];
  const accepted: string[] = [];
  let sent = 0;
  for (const route of unique) {
    const path = route.path.map((part) => (part.startsWith(":") ? "zz_missing_1" : part)).join("/");
    if (SKIP.test(path)) continue;
    if (cookie && /^(auth|admin)\//.test(path)) continue;
    const bodies = route.method === "GET" || route.method === "DELETE" ? [BODIES[0]] : BODIES;
    for (const [label, body] of bodies) {
      sent++;
      try {
        const response = await fetch(`${BASE}/api/${path}${route.method === "GET" ? "?id=zz&leadId=zz&limit=-5&page=abc" : ""}`, {
          method: route.method,
          headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
          body: body as never,
          signal: AbortSignal.timeout(60000),
        });
        if (process.env.REPORT_ACCEPTED && response.status < 300 && route.method !== "GET" && (label === "wrong types" || label === "empty object")) {
          accepted.push(`${response.status} ${route.method} /api/${path} [${label}] (route.ts:${route.line}) ${(await response.clone().text()).slice(0, 160).replace(/\s+/g, " ")}`);
        }
        if (response.status >= 500) {
          const text = (await response.text()).slice(0, 220).replace(/\s+/g, " ");
          crashes.push(`${response.status} ${route.method} /api/${path} [${label}] (route.ts:${route.line}) ${text}`);
        }
      } catch (error) {
        crashes.push(`NO ANSWER ${route.method} /api/${path} [${label}] (route.ts:${route.line}) ${(error as Error).message}`);
      }
    }
  }
  console.log(`${sent} requests sent. ${crashes.length} crashed:`);
  for (const line of crashes) console.log("  " + line);
  if (cookie) {
    const still = await fetch(`${BASE}/api/auth/status`, { headers: { cookie } }).then((r) => r.json()).catch(() => ({})) as { user?: unknown };
    console.log(still.user ? "Session still signed in at the end (the run was not silently answered 401)." : "WARNING: session was lost during the run — results after that point only tested the sign-in gate.");
  }
  fs.writeFileSync(cookie ? "scripts/probes/break-api-result-signed-in.txt" : "scripts/probes/break-api-result.txt", crashes.join("\n") + "\n");
  if (process.env.REPORT_ACCEPTED) {
    console.log(`${accepted.length} write requests with empty or wrong-typed input were ACCEPTED (see break-api-accepted.txt).`);
    fs.writeFileSync("scripts/probes/break-api-accepted.txt", accepted.join("\n") + "\n");
  }
})();
