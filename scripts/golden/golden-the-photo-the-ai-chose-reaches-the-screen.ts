/**
 * golden-the-photo-the-ai-chose-reaches-the-screen.ts — session 55 (2026-09-10).
 *
 * // PRISMA_GOLDEN — opt-in marker read by scripts/run-all-goldens.ts. This is a
 * PERSISTENCE golden: it needs `.env`'s DATABASE_URL and a real Postgres.
 *
 * THE DEFECT THIS EXISTS TO STOP COMING BACK
 * ------------------------------------------
 * Found by asking the product a question a customer would ask — "please send
 * your catalogue with photos and rate list" — and then looking at what the
 * agent actually did with it.
 *
 * The agent did its job. A live deepseek run classified the message, and the
 * engine picked the shade card out of the media catalogue and wrote its id, its
 * URL and its title onto the auto-reply log. The database row held them.
 *
 * `mapAutoReply` — the one function every read goes through — never mentioned
 * those three fields. So the API answered with no media key at all, the reply
 * review screen showed "No attachment" for a draft the AI had attached a
 * catalogue to, and approving that draft sent the customer text with no photo.
 * The owner could not even tell the feature had run.
 *
 * It passed every existing test because the JSON substrate keeps the whole
 * object as written; only Postgres has a hand-written mapper that can forget a
 * column. Production and the demo are Postgres.
 *
 * HAND-COMPUTED CONTRACT (written before running it):
 *
 *   CASE A — the three columns exist. Asked of `information_schema`, so a
 *     client generated from an unapplied migration cannot answer for them.
 *
 *   CASE B — a log written WITH an attachment reads back WITH it. This is the
 *     assertion that was silently false: same id, same URL, same title.
 *
 *   CASE C — the LIST carries it too. The review screen loads a list, not one
 *     record, so a getById that works and a list that drops it would still show
 *     the operator "No attachment".
 *
 *   CASE D — approving keeps the attachment. Approve is where the owner says
 *     "send this"; if the field is dropped there, the AI's choice is lost at
 *     the exact moment it was accepted.
 *
 *   CASE E — approving can also CHANGE the attachment, because the screen lets
 *     the owner pick a different file than the one the AI chose. Overriding the
 *     agent has to be possible, or the dropdown is decoration.
 *
 *   CASE F — the screen defaults to the AI's choice. A read path that returns
 *     the field and a UI that ignores it is the same outage from the customer's
 *     side, so the selector's fallback is pinned in source.
 *
 * ISOLATION (Gate #8): a RUN-tagged workspace, cascade-deleted in `finally`.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-prisma-provider.ts scripts/golden/golden-the-photo-the-ai-chose-reaches-the-screen.ts
 */
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRepositories } from "@/repositories";
import { prisma } from "@/lib/prisma";
import type { AutoReplyLog } from "@/lib/types";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS = `ws_golden_replymedia_${RUN}`;

const repos = createRepositories("prisma");

const CHOSEN = {
  id: `media_golden_chosen_${RUN}`,
  url: `/api/media/media_golden_chosen_${RUN}/file`,
  name: "Om Jari shade card - running range",
};
const OVERRIDE = {
  id: `media_golden_override_${RUN}`,
  url: `/api/media/media_golden_override_${RUN}/file`,
  name: "Neem Zari Thread R",
};

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

let log: AutoReplyLog;

async function seed() {
  await repos.workspace.create({
    id: WS, name: `Reply media golden ${RUN}`, status: "active",
    autonomyKillSwitch: false, autoSendToggle: false,
  });
  // Exactly what WhatsAppConversationEngine writes after chooseMediaAttachment
  // has picked a file: the draft text plus the three attachment fields.
  log = await repos.autoReplyLog.create(WS, {
    channel: "whatsapp",
    incomingMessage: "Please send your catalogue with photos and rate list for zari thread.",
    retrievedContext: { availableMediaCount: 10 },
    classification: "catalogue_request",
    generatedReply: "Namaste! Sharing our running-range shade card with rates.",
    confidenceScore: 0.8,
    canAutoSend: false,
    needsHumanReview: true,
    mediaAttachmentId: CHOSEN.id,
    mediaAttachmentUrl: CHOSEN.url,
    mediaAttachmentName: CHOSEN.name,
    status: "held_for_review",
  });
}

// ─── CASE A ─────────────────────────────────────────────────────────────────
test("CASE A — the attachment columns exist in the database", async () => {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'auto_reply_logs'
       AND column_name IN ('media_attachment_id', 'media_attachment_url', 'media_attachment_name')`,
  );
  assert.strictEqual(rows.length, 3,
    `expected 3 attachment columns, found ${rows.length}. The agent's choice of photo would have ` +
    "nowhere to live.");
});

