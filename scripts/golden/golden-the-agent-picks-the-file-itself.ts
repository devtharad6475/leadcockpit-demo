/**
 * golden-the-agent-picks-the-file-itself.ts — session 55 (2026-09-10).
 *
 * // PRISMA_GOLDEN — opt-in marker read by scripts/run-all-goldens.ts. This is a
 * PERSISTENCE golden: CASE G needs `.env`'s DATABASE_URL and a real Postgres.
 *
 * THE DEFECT THIS EXISTS TO STOP COMING BACK
 * ------------------------------------------
 * The product claimed the agent chose which file to send. It did not. A keyword
 * rule did, and the rule could not read.
 *
 * Found by asking for one named product — "please share a photo of your Neem
 * Zari Thread R cone and confirm the rate per kg" — with that exact product's
 * photo sitting in the catalogue. The draft came back correct on the words
 * ("Yes, we do have Neem Zari Thread R... Rs. 335/Kg") and the file attached
 * was the general shade card. Adding a `mediaChoiceSource` to the log said
 * plainly what was happening: `"rule"`, with the model naming nothing.
 *
 * The model was never asked. `availableMedia` was passed into the task input,
 * the agent's .md instructions told it to return a `mediaAttachmentId`, and the
 * prompt the model actually receives never mentioned media at all — the
 * REQUIRED JSON block at the end had no such field. A model cannot fill in a
 * field it is not shown, so the fallback rule ran every single time, and the
 * rule prefers any item categorised `catalog` no matter what was asked for.
 *
 * Two smaller failures sat behind it: the schema-recovery path (which exists so
 * a wrong enum does not throw away a good reply) rebuilt the output object
 * without the attachment, silently demoting a reasoned pick to the rule; and a
 * row whose bytes are not in the store looked identical to a real one, so the
 * agent could pick a file that would 404 at Meta.
 *
 * HAND-COMPUTED CONTRACT (written before running it):
 *
 *   CASE A — the prompt asks for the field. Both halves: a section that tells
 *     the model what `availableMedia` is, and `mediaAttachmentId` inside the
 *     REQUIRED JSON block. Either one missing and the model stays silent.
 *
 *   CASE B — the output schema accepts it, or a model that answers correctly
 *     has its answer thrown away at validation.
 *
 *   CASE C — a file the model names WINS over the keyword rule, even when the
 *     rule would have chosen something else. This is the whole feature.
 *
 *   CASE D — a model that declines ("" — I am attaching nothing here) gets its
 *     way. The rule must not overrule a decision by attaching whatever
 *     catalogue it can find; that is how a reply asking a qualifying question
 *     ends up with a file stapled to it.
 *
 *   CASE E — a model that says NOTHING at all still gets the rule. Older and
 *     weaker models omit the field, and for them something sensible beats
 *     nothing.
 *
 *   CASE F — a model naming a file this workspace does not have gets NO
 *     attachment. Substituting a different file would put words in its mouth.
 *
 *   CASE G — a row with no bytes is flagged `fileMissing`. Observed live: asked
 *     for a catalogue, the model correctly picked the row titled "Zari lace
 *     catalogue 2026", which has never had a file behind it. Meta would have
 *     been handed a 404 and the log would have recorded a successful choice.
 *
 *   CASE H — the schema-recovery path carries the attachment through.
 *
 * ISOLATION (Gate #8): a RUN-tagged workspace, cascade-deleted in `finally`.
 * CASES A-F and H touch no substrate.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-prisma-provider.ts scripts/golden/golden-the-agent-picks-the-file-itself.ts
 */
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRepositories } from "@/repositories";
import { prisma } from "@/lib/prisma";
import { chooseMediaAttachment } from "@/services/WhatsAppConversationEngine";
import { WhatsAppLLMReplyOutputSchema } from "@/validation/schemas";
import type { MediaCatalogItem } from "@/lib/types";

