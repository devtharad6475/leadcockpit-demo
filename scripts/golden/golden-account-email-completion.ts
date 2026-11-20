import "./_helpers/isolate-standalone";
import assert from "node:assert/strict";
import { accountEmailOrigin } from "../../src/lib/account-email-origin";
import { ResendEmailProvider, EmailSendError } from "../../src/providers/email";
import { accountEmailSender, getAccountEmailConfiguration, sendAccountEmail } from "../../src/lib/account-email";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountEmailStatusCard } from "../../src/app/admin/sections/AdminHealthFlags";

const input = { from: "test@example.com", to: "user@example.com", subject: "Synthetic trial", html: "<p>test</p>", purpose: "verify_email" as const };
const previous = { origin: process.env.NEXT_PUBLIC_APP_ORIGIN, url: process.env.NEXT_PUBLIC_APP_URL, mode: process.env.NODE_ENV, auth: process.env.AUTH_MODE, session: process.env.AUTH_SESSION_SECRET, sender: process.env.TRANSACTIONAL_EMAIL_FROM, key: process.env.RESEND_API_KEY };
const originalFetch = globalThis.fetch;
function restore(key: string, value: string | undefined) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }

async function main() {
  const missingProviderCard = renderToStaticMarkup(createElement(AccountEmailStatusCard, { configuration: { ready: false, senderConfigured: true, reason: "Account email provider is not connected." } }));
  assert.match(missingProviderCard, /Needs setup/);
  assert.match(missingProviderCard, /Account email provider is not connected/);
  const keyOnlyCard = renderToStaticMarkup(createElement(AccountEmailStatusCard, { configuration: { ready: false, senderConfigured: false, reason: "Account email sender is not configured." } }));
  assert.match(keyOnlyCard, /Needs setup/);
  assert.match(keyOnlyCard, /Account email sender is not configured/);
  const configuredCard = renderToStaticMarkup(createElement(AccountEmailStatusCard, { configuration: { ready: true, senderConfigured: true } }));
  assert.match(configuredCard, /Configured/);
  assert.match(configuredCard, /Delivery not yet verified/);
  assert.doesNotMatch(keyOnlyCard + missingProviderCard + configuredCard, /real send|email sent|delivered/i);
  console.log("PASS rendered admin account email card distinguishes missing provider, key-only and configured states");
  delete process.env.TRANSACTIONAL_EMAIL_FROM;
  delete process.env.RESEND_API_KEY;
  assert.equal(accountEmailSender(), "LeadCockpit demo <accounts@example.invalid>");
  assert.equal((await sendAccountEmail({ to: input.to, subject: input.subject, html: input.html, purpose: "invite" })).provider, "mock");
  process.env.RESEND_API_KEY = "synthetic-key-never-sent";
  assert.deepEqual(getAccountEmailConfiguration(), { provider: "resend", senderConfigured: false, ready: false, reason: "Account email sender is not configured. Ask your administrator to set TRANSACTIONAL_EMAIL_FROM to a sender verified with the email provider." });
  let senderCalls = 0;
  globalThis.fetch = (async () => { senderCalls++; return new Response(JSON.stringify({ id: "synthetic-account-accepted" }), { status: 200 }); }) as typeof fetch;
  await assert.rejects(sendAccountEmail({ to: input.to, subject: input.subject, html: input.html, purpose: "invite" }), /TRANSACTIONAL_EMAIL_FROM/);
  assert.equal(senderCalls, 0, "a key alone must not invent a sender or make a request");
  for (const invalid of ["not an email", "a@example.com,b@example.com", "Lead <a@example.com>\r\nBcc: b@example.com", "Lead <bad>", "<a@example.com>"]) {
    process.env.TRANSACTIONAL_EMAIL_FROM = invalid;
    assert.throws(accountEmailSender, /invalid/);
  }
  process.env.TRANSACTIONAL_EMAIL_FROM = "Customer Trial <accounts@example.com>";
  assert.deepEqual(getAccountEmailConfiguration(), { provider: "resend", senderConfigured: true, ready: true });
  const sentPurposes: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.from, "Customer Trial <accounts@example.com>");
    sentPurposes.push(body.subject);
    return new Response(JSON.stringify({ id: "synthetic-account-accepted" }), { status: 200 });
  }) as typeof fetch;
  for (const purpose of ["invite", "verify_email", "password_reset", "security_notice"] as const) {
    assert.equal((await sendAccountEmail({ to: input.to, subject: purpose, html: input.html, purpose })).provider, "resend");
  }
  assert.deepEqual(sentPurposes, ["invite", "verify_email", "password_reset", "security_notice"]);
  // Wiring check supplements the actual shared send contract: every account
  // caller must use the same helper and cannot override its configured sender.
  for (const file of ["src/services/SignupService.ts", "src/services/InviteService.ts", "src/services/AccountSecurityService.ts", "src/app/api/[[...path]]/route.ts"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /sendAccountEmail\(/);
    assert.doesNotMatch(source, /from:\s*["'](?:LeadCockpit <)?no-?reply@leadcockpit\.app/);
  }
  delete process.env.RESEND_API_KEY;
  console.log("PASS explicit account sender, zero requests when missing, all account purposes and caller wiring");
  process.env.NEXT_PUBLIC_APP_ORIGIN = "https://accounts.example.com/";
  process.env.NEXT_PUBLIC_APP_URL = "https://old.example.com";
  assert.equal(accountEmailOrigin(), "https://accounts.example.com");
  delete process.env.NEXT_PUBLIC_APP_ORIGIN;
  assert.equal(accountEmailOrigin(), "https://old.example.com");
  for (const invalid of ["javascript:alert(1)", "https://example.com/path", "https://user:secret@example.com", "https://example.com/?token=secret"]) {
    process.env.NEXT_PUBLIC_APP_ORIGIN = invalid;
    assert.throws(accountEmailOrigin);
  }
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  delete process.env.NEXT_PUBLIC_APP_ORIGIN;
  delete process.env.NEXT_PUBLIC_APP_URL;
  assert.throws(accountEmailOrigin, /not configured/);
  process.env.NEXT_PUBLIC_APP_ORIGIN = "http://localhost:3000";
  assert.throws(accountEmailOrigin, /public HTTPS/);
  console.log("PASS canonical public address and fail-closed production links");

  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("Synthetic timeout")), { once: true });
    });
  }) as typeof fetch;
  const started = Date.now();
  await assert.rejects(new ResendEmailProvider("synthetic-only", 20).send(input), (error) => error instanceof EmailSendError && error.outcomeUnknown && /before trying again/.test(error.message));
  assert.equal(calls, 1, "uncertain sends must not retry");
  assert.ok(Date.now() - started < 1500, "send must be bounded");
  console.log("PASS timeout is bounded, uncertain and not retried");

  globalThis.fetch = (async (_url, init) => new Response(new ReadableStream({
    start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new Error("Synthetic stalled body")), { once: true }); },
  }), { status: 200 })) as typeof fetch;
  await assert.rejects(new ResendEmailProvider("synthetic-only", 20).send(input), (error) => error instanceof EmailSendError && error.outcomeUnknown);
  console.log("PASS timeout also bounds a stalled response body");

  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  await assert.rejects(new ResendEmailProvider("synthetic-only").send(input), (error) => error instanceof EmailSendError && error.outcomeUnknown);
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Synthetic rejection" }), { status: 422 })) as typeof fetch;
  await assert.rejects(new ResendEmailProvider("synthetic-only").send(input), (error) => error instanceof EmailSendError && !error.outcomeUnknown && error.statusCode === 422);
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: "synthetic-accepted" }), { status: 200 })) as typeof fetch;
  assert.deepEqual(await new ResendEmailProvider("synthetic-only").send(input), { ok: true, provider: "resend", providerMessageId: "synthetic-accepted" });
  console.log("PASS acceptance, rejection and ambiguous response remain distinct");

  delete process.env.NEXT_PUBLIC_APP_ORIGIN;
  delete process.env.NEXT_PUBLIC_APP_URL;
  const { repositories } = await import("../../src/repositories");
  const { requestPasswordReset } = await import("../../src/services/AccountSecurityService");
  const lookup = repositories.auth.findCredentialsByEmail;
  let lookedUp = false;
  repositories.auth.findCredentialsByEmail = async () => { lookedUp = true; throw new Error("must not look up accounts before origin validation"); };
  try {
    await assert.rejects(requestPasswordReset("synthetic@example.com"), /not configured/);
    assert.equal(lookedUp, false, "invalid account address must fail before account/token mutations");
  } finally { repositories.auth.findCredentialsByEmail = lookup; }
  console.log("PASS reset validates account origin before looking up or changing tokens");

  process.env.AUTH_MODE = "production";
  process.env.AUTH_SESSION_SECRET = "synthetic-account-contract-session-secret-2026";
  process.env.NEXT_PUBLIC_APP_ORIGIN = "https://accounts.example.com";
  process.env.RESEND_API_KEY = "synthetic-key-never-sent";
  const accountSubjects: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.from, "Customer Trial <accounts@example.com>");
    accountSubjects.push(body.subject);
    return new Response(JSON.stringify({ id: "synthetic-account-accepted" }), { status: 200 });
  }) as typeof fetch;
  const { signup, resendVerification, publicSignup: publicAccountSignup } = await import("../../src/services/SignupService");
  const { createInvite } = await import("../../src/services/InviteService");
  const syntheticOwner = await signup({ email: `configured-sender-${process.pid}@example.invalid`, password: "Synthetic-account-sender-password!", name: "Synthetic owner" });
  assert.equal(syntheticOwner.emailSent, true);
  const reissuedVerification = await resendVerification({ userId: syntheticOwner.user.id });
  assert.equal((await publicAccountSignup({ email: syntheticOwner.user.email, password: "Synthetic-account-sender-password!" })).noticeSent, true);
  assert.equal((await createInvite({ workspaceId: syntheticOwner.user.workspaceId, invitedByUserId: syntheticOwner.user.id, inviteeEmail: `staff-${process.pid}@example.invalid`, role: "sales_member" })).emailSent, true);
  assert.equal((await requestPasswordReset(syntheticOwner.user.email)).emailSent, true);
  assert.deepEqual(accountSubjects, ["Verify your LeadCockpit account", "Verify your LeadCockpit account", "Someone tried to sign up with your email", "You're invited to join a LeadCockpit workspace", "Reset your LeadCockpit password"]);
  delete process.env.TRANSACTIONAL_EMAIL_FROM;
  const oldVerification = await repositories.emailVerificationToken.findByTokenHash((await import("node:crypto")).createHash("sha256").update(reissuedVerification).digest("hex"));
  await assert.rejects(resendVerification({ userId: syntheticOwner.user.id }), /TRANSACTIONAL_EMAIL_FROM/);
  // The issuance guard is earlier than lookup/token replacement; no provider call.
  const resetLookup = repositories.auth.findCredentialsByEmail;
  repositories.auth.findCredentialsByEmail = async () => { throw new Error("sender validation must precede lookup"); };
  try { await assert.rejects(requestPasswordReset(syntheticOwner.user.email), /TRANSACTIONAL_EMAIL_FROM/); }
  finally { repositories.auth.findCredentialsByEmail = resetLookup; }
  assert.deepEqual(await repositories.emailVerificationToken.findByTokenHash((await import("node:crypto")).createHash("sha256").update(reissuedVerification).digest("hex")), oldVerification);
  assert.equal(accountSubjects.length, 5, "missing sender cannot attempt provider requests");
  delete process.env.RESEND_API_KEY;
  delete process.env.NEXT_PUBLIC_APP_ORIGIN;
  console.log("PASS real service paths share sender; invalid sender preserves tokens and prevents reset lookup");
  let emailRequests = 0;
  globalThis.fetch = (async () => { emailRequests++; throw new Error("No email request is permitted in missing-origin trial"); }) as typeof fetch;
  const { publicSignup, PUBLIC_SIGNUP_MESSAGE } = await import("../../src/services/SignupService");
  const email = `missing-origin-${process.pid}@example.invalid`, password = "Synthetic-account-origin-password!";
  const first = await publicSignup({ email, password, name: "Synthetic owner" });
  const duplicate = await publicSignup({ email, password, name: "Synthetic owner" });
  // Internal diagnostics deliberately distinguish actual creation; the public
  // route must discard this distinction and give identical acknowledgements.
  assert.deepEqual(first, { created: true, noticeSent: false });
  assert.deepEqual(duplicate, { created: false, noticeSent: false });
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../../src/app/api/[[...path]]/route");
  const submit = (address: string) => POST(new NextRequest("http://localhost:3000/api/auth/signup", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", host: "localhost:3000", "x-forwarded-for": "192.0.2.73" },
    body: JSON.stringify({ email: address, password, name: "Synthetic owner" }),
  }), { params: Promise.resolve({ path: ["auth", "signup"] }) });
  const freshResponse = await submit(`missing-origin-route-${process.pid}@example.invalid`);
  const duplicateResponse = await submit(email);
  assert.equal(freshResponse.status, 200);
  assert.equal(duplicateResponse.status, 200);
  assert.deepEqual(await freshResponse.json(), { ok: true, checkEmail: true, message: PUBLIC_SIGNUP_MESSAGE });
  assert.deepEqual(await duplicateResponse.json(), { ok: true, checkEmail: true, message: PUBLIC_SIGNUP_MESSAGE });
  assert.equal(emailRequests, 0, "missing origin must never attempt an email request");
  console.log("PASS missing production origin preserves distinct internal outcomes and identical public signup responses");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  globalThis.fetch = originalFetch;
  restore("NEXT_PUBLIC_APP_ORIGIN", previous.origin); restore("NEXT_PUBLIC_APP_URL", previous.url); restore("NODE_ENV", previous.mode);
  restore("AUTH_MODE", previous.auth); restore("AUTH_SESSION_SECRET", previous.session);
  restore("TRANSACTIONAL_EMAIL_FROM", previous.sender); restore("RESEND_API_KEY", previous.key);
});
