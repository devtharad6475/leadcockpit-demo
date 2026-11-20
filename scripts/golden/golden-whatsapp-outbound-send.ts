/**
 * Golden test — the OUTBOUND WhatsApp send path, proven end to end (G7).
 *
 * WHY THIS EXISTS (2026-08-20)
 * ----------------------------
 * Everything in this product that faces a customer eventually funnels into ONE
 * action: the owner clicks Approve on a drafted reply and the message leaves
 * the building. Until now that path had never been exercised — not once, not
 * even against a stub. The pieces were tested in isolation (the kill-switch is
 * pinned by golden-feature-flag-wiring, "no autonomous send" by
 * golden-no-auto-outreach, the email branch by golden-email-outbound), but
 * nothing ever ran `approve → MetaWhatsAppCloudProvider → HTTP → back into the
 * database` and checked what the customer's record looks like afterwards.
 *
 * The CEO cannot supply WhatsApp credentials (decision D4), so a live send is
 * not available. That does NOT excuse leaving the path unproven: everything
 * except Meta's own servers is our code, and all of it can be exercised by
 * stubbing `globalThis.fetch` — the LAST inch before the network.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT
 * ---------------------------------
 *   REAL: approveAutoReplyLog, the DNC check, the double-approve block, the
 *         per-workspace credential resolution (encrypt → store → decrypt),
 *         MetaWhatsAppCloudProvider itself (URL, headers, JSON payload shape,
 *         phone normalisation, response parsing, Meta error-envelope handling,
 *         rate-limit detection), the 24h-window gate, and every post-send
 *         database write (auto-reply log, outreach activity, lead status,
 *         audit trail).
 *   STUB: only `fetch`. One function. It records the request and returns a
 *         Meta-shaped response.
 *
 * A stub provider would have proven far less — it would have skipped the very
 * class of bug that actually bites here (wrong URL, wrong payload key, a phone
 * number Meta rejects, an error envelope read from the wrong field).
 *
 * NO SECRETS: the access token used below is a literal test string. The golden
 * asserts the Authorization header has the shape `Bearer <something>` and
 * never prints the value. Recipients are +91 00000 000NN (unroutable by
 * construction, N-SAFETY-1) and hosts are asserted to be graph.facebook.com
 * only, so a regression that adds a call to some other host fails loudly.
 *
 * Hand-computed BEFORE the assertions (the Golden Thread):
 *
 *   CASE A — happy path. Window open, creds saved, Meta returns 200 with
 *     `{messages:[{id:"wamid.GOLDEN_A"}]}`.
 *     Expected: exactly ONE POST to
 *       https://graph.facebook.com/v20.0/1555000111/messages
 *     body `{messaging_product:"whatsapp", recipient_type:"individual",
 *     to:"910000000071", type:"text", text:{preview_url:false, body:<draft>}}`
 *     (note: `to` is DIGITS ONLY — normalizePhone strips "+" and spaces).
 *     Log → status approved, sendStatus "sent", providerMessageId
 *     "wamid.GOLDEN_A". Outreach activity → 1 row, outbound, "sent_api",
 *     sentManually false, createdBy "meta_whatsapp_cloud". Lead → "contacted".
 *     Audit → contains "message.approved".
 *
 *   CASE B — Meta rejects the send (HTTP 401, error code 190). Expected:
 *     approve THROWS "WhatsApp did not accept this reply …" carrying Meta's own message, an
 *     audit row "message.send_failed" is written, and the log is NOT approved
 *     (still held_for_review) with ZERO outreach activity. The operator must
 *     be able to click Approve again after fixing the token — a failed send
 *     that silently marked the draft "approved" would strand the customer.
 *
 *   CASE C — the 24-hour window is CLOSED and no template was chosen.
 *     Expected: ZERO network calls (blocked before fetch), and the returned
 *     error text tells the owner to pick a template. Behaviour pinned as-is:
 *     the log IS approved with sendStatus "blocked" and the outreach row is
 *     "sent_manual"/sentManually=true — i.e. the system's own record says a
 *     human still has to deliver this. This storage shape is deliberate and
 *     stays; the operator-facing half of it was N-UX-4 and is fixed (see the
 *     OBSERVATION at the bottom).
 *
 *   CASE D — no credentials anywhere (workspace has none, env has none).
 *     Expected: ZERO network calls, sendStatus "not_configured", and the
 *     outreach row honestly recorded as "failed" (NOT "sent_manual") because
 *     nothing was delivered and no human was told to deliver it.
 *
 *   CASE E — Meta throttles (HTTP 429 + Retry-After: 42). Expected: the error
 *     names the retry delay ("Retry after 42 seconds") instead of a generic
 *     failure, so the operator knows to wait rather than to re-check the token.
 *
 *   CASE F — window CLOSED but the owner picked a template. Expected: ONE POST
 *     with `type:"template"` and `template:{name:"reminder_v1",
 *     language:{code:"en_US"}}` — NOT a text send — and the log records sent.
 *
 * Test isolation (Gate #8): own workspace ids (ws_wasend_*), JSON substrate,
 * fetch restored in a finally.
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts \
 *        scripts/golden/golden-whatsapp-outbound-send.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { approveAutoReplyLog } from "@/services/AutoReplyReviewService";
import { WhatsAppCredentialService } from "@/services/WhatsAppCredentialService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const PHONE_NUMBER_ID = "1555000111";
/** Not a credential. A literal test string; never printed. */
const TEST_ACCESS_TOKEN = "golden-test-token-not-a-real-credential";