// ─── CASE B ─────────────────────────────────────────────────────────────────
test("CASE B — a draft written with an attachment reads back with it", async () => {
  const back = await repos.autoReplyLog.getById(WS, log.id);
  assert.ok(back, "the auto-reply log disappeared");
  assert.strictEqual(back!.mediaAttachmentId, CHOSEN.id,
    `the AI attached ${CHOSEN.name} and the read gave back ${JSON.stringify(back!.mediaAttachmentId)}. ` +
    "The choice is in the database and nowhere the product can see it.");
  assert.strictEqual(back!.mediaAttachmentUrl, CHOSEN.url,
    "the URL is lost, so nothing can render or send the file even knowing its id");
  assert.strictEqual(back!.mediaAttachmentName, CHOSEN.name,
    "the title is lost, so the review screen cannot tell the owner WHICH file is going out");
});

// ─── CASE C ─────────────────────────────────────────────────────────────────
test("CASE C — the list the review screen loads carries the attachment", async () => {
  const list = await repos.autoReplyLog.listByWorkspace(WS);
  const mine = list.find((row) => row.id === log.id);
  assert.ok(mine, "the draft is missing from the workspace listing");
  assert.strictEqual(mine!.mediaAttachmentId, CHOSEN.id,
    "getById can return the attachment and the LIST still drop it — the screen loads the list, " +
    "so the owner would still be shown 'No attachment'.");
});

// ─── CASE D ─────────────────────────────────────────────────────────────────
test("CASE D — approving the draft keeps the attachment the AI chose", async () => {
  const approved = await repos.autoReplyLog.approve(WS, log.id, {
    generatedReply: "Namaste! Sharing our running-range shade card with rates.",
    canAutoSend: true,
    mediaAttachmentId: CHOSEN.id,
    mediaAttachmentUrl: CHOSEN.url,
    mediaAttachmentName: CHOSEN.name,
  });
  assert.strictEqual(approved.status, "approved", "approve did not approve");
  assert.strictEqual(approved.mediaAttachmentId, CHOSEN.id,
    "the attachment is dropped at approval — the exact moment the owner said 'send this'");
  const back = await repos.autoReplyLog.getById(WS, log.id);
  assert.strictEqual(back!.mediaAttachmentUrl, CHOSEN.url,
    "the approved row no longer knows what to send");
});

// ─── CASE E ─────────────────────────────────────────────────────────────────
test("CASE E — the owner can approve with a DIFFERENT file than the AI chose", async () => {
  const overridden = await repos.autoReplyLog.approve(WS, log.id, {
    generatedReply: "Namaste! Sending the Neem Zari Thread R card instead.",
    canAutoSend: true,
    mediaAttachmentId: OVERRIDE.id,
    mediaAttachmentUrl: OVERRIDE.url,
    mediaAttachmentName: OVERRIDE.name,
  });
  assert.strictEqual(overridden.mediaAttachmentId, OVERRIDE.id,
    "the owner picked a different file and the agent's original choice was sent anyway");
  assert.strictEqual(overridden.mediaAttachmentName, OVERRIDE.name,
    "the stored title still names the file the owner rejected");
});

// ─── CASE F ─────────────────────────────────────────────────────────────────
test("CASE F — the review screen defaults to the file the AI chose", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "app", "page.tsx"), "utf8");
  assert.ok(/draftMedia\[activeLog\.id\]\s*\?\?\s*activeLog\.mediaAttachmentId/.test(source),
    "the attachment selector no longer falls back to activeLog.mediaAttachmentId. A read path that " +
    "returns the agent's choice and a screen that ignores it is the same outage for the customer: " +
    "the owner approves a draft that looks like it has no photo, and none is sent.");
});

(async () => {
  console.log("=== GOLDEN: the photo the AI chose reaches the screen ===\n");
  let passed = 0;
  let failed = 0;
  try {
    await seed();
    for (const c of cases) {
      try {
        await c.fn();
        passed++;
        console.log(`  PASS  ${c.name}`);
      } catch (e) {
        failed++;
        console.error(`  FAIL  ${c.name}`);
        console.error(`        ${(e as Error).message}`);
      }
    }
  } finally {
    try {
      await prisma.workspace.deleteMany({ where: { id: WS } });
    } catch { /* best-effort */ }
  }

  console.log("");
  console.log(`=== Result: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("golden-the-photo-the-ai-chose-reaches-the-screen FAILED — the agent's attachment does not reach the owner.");
    process.exit(1);
  }
  console.log("golden-the-photo-the-ai-chose-reaches-the-screen ALL GREEN");
  process.exit(0);
})();