const RUN = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const WS = `ws_golden_agentpick_${RUN}`;

const repos = createRepositories("prisma");

const NAMED_PRODUCT = "Neem Zari Thread R";
const ASK_FOR_ONE_PRODUCT = `Please share a photo of your ${NAMED_PRODUCT} cone and confirm the rate per kg.`;

function mediaItem(id: string, title: string, category: MediaCatalogItem["category"]): MediaCatalogItem {
  return {
    id, workspaceId: WS, title, category,
    fileName: `${id}.jpg`, fileType: "image/jpeg", fileSize: 1024,
    url: `/api/media/${id}/file`, storagePath: "",
    status: "active", createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

// A shade card FIRST, so the keyword rule (which prefers `catalog`) would pick
// it if it ran. The product photo is what the customer actually named.
const CATALOGUE = [
  mediaItem("media_shade_card", "Om Jari shade card - running range", "catalog"),
  mediaItem("media_neem_r", NAMED_PRODUCT, "product_image"),
];

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
function test(name: string, fn: Case["fn"]) { cases.push({ name, fn }); }

async function readSource(...segments: string[]) {
  return readFile(path.join(process.cwd(), ...segments), "utf8");
}

// ─── CASE A ─────────────────────────────────────────────────────────────────
test("CASE A — the prompt asks the model to name a file", async () => {
  const prompt = await readSource("src", "llm", "prompts", "whatsappReplyPrompt.ts");
  assert.ok(/availableMedia/.test(prompt),
    "the prompt never mentions availableMedia. The list is passed in the task input and the model " +
    "is never told what it is, so it cannot choose from it.");
  const requiredJsonBlock = prompt.slice(prompt.lastIndexOf("RETURN VALID JSON ONLY"));
  assert.ok(/"mediaAttachmentId"/.test(requiredJsonBlock),
    "mediaAttachmentId is not in the REQUIRED JSON block. A model cannot fill in a field it is " +
    "never shown — this is exactly why the keyword rule ran every single time.");
});

// ─── CASE B ─────────────────────────────────────────────────────────────────
test("CASE B — the output schema accepts the model's choice", async () => {
  const parsed = WhatsAppLLMReplyOutputSchema.safeParse({
    classification: "price_request",
    riskLevel: "high",
    suggestedReply: "Sharing the photo now.",
    confidenceScore: 0.8,
    needsHumanReview: true,
    canAutoSend: false,
    missingKnowledge: false,
    missingQuestion: "",
    mediaAttachmentId: "media_neem_r",
    leadStatusSuggestion: "interested",
    reason: "Named one product.",
  });
  assert.ok(parsed.success, "a correct model answer fails validation");
  assert.strictEqual(parsed.success && parsed.data.mediaAttachmentId, "media_neem_r",
    "the schema drops the field, so a model that answers correctly has its answer thrown away");
});

// ─── CASE C ─────────────────────────────────────────────────────────────────
test("CASE C — the file the model names wins over the keyword rule", async () => {
  const chosen = chooseMediaAttachment(ASK_FOR_ONE_PRODUCT, "price_request", CATALOGUE, "media_neem_r", true);
  assert.ok(chosen, "nothing was attached even though the model named a file it can see");
  assert.strictEqual(chosen!.id, "media_neem_r",
    `the customer named ${NAMED_PRODUCT}, the model picked its photo, and ${chosen!.title} was ` +
    "attached instead. The rule prefers anything categorised 'catalog' and cannot read the message.");
});

// ─── CASE D ─────────────────────────────────────────────────────────────────
test("CASE D — a model that declines is not overruled", async () => {
  const chosen = chooseMediaAttachment("Please send your catalogue", "catalogue_request", CATALOGUE, "", true);
  assert.strictEqual(chosen, undefined,
    "the model said it was attaching nothing and a file was attached anyway. That is how a reply " +
    "that asks a qualifying question ends up with a file stapled to it.");
});

// ─── CASE E ─────────────────────────────────────────────────────────────────
test("CASE E — a model that says nothing still gets the keyword rule", async () => {
  const chosen = chooseMediaAttachment("Please send your catalogue", "catalogue_request", CATALOGUE, undefined, false);
  assert.ok(chosen, "an older model that omits the field now attaches nothing at all — a regression");
  assert.strictEqual(chosen!.category, "catalog",
    "the fallback should still answer a catalogue request with the catalogue");
});

// ─── CASE F ─────────────────────────────────────────────────────────────────
test("CASE F — a file this workspace does not have is not substituted", async () => {
  const chosen = chooseMediaAttachment(ASK_FOR_ONE_PRODUCT, "price_request", CATALOGUE, "media_from_another_workspace", true);
  assert.strictEqual(chosen, undefined,
    "the model named a file that is not in this catalogue and a DIFFERENT file was sent. That puts " +
    "words in the agent's mouth: the draft reasons about one file and the customer receives another.");
});

// ─── CASE G ─────────────────────────────────────────────────────────────────
test("CASE G — a row with no bytes is flagged as unsendable", async () => {
  await repos.workspace.create({
    id: WS, name: `Agent pick golden ${RUN}`, status: "active",
    autonomyKillSwitch: false, autoSendToggle: false,
  });
  // A row with a URL and no file — exactly the shape of seeded demo content and
  // of anything uploaded before the bytes moved into the store.
  const phantom = await repos.mediaCatalog.create(WS, {
    title: "Zari lace catalogue 2026",
    category: "catalog",
    fileName: "zari-catalogue-2026.pdf",
    fileType: "application/pdf",
    fileSize: 2400000,
    url: "/media/zari-catalogue-2026.pdf",
    storagePath: "",
    status: "active",
  });
  const real = await repos.mediaCatalog.create(WS, {
    title: NAMED_PRODUCT,
    category: "product_image",
    fileName: "neem-zari-thread-r.jpg",
    fileType: "image/jpeg",
    fileSize: 8,
    url: "",
    storagePath: "",
    status: "active",
  }, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]));

  const listed = await repos.mediaCatalog.listByWorkspace(WS);
  const phantomRow = listed.find((row) => row.id === phantom.id);
  const realRow = listed.find((row) => row.id === real.id);
  assert.ok(phantomRow && realRow, "the seeded rows are missing from the listing");
  assert.strictEqual(phantomRow!.fileMissing, true,
    "a row with no file behind it looks exactly like a real one. The agent picks it, Meta is handed " +
    "a 404, the customer receives nothing, and the log records a successful choice.");
  assert.strictEqual(realRow!.fileMissing, false,
    "a real upload is being reported as missing, which would hide every working file from the agent");
});

// ─── CASE H ─────────────────────────────────────────────────────────────────
test("CASE H — the schema-recovery path keeps the model's choice", async () => {
  const engine = await readSource("src", "services", "WhatsAppConversationEngine.ts");
  const recovery = engine.slice(engine.indexOf("const recovered: WhatsAppLLMReplyOutput"));
  const block = recovery.slice(0, recovery.indexOf("};"));
  assert.ok(/mediaAttachmentId:/.test(block),
    "the recovery path rebuilds the output without mediaAttachmentId. That branch exists because a " +
    "model got ONE enum wrong; losing its attachment as collateral silently demotes a reasoned pick " +
    "to the keyword rule, and nothing downstream can tell.");
});

(async () => {
  console.log("=== GOLDEN: the agent picks the file itself ===\n");
  let passed = 0;
  let failed = 0;
  try {
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
    console.error("golden-the-agent-picks-the-file-itself FAILED — a keyword rule is choosing what the agent should choose.");
    process.exit(1);
  }
  console.log("golden-the-agent-picks-the-file-itself ALL GREEN");
  process.exit(0);
})();