type Captured = {
  url: string;
  method: string;
  authHeader: string;
  contentType: string;
  body: Record<string, unknown>;
};

/**
 * Replace `globalThis.fetch` with a recorder. This is the ONLY stubbed thing in
 * this golden — everything upstream of it is the real code path.
 */
function installFetchStub(respond: (call: Captured) => { status: number; headers?: Record<string, string>; json: unknown }) {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
    const rawHeaders = (init?.headers || {}) as Record<string, string>;
    const headerOf = (name: string) =>
      rawHeaders[name] ?? rawHeaders[name.toLowerCase()] ?? rawHeaders[name.toUpperCase()] ?? "";
    const captured: Captured = {
      url,
      method: String(init?.method || "GET"),
      authHeader: headerOf("authorization") || headerOf("Authorization"),
      contentType: headerOf("content-type") || headerOf("Content-Type"),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    calls.push(captured);
    const reply = respond(captured);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null },
      json: async () => reply.json,
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function seedWorkspace(repos: RepositoryBundle, id: string) {
  await repos.workspace.create({ id, name: `WA send ${id}`, status: "active" });
}

/**
 * `lastInboundAt` drives the 24h customer-service window (CP-24).
 *
 * It is applied with a SECOND call (updateLead) on purpose: the JSON
 * substrate's createLead runs every input through `normalizeLead`, an explicit
 * field whitelist that does not carry `lastInboundAt`, so passing it to
 * createLead silently loses it. That drop is tracked separately (see
 * golden-lead-create-field-fidelity); this golden must not depend on it either
 * way, so it writes the field the way production does — via an update.
 */
async function seedLead(repos: RepositoryBundle, ws: string, phone: string, lastInboundAt: string) {
  const lead = await repos.lead.createLead({
    workspaceId: ws,
    companyName: `Customer ${ws}`,
    contactName: "Test Buyer",
    whatsappNumber: phone,
    source: "manual",
    status: "approved",
    reviewStatus: "approved",
    enrichmentStatus: "completed",
    doNotContact: false,
    consentStatus: "none",
  });
  return repos.lead.updateLead(ws, lead.id, { lastInboundAt });
}

async function seedDraftReply(repos: RepositoryBundle, ws: string, leadId: string, body: string) {
  const reply = await repos.reply.create({ workspaceId: ws, leadId, channel: "whatsapp", rawText: "customer message" });
  return repos.autoReplyLog.create(ws, {
    leadId,
    replyId: reply.id,
    channel: "whatsapp",
    incomingMessage: "customer message",
    retrievedContext: {},
    generatedReply: body,
    canAutoSend: false,
    needsHumanReview: true,
    status: "held_for_review",
    reason: "Held for owner review.",
  });
}

async function saveCreds(repos: RepositoryBundle, ws: string) {
  await new WhatsAppCredentialService(repos).save(ws, {
    accessToken: TEST_ACCESS_TOKEN,
    phoneNumberId: PHONE_NUMBER_ID,
  });
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

/** Meta calls only. Anything else is a regression and is asserted against. */
function graphCalls(calls: Captured[]) {
  return calls.filter((c) => c.url.startsWith("https://graph.facebook.com/"));
}

async function main() {
  const repos = createJsonRepos();

  // Guard: this golden must never reach the real network even if a stub is
  // bypassed by a future refactor. The env creds must be absent so an
  // unconfigured case really is unconfigured.
  delete process.env.WHATSAPP_CLOUD_ACCESS_TOKEN;
  delete process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID;

  // ─── CASE A: happy path — the message actually leaves ──────────────────────
  {
    const WS = "ws_wasend_a";
    await seedWorkspace(repos, WS);
    await saveCreds(repos, WS);
    const lead = await seedLead(repos, WS, "+91 00000 00071", hoursAgo(1));
    const draft = "Our standard service visit is 2400 INR per call-out.";
    const log = await seedDraftReply(repos, WS, lead.id, draft);

    const stub = installFetchStub(() => ({ status: 200, json: { messages: [{ id: "wamid.GOLDEN_A" }] } }));
    let approved;
    try {
      approved = await approveAutoReplyLog(WS, log.id, {}, repos, "owner");
    } finally {
      stub.restore();
    }

    const sent = graphCalls(stub.calls);
    assert(stub.calls.length === sent.length, `CASE A: every outbound call must go to graph.facebook.com, got ${stub.calls.map((c) => c.url).join(", ")}`);
    assert(sent.length === 1, `CASE A: exactly ONE send call, got ${sent.length}`);
    const call = sent[0];
    assert(call.url === `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, `CASE A: wrong endpoint: ${call.url}`);
    assert(call.method === "POST", `CASE A: send must be POST, got ${call.method}`);
    assert(/^Bearer \S+$/.test(call.authHeader), "CASE A: Authorization header must be 'Bearer <token>' (value never printed)");
    assert(/application\/json/i.test(call.contentType), `CASE A: content-type must be JSON, got ${call.contentType}`);
    assert(call.body.messaging_product === "whatsapp", `CASE A: messaging_product, got ${String(call.body.messaging_product)}`);
    assert(call.body.type === "text", `CASE A: a free-text send inside the window, got type=${String(call.body.type)}`);
    assert(call.body.to === "910000000071", `CASE A: recipient must be digits only (normalizePhone), got ${String(call.body.to)}`);
    assert((call.body.text as { body?: string })?.body === draft, "CASE A: the approved text is what Meta receives, unchanged");

    assert(approved.status === "approved", `CASE A: log approved, got ${approved.status}`);
    assert(approved.sendStatus === "sent", `CASE A: sendStatus sent, got ${approved.sendStatus}`);
    assert(approved.providerMessageId === "wamid.GOLDEN_A", `CASE A: Meta's message id is stored, got ${approved.providerMessageId}`);

    const activity = await repos.outreachActivity.listByLead(WS, lead.id);
    assert(activity.length === 1, `CASE A: exactly one outreach activity row, got ${activity.length}`);
    assert(activity[0].direction === "outbound", `CASE A: direction outbound, got ${activity[0].direction}`);
    assert(activity[0].status === "sent_api", `CASE A: a real API delivery is 'sent_api', got ${activity[0].status}`);
    assert(activity[0].sentManually === false, "CASE A: sentManually must be false for an API send");
    assert(activity[0].createdBy === "meta_whatsapp_cloud", `CASE A: createdBy names the channel, got ${activity[0].createdBy}`);
    assert(activity[0].body === draft, "CASE A: the outreach row stores what was sent");

    const after = await repos.lead.getLeadById(WS, lead.id);
    assert(after?.status === "contacted", `CASE A: lead moves to contacted, got ${after?.status}`);
    assert(Boolean(after?.lastContactedAt), "CASE A: lastContactedAt is stamped");

    const audits = await repos.auditLog.listByWorkspace(WS);
    assert(audits.some((a) => a.eventType === "message.approved"), `CASE A: an audit row records the approval, saw [${audits.map((a) => a.eventType).join(", ")}]`);
    console.log("✅ CASE A — approve sends a real Meta-shaped POST; log, outreach, lead and audit all record the delivery");
  }

  // ─── CASE B: Meta rejects — the draft must stay re-sendable ────────────────
  {
    const WS = "ws_wasend_b";
    await seedWorkspace(repos, WS);
    await saveCreds(repos, WS);
    const lead = await seedLead(repos, WS, "+91 00000 00072", hoursAgo(2));
    const log = await seedDraftReply(repos, WS, lead.id, "This one will be rejected by Meta.");

    const stub = installFetchStub(() => ({
      status: 401,
      json: { error: { message: "Error validating access token: Session has expired.", code: 190, type: "OAuthException" } },
    }));
    let threw = false;
    let errMsg = "";
    try {
      await approveAutoReplyLog(WS, log.id, {}, repos, "owner");
    } catch (e) {
      threw = true;
      errMsg = e instanceof Error ? e.message : String(e);
    } finally {
      stub.restore();
    }

    assert(threw, "CASE B: a rejected send must throw, not return quietly");
    // 2026-09-26 (break test): worded for the owner now ("WhatsApp did not
    // accept this reply, so nothing was sent: …") and a NeedsActionError, so
    // the API shows it instead of a generic 500.
    assert(/WhatsApp did not accept/i.test(errMsg), `CASE B: the error names the channel, got "${errMsg}"`);
    assert(/Session has expired/i.test(errMsg), `CASE B: Meta's own reason reaches the operator, got "${errMsg}"`);

    const stillDraft = await repos.autoReplyLog.getById(WS, log.id);
    assert(stillDraft?.status === "held_for_review", `CASE B: a FAILED send must NOT mark the draft approved (it has to stay re-sendable), got ${stillDraft?.status}`);
    const activity = await repos.outreachActivity.listByLead(WS, lead.id);
    assert(activity.length === 0, `CASE B: nothing was delivered, so no outreach row, got ${activity.length}`);
    const audits = await repos.auditLog.listByWorkspace(WS);
    assert(audits.some((a) => a.eventType === "message.send_failed"), `CASE B: the failure is recorded in the audit trail, saw [${audits.map((a) => a.eventType).join(", ")}]`);
    console.log("✅ CASE B — Meta rejection: throws with Meta's reason, draft stays held_for_review, failure audited, no phantom outreach row");
  }

  // ─── CASE C: 24h window closed, no template → blocked before the network ───
  {
    const WS = "ws_wasend_c";
    await seedWorkspace(repos, WS);
    await saveCreds(repos, WS);
    const lead = await seedLead(repos, WS, "+91 00000 00073", hoursAgo(72));
    const log = await seedDraftReply(repos, WS, lead.id, "Following up three days later.");

    const stub = installFetchStub(() => ({ status: 200, json: { messages: [{ id: "wamid.SHOULD_NOT_HAPPEN" }] } }));
    let approved;
    try {
      approved = await approveAutoReplyLog(WS, log.id, {}, repos, "owner");
    } finally {
      stub.restore();
    }

    assert(graphCalls(stub.calls).length === 0, `CASE C: the 24h gate must block BEFORE any network call, got ${graphCalls(stub.calls).length}`);
    assert(approved.sendStatus === "blocked", `CASE C: sendStatus blocked, got ${approved.sendStatus}`);
    assert(/template/i.test(String(approved.providerError || "")), `CASE C: the reason tells the owner to pick a template, got "${approved.providerError}"`);
    const activity = await repos.outreachActivity.listByLead(WS, lead.id);
    assert(activity.length === 1 && activity[0].status === "sent_manual" && activity[0].sentManually === true,
      `CASE C: a blocked send is recorded as needing a human, got status=${activity[0]?.status} sentManually=${activity[0]?.sentManually}`);
    // (the assert above already pins "sent_manual"; TypeScript now knows the
    // value cannot be "sent_api", so a second runtime check would be dead code)
    console.log("✅ CASE C — window closed with no template: zero network calls, blocked, recorded as needing a human");
  }

  // ─── CASE D: no credentials at all → honest not_configured ─────────────────
  {
    const WS = "ws_wasend_d";
    await seedWorkspace(repos, WS);
    // Deliberately NO saveCreds() and no env vars.
    const lead = await seedLead(repos, WS, "+91 00000 00074", hoursAgo(1));
    const log = await seedDraftReply(repos, WS, lead.id, "Nobody connected WhatsApp yet.");

    const stub = installFetchStub(() => ({ status: 200, json: { messages: [{ id: "wamid.SHOULD_NOT_HAPPEN" }] } }));
    let approved;
    try {
      approved = await approveAutoReplyLog(WS, log.id, {}, repos, "owner");
    } finally {
      stub.restore();
    }

    assert(graphCalls(stub.calls).length === 0, "CASE D: an unconfigured workspace must not call Meta at all");
    assert(approved.sendStatus === "not_configured", `CASE D: sendStatus not_configured, got ${approved.sendStatus}`);
    const activity = await repos.outreachActivity.listByLead(WS, lead.id);
    assert(activity.length === 1 && activity[0].status === "failed",
      `CASE D: nothing was delivered and nobody was told to deliver it → 'failed', got ${activity[0]?.status}`);
    console.log("✅ CASE D — no credentials: zero network calls, not_configured, outreach honestly 'failed'");
  }

  // ─── CASE E: Meta throttles → the error names the retry delay ──────────────
  {
    const WS = "ws_wasend_e";
    await seedWorkspace(repos, WS);
    await saveCreds(repos, WS);
    const lead = await seedLead(repos, WS, "+91 00000 00075", hoursAgo(1));
    const log = await seedDraftReply(repos, WS, lead.id, "Throttled send.");

    const stub = installFetchStub(() => ({
      status: 429,
      headers: { "retry-after": "42" },
      json: { error: { message: "(#4) Application request limit reached", code: 4 } },
    }));
    let errMsg = "";
    try {
      await approveAutoReplyLog(WS, log.id, {}, repos, "owner");
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
    } finally {
      stub.restore();
    }

    assert(/rate-limiting/i.test(errMsg), `CASE E: throttling must be named as throttling, got "${errMsg}"`);
    assert(/42 seconds/.test(errMsg), `CASE E: the Retry-After value must reach the operator, got "${errMsg}"`);
    console.log("✅ CASE E — Meta throttling is reported as throttling, with the retry delay Meta asked for");
  }

  // ─── CASE F: window closed + template selected → template send ─────────────
  {
    const WS = "ws_wasend_f";
    await seedWorkspace(repos, WS);
    await saveCreds(repos, WS);
    const lead = await seedLead(repos, WS, "+91 00000 00076", hoursAgo(72));
    const log = await seedDraftReply(repos, WS, lead.id, "Reminder body (ignored — the template carries the text).");

    const stub = installFetchStub(() => ({ status: 200, json: { messages: [{ id: "wamid.GOLDEN_F" }] } }));
    let approved;
    try {
      approved = await approveAutoReplyLog(WS, log.id, { templateName: "reminder_v1", templateLanguage: "en_US" }, repos, "owner");
    } finally {
      stub.restore();
    }

    const sent = graphCalls(stub.calls);
    assert(sent.length === 1, `CASE F: exactly one template send, got ${sent.length}`);
    assert(sent[0].body.type === "template", `CASE F: must use the template API outside the window, got type=${String(sent[0].body.type)}`);
    const tpl = sent[0].body.template as { name?: string; language?: { code?: string } };
    assert(tpl?.name === "reminder_v1", `CASE F: the chosen template name is sent, got ${tpl?.name}`);
    assert(tpl?.language?.code === "en_US", `CASE F: the language code is sent, got ${tpl?.language?.code}`);
    assert(approved.sendStatus === "sent", `CASE F: sendStatus sent, got ${approved.sendStatus}`);
    assert(approved.providerMessageId === "wamid.GOLDEN_F", `CASE F: the template send's message id is stored, got ${approved.providerMessageId}`);
    console.log("✅ CASE F — window closed + template chosen: sends type=template with the right name and language");
  }

  console.log("\n✅✅✅ All WhatsApp outbound-send golden cases PASSED (A–F). ✅✅✅");
  console.log("    Proven: approve → per-workspace creds → MetaWhatsAppCloudProvider → HTTP request shape →");
  console.log("    response parsing → auto-reply log, outreach activity, lead status and audit trail.");
  console.log("    Stubbed: fetch only. Not proven: Meta's own acceptance of a real credential (decision D4).");
  console.log("\n    OBSERVATION, now RESOLVED (2026-08-20, S14-1 / N-UX-4): in CASE C and CASE D the draft is");
  console.log("    still stored as \"approved\" even though the customer received nothing — deliberately, because");
  console.log("    the outreach row underneath is honest (sent_manual / failed) and renaming the status would");
  console.log("    break CASE C above for a defect that was purely presentational. What was actually wrong was");
  console.log("    the SCREEN: the approvals badge rendered these rows as \"Approved - Manual Send\" in success");
  console.log("    green, indistinguishable from a real send. Fixed at src/lib/reply-delivery-state.ts, which is");
  console.log("    now the only thing allowed to decide delivery wording and colour, and pinned by");
  console.log("    scripts/golden/golden-approved-not-delivered.ts (CASES A-E).");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
