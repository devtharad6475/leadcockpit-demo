/**
 * Golden test — an owner who connects WhatsApp through the product can also be
 * replied to, without shell access to the server.
 *
 * WHY THIS EXISTS (2026-09-09, session 55)
 * ----------------------------------------
 * Found while connecting a real Meta test number to the live demo, as an owner
 * would. The Integrations screen says "Paste your WhatsApp Business access
 * token + phone number ID here", stores them encrypted per workspace, and
 * sending worked at once — Meta answered "Connected. WhatsApp number
 * +1 555-641-2188 is reachable."
 *
 * Receiving did not, and could not:
 *
 *   GET /api/inbound/whatsapp-webhook?hub.mode=subscribe&...
 *   403  WhatsApp webhook verification token is not configured.
 *
 * `verifyWhatsAppWebhook` read `process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN` and
 * nothing else. So one half of the same integration was owner-configurable in
 * the UI and the other half required an environment variable on the server.
 * The owner of a workspace could send messages to customers and had no way, at
 * any price, to let customers answer — the product's own screen offered no
 * field, and the only fix was a deploy.
 *
 * That is not a missing nicety. A tenant who cannot receive cannot hold a
 * conversation, which is the product.
 *
 *   CASE A — the workspace's saved token is honoured.
 *
 *   CASE B — the environment variable still works when the workspace has none,
 *     so existing deployments keep working.
 *
 *   CASE C — with neither, the handshake still fails CLOSED. The original
 *     audit note is explicit that a publicly-known default would let anyone
 *     complete Meta's subscription step; adding a second source must not
 *     reintroduce one.
 *
 *   CASE D — the workspace token WINS over the environment variable. The
 *     operator who typed it is the one Meta is talking to, and a stale server
 *     value must not silently beat what the screen shows as saved.
 *
 *   CASE E — a wrong token is still refused, and the challenge is only echoed
 *     on a match. This is the property the whole handshake exists for.
 *
 *   CASE F — the token is stored encrypted and never returned to the screen.
 *     It is a shared secret; the view may say whether one exists, never what
 *     it is.
 *
 * Substrate: pure function for the handshake + static read of the service and
 * the screen. No repository, no network, no AI.
 */
import "./_helpers/isolate-standalone";
import { verifyWhatsAppWebhook } from "@/services/WhatsAppWebhookService";
import { readSource } from "./_helpers/read-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const SERVICE = "src/services/WhatsAppCredentialService.ts";
const SCREEN = "src/app/sections/IntegrationsSection.tsx";
const ROUTE = "src/app/api/[[...path]]/route.ts";

function params(token: string) {
  return new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "CHALLENGE-123" });
}

function main() {
  console.log("=== GOLDEN: an owner can configure being replied to ===\n");

  const envBefore = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  try {
    // ---------------------------------------------------------------- CASE A
    {
      delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
      const result = verifyWhatsAppWebhook(params("owner-chose-this"), "owner-chose-this");
      assert(result.ok, "CASE A: a token saved by the workspace must complete the handshake");
      assert(result.ok && result.challenge === "CHALLENGE-123", "CASE A: the challenge must be echoed back");
      console.log("✅ CASE A — the workspace's own token completes the handshake");
    }

    // ---------------------------------------------------------------- CASE B
    {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "from-the-server";
      const result = verifyWhatsAppWebhook(params("from-the-server"), undefined);
      assert(result.ok, "CASE B: the environment variable must still work for deployments that use it");
      console.log("✅ CASE B — existing env-var deployments keep working");
    }

    // ---------------------------------------------------------------- CASE C
    {
      delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
      const result = verifyWhatsAppWebhook(params("anything"), undefined);
      assert(!result.ok, "CASE C: with no token configured anywhere the handshake must FAIL, never pass");
      const blank = verifyWhatsAppWebhook(params(""), "   ");
      assert(!blank.ok, "CASE C: a whitespace-only saved token must not become a usable secret");
      console.log("✅ CASE C — with nothing configured it fails closed, and blank is not a token");
    }

    // ---------------------------------------------------------------- CASE D
    {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "stale-server-value";
      const workspaceWins = verifyWhatsAppWebhook(params("what-the-owner-typed"), "what-the-owner-typed");
      assert(workspaceWins.ok, "CASE D: the workspace token must win over the environment variable");
      const staleLoses = verifyWhatsAppWebhook(params("stale-server-value"), "what-the-owner-typed");
      assert(!staleLoses.ok, "CASE D: once a workspace token is set, the stale server value must NOT still be accepted");
      console.log("✅ CASE D — what the owner typed beats a stale server value");
    }

    // ---------------------------------------------------------------- CASE E
    {
      delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
      const wrong = verifyWhatsAppWebhook(params("guessed-it"), "the-real-one");
      assert(!wrong.ok, "CASE E: a wrong token must be refused");
      const noChallenge = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "the-real-one" });
      assert(!verifyWhatsAppWebhook(noChallenge, "the-real-one").ok, "CASE E: a missing challenge must be refused");
      console.log("✅ CASE E — a wrong token is refused and the challenge is echoed only on a match");
    }
  } finally {
    if (envBefore === undefined) delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    else process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = envBefore;
  }

  // ---------------------------------------------------------------- CASE F
  {
    const service = readSource(SERVICE);
    assert(
      /encryptedVerifyToken = input\.verifyToken === undefined/.test(service),
      `CASE F: ${SERVICE} must leave a stored verify token alone when the field is not sent`,
    );
    assert(
      /encryptSecret\(input\.verifyToken\.trim\(\), workspaceId\)/.test(service),
      `CASE F: the verify token is a shared secret and must be encrypted at rest like the access token`,
    );
    assert(
      !/verifyToken: .*decryptSecret/.test(service) && /hasVerifyToken:/.test(service),
      `CASE F: the view may say WHETHER a verify token exists, never what it is`,
    );
    const screen = readSource(SCREEN);
    // 2026-09-30 redesign: the field is "Verify password" in step 2 of the WhatsApp panel.
    assert(/aria-label="Verify password"/.test(screen), `CASE F: ${SCREEN} has no field for it, so the owner still cannot set one`);
    assert(/hasVerifyToken \? "Saved/.test(screen), `CASE F: ${SCREEN} must show that one is saved without showing it`);
    const route = readSource(ROUTE);
    assert(
      /getVerifyToken\(defaultWorkspaceId\)/.test(route),
      `CASE F: the webhook route must consult the workspace's saved token`,
    );
    console.log("✅ CASE F — stored encrypted, settable on the screen, never shown back");
  }

  console.log("\n=== GOLDEN PASSED (A-F) ===");
}

main();
