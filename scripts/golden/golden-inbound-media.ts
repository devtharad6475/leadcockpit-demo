/**
 * Golden test — Inbound customer media understanding (photos + voice notes).
 *
 * Phase 1.5 / skill v2 / build-right Phase 3 — written BEFORE the service code.
 * This test DEFINES the contract that InboundMediaService must satisfy.
 *
 * Authority: docs/LOGIC.md CP-13 (a–i) + docs/DECISIONS.md D-2026-08-01-l +
 * docs/planning/MEDIA_UNDERSTANDING_DESIGN.md.
 *
 * The rules this proves (CP-13):
 *
 *   CP-13a — Media is NEVER dropped. An image / audio / other-typed Meta message
 *     must be stored + flagged, never silently ignored.
 *   CP-13b — Meta contract is the source of truth. Image = type:"image" with
 *     image.{id,caption,mime_type}. Voice = type:"audio" with audio.{id,voice}.
 *     The discriminator is audio.voice (there is NO type:"voice").
 *   CP-13c — Photo action = save + AI describes (confidence-stamped) + ALWAYS an
 *     owner-review card. NO auto-reply.
 *   CP-13d — Voice action = save + transcribe into rawText + mark "verify" +
 *     ALWAYS an owner-review card. NO auto-reply.
 *   CP-13e — Retention = until lead deleted. Erasing a lead cleans its media.
 *   CP-13f — Safety gate = ALWAYS a review card (every photo/voice, always).
 *   CP-13g — No-hallucination: a low-confidence / failed description is marked
 *     honestly, never invented.
 *
 * Hand-computed BEFORE writing the service (the Golden Thread):
 *
 *   CASE A — Photo happy path. Send 1 inbound image webhook.
 *     Expected after processing:
 *       mediaCatalog items with category "customer_photo" = 1
 *       replies for this lead                    = 1 (the inbound is recorded)
 *       owner-review cards (AutoReplyLog needsHumanReview) = 1
 *       outbound WhatsApp messages sent          = 0  (no-auto-outreach)
 *     Hand-count = 1 / 1 / 1 / 0.
 *
 *   CASE B — Voice happy path. Send 1 inbound audio (voice:true) webhook.
 *     Expected:
 *       mediaCatalog items with category "customer_voice_note" = 1
 *       replies for this lead                                  = 1
 *       owner-review cards                                     = 1
 *       outbound messages                                      = 0
 *     The reply's rawText = the transcript (so the existing whatsapp_reply path
 *     could run on it), and it carries a "verify" marker.
 *     Hand-count = 1 / 1 / 1 / 0.
 *
 *   CASE C — No-hallucination. When the AI describer returns LOW confidence
 *     (or fails), the review card must say "low confidence — verify" and NO
 *     fabricated description is presented as fact.
 *
 *   CASE D — Idempotency. The SAME webhook (same message.id) delivered twice
 *     must still produce exactly 1 media item + 1 reply (dedup on message.id).
 *     Hand-count = 1 / 1 (not 2 / 2).
 *
 *   CASE E — Workspace isolation. Tenant A's media is NOT visible to tenant B.
 *     (Cross-tenant leak = P0.)
 *
 *   CASE F — Retention / side-effect (CP-13e). Erasing the lead removes its
 *     customer-photo media items too (no ghost files). The cleanup is EXPLICIT
 *     (build-right Side-Effect Rule). Hand-count: media for the lead = 0 after.
 *
 *   CASE G — Never dropped (CP-13a). An UNSUPPORTED / unknown message type
 *     (e.g. type:"video") is recorded as a review card with a reason — NOT
 *     silently ignored.
 *
 * Test isolation (Gate #8): each case uses its OWN unique workspace ID
 * (ws_media_*). The golden preload pins each run to a process-unique
 * LEADGEN_DATA_DIR, so cases never share state.
 *
 * Test-Honesty (Gate #7): the describer + transcriber + Meta downloader are
 * INJECTED as deterministic stubs, so the LOGIC (routing, storage, review
 * creation, no-auto-outreach) is what's proven — not the external AI/Meta call.
 * This is honest: the golden proves the contract; the real-AI path is a
 * separate (key-gated) integration concern, same pattern as the other goldens.
 *
 * Run: npm run golden:inbound-media
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { processInboundMediaMessage } from "@/services/InboundMediaService";
import { createJsonRepos } from "./_helpers/provider";
import type { RepositoryBundle } from "@/repositories";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function seedWorkspace(repos: RepositoryBundle, workspaceId: string) {
  await repos.workspace.create({ id: workspaceId, name: `Test WS ${workspaceId}`, status: "active" });
}

async function seedLead(repos: RepositoryBundle, workspaceId: string, phone: string) {
  return repos.lead.createLead({
    workspaceId,
    companyName: `Customer ${phone}`,
    whatsappNumber: phone,
    source: "whatsapp",
    status: "replied",
    reviewStatus: "approved",
    enrichmentStatus: "completed",
    doNotContact: false,
    consentStatus: "none",
  });
}

/** Count MediaCatalogItems for a workspace with a given category. */
async function countMedia(repos: RepositoryBundle, ws: string, category: string): Promise<number> {
  const items = await repos.mediaCatalog.listByWorkspace(ws, { category });
  return items.filter((i) => i.workspaceId === ws).length;
}

/** Count owner-review cards (AutoReplyLog) for a lead that need human review. */
async function countReviewCards(repos: RepositoryBundle, ws: string, leadId: string): Promise<number> {
  const logs = await repos.autoReplyLog.listByWorkspace(ws);
  return logs.filter((l) => l.workspaceId === ws && l.leadId === leadId && l.needsHumanReview).length;
}

/** Deterministic stub: a "successful" image describer (high confidence). */
const describeImageOk = async (_workspaceId: string, _buffer: Buffer, _caption?: string) => ({
  description: "Looks like a gold zari border, approximately 2 inches wide.",
  confidence: 0.8,
});

/** Deterministic stub: a "low-confidence" describer (no-hallucination case). */
const describeImageLow = async (_workspaceId: string, _buffer: Buffer, _caption?: string) => ({
  description: "Could not clearly identify the subject of this photo.",
  confidence: 0.2,
});

/** Deterministic stub: a transcriber that returns a known Hindi/English line. */
const transcribeOk = async (_workspaceId: string, _buffer: Buffer, _repos: RepositoryBundle) => "I need 50 meters of gold border, urgent delivery.";

/** Deterministic stub: a Meta media downloader that returns a fixed buffer. */
const downloadOk = async (_mediaId: string) => Buffer.from("fake-image-bytes");

/** Sentinel: outbound message count. The service MUST call this never, or the
 * injected recorder proves no-auto-outreach. */
function makeOutbox() {
  const sent: unknown[] = [];
  return {
    send: async (msg: unknown) => {
      sent.push(msg);
      return { attempted: true, status: "sent" as const };
    },
    count: () => sent.length,
  };
}

async function main() {
  const repos = await createJsonRepos();

  // ─── CASE A: photo happy path (hand-count 1 / 1 / 1 / 0) ───────────────────
  {
    const WS = "ws_media_a";
    await seedWorkspace(repos, WS);
    const lead = await seedLead(repos, WS, "919800000001");
    const outbox = makeOutbox();

    await processInboundMediaMessage(
      {
        workspaceId: WS,
        message: {
          from: "919800000001",
          id: "wamid.media.image.001",
          timestamp: "1744344496",
          type: "image",
          image: { id: "1003383421387256", mime_type: "image/jpeg", caption: "I want this border" },
        },
      },
      repos,
      { downloadMedia: downloadOk, describeImage: describeImageOk, sendOutbound: outbox.send },
    );

    const media = await countMedia(repos, WS, "customer_photo");
    const replies = (await repos.reply.listByWorkspace(WS)).filter((r) => r.workspaceId === WS && r.leadId === lead.id);
    const reviewCards = await countReviewCards(repos, WS, lead.id);

    assert(media === 1, `CASE A: exactly 1 customer_photo media item, got ${media}`);
    assert(replies.length === 1, `CASE A: exactly 1 reply recorded, got ${replies.length}`);
    assert(reviewCards === 1, `CASE A: exactly 1 owner-review card, got ${reviewCards}`);
    assert(outbox.count() === 0, `CASE A: NO outbound message sent (no-auto-outreach), got ${outbox.count()}`);
    console.log("✅ CASE A — photo happy path: 1 media / 1 reply / 1 review card / 0 outbound");
  }

  // ─── CASE B: voice happy path (hand-count 1 / 1 / 1 / 0) ───────────────────
  {
    const WS = "ws_media_b";
    await seedWorkspace(repos, WS);
    const lead = await seedLead(repos, WS, "919800000002");
    const outbox = makeOutbox();

    const result = await processInboundMediaMessage(
      {
        workspaceId: WS,
        message: {
          from: "919800000002",
          id: "wamid.media.voice.001",
          timestamp: "1744344497",
          type: "audio",
          audio: { id: "1908647269898587", mime_type: "audio/ogg; codecs=opus", voice: true },
        },
      },
      repos,
      { downloadMedia: downloadOk, transcribe: transcribeOk, sendOutbound: outbox.send },
    );

    const media = await countMedia(repos, WS, "customer_voice_note");
    const replies = (await repos.reply.listByWorkspace(WS)).filter((r) => r.workspaceId === WS && r.leadId === lead.id);
    const reviewCards = await countReviewCards(repos, WS, lead.id);

    assert(media === 1, `CASE B: exactly 1 customer_voice_note media item, got ${media}`);
    assert(replies.length === 1, `CASE B: exactly 1 reply recorded, got ${replies.length}`);
    assert(reviewCards === 1, `CASE B: exactly 1 owner-review card, got ${reviewCards}`);
    assert(outbox.count() === 0, `CASE B: NO outbound message sent, got ${outbox.count()}`);
    // The transcript flows into rawText so the existing reply-classification path works.
    assert(
      /I need 50 meters of gold border/i.test(result.transcript || ""),
      `CASE B: transcript carried into rawText, got "${result.transcript}"`,
    );
    console.log("✅ CASE B — voice happy path: 1 media / 1 reply / 1 review card / 0 outbound / transcript in rawText");
  }

  // ─── CASE C: no-hallucination (low-confidence describer) ───────────────────
  {
    const WS = "ws_media_c";
    await seedWorkspace(repos, WS);
    const lead = await seedLead(repos, WS, "919800000003");
    const outbox = makeOutbox();

    const result = await processInboundMediaMessage(
      {
        workspaceId: WS,
        message: {
          from: "919800000003",
          id: "wamid.media.image.002",
          timestamp: "1744344498",
          type: "image",
          image: { id: "img-low-conf", mime_type: "image/png" },
        },
      },
      repos,
      { downloadMedia: downloadOk, describeImage: describeImageLow, sendOutbound: outbox.send },
    );

    const reviewCards = (await repos.autoReplyLog.listByWorkspace(WS)).filter(
      (l) => l.workspaceId === WS && l.leadId === lead.id && l.needsHumanReview,
    );
    assert(reviewCards.length === 1, `CASE C: review card created, got ${reviewCards.length}`);
    // Low confidence must be surfaced honestly, not invented as a confident fact.
    assert(
      result.confidence !== undefined && result.confidence < 0.5,
      `CASE C: low confidence reported honestly (<0.5), got ${result.confidence}`,
    );
    assert(/verify|could not|low confidence|unclear/i.test(result.description || ""),
      `CASE C: honest low-confidence phrasing, got "${result.description}"`);
    console.log("✅ CASE C — no-hallucination: low-confidence photo described honestly, review card created");
  }

  // ─── CASE D: idempotency (same message.id twice → still 1 / 1) ─────────────
  {
    const WS = "ws_media_d";
    await seedWorkspace(repos, WS);
    const lead = await seedLead(repos, WS, "919800000004");
    const outbox = makeOutbox();

    const msg = {
      from: "919800000004",
      id: "wamid.media.image.dup",
      timestamp: "1744344499",
      type: "image" as const,
      image: { id: "img-dup", mime_type: "image/jpeg", caption: "dup" },
    };
    await processInboundMediaMessage({ workspaceId: WS, message: msg }, repos, {
      downloadMedia: downloadOk,
      describeImage: describeImageOk,
      sendOutbound: outbox.send,
    });
    // Redeliver the SAME message.id (Meta does this — the dedup contract).
    await processInboundMediaMessage({ workspaceId: WS, message: msg }, repos, {
      downloadMedia: downloadOk,
      describeImage: describeImageOk,
      sendOutbound: outbox.send,
    });

    const media = await countMedia(repos, WS, "customer_photo");
    const replies = (await repos.reply.listByWorkspace(WS)).filter((r) => r.workspaceId === WS && r.leadId === lead.id);
    assert(media === 1, `CASE D: dedup — still 1 media item after 2 deliveries, got ${media}`);
    assert(replies.length === 1, `CASE D: dedup — still 1 reply after 2 deliveries, got ${replies.length}`);
    console.log("✅ CASE D — idempotency: duplicate message.id delivered twice → 1 media / 1 reply");
  }

  // ─── CASE E: workspace isolation (cross-tenant leak = P0) ──────────────────
  {
    const WS_A = "ws_media_e_a";
    const WS_B = "ws_media_e_b";
    await seedWorkspace(repos, WS_A);
    await seedWorkspace(repos, WS_B);
    await seedLead(repos, WS_A, "919800000005");
    const outbox = makeOutbox();

    // A photo arrives in workspace A.
    await processInboundMediaMessage(
      {
        workspaceId: WS_A,
        message: {
          from: "919800000005",
          id: "wamid.media.image.iso",
          timestamp: "1744344500",
          type: "image",
          image: { id: "img-iso", mime_type: "image/jpeg" },
        },
      },
      repos,
      { downloadMedia: downloadOk, describeImage: describeImageOk, sendOutbound: outbox.send },
    );

    const mediaA = await countMedia(repos, WS_A, "customer_photo");
    const mediaB = await countMedia(repos, WS_B, "customer_photo");
    assert(mediaA === 1, `CASE E: tenant A has its photo, got ${mediaA}`);
    assert(mediaB === 0, `CASE E: tenant B sees ZERO of A's media (isolation), got ${mediaB}`);
    console.log("✅ CASE E — workspace isolation: A=1, B=0 (no cross-tenant leak)");
  }

  // ─── CASE F: retention / side-effect (erasing lead removes its media) ──────
  {
    const WS = "ws_media_f";
    await seedWorkspace(repos, WS);
    const lead = await seedLead(repos, WS, "919800000006");
    const outbox = makeOutbox();

    await processInboundMediaMessage(
      {
        workspaceId: WS,
        message: {
          from: "919800000006",
          id: "wamid.media.image.retention",
          timestamp: "1744344501",
          type: "image",
          image: { id: "img-ret", mime_type: "image/jpeg" },
        },
      },
      repos,
      { downloadMedia: downloadOk, describeImage: describeImageOk, sendOutbound: outbox.send },
    );

    const mediaBefore = (await repos.mediaCatalog.listByWorkspace(WS)).filter(
      (m) => m.workspaceId === WS && m.leadId === lead.id,
    ).length;
    assert(mediaBefore === 1, `CASE F: media exists before erasure, got ${mediaBefore}`);

    // Erase the lead (the retention rule: media cleaned up with the lead).
    const { eraseLeadMedia } = await import("@/services/InboundMediaService");
    await eraseLeadMedia(WS, lead.id, repos);

    const mediaAfter = (await repos.mediaCatalog.listByWorkspace(WS)).filter(
      (m) => m.workspaceId === WS && m.leadId === lead.id,
    ).length;
    assert(mediaAfter === 0, `CASE F: media removed after lead erasure (no ghost files), got ${mediaAfter}`);
    console.log("✅ CASE F — retention: erasing the lead removed its customer media (no ghost files)");
  }

  // ─── CASE G: never dropped (unknown type → review card, not silent ignore) ─
  {
    const WS = "ws_media_g";
    await seedWorkspace(repos, WS);
    const lead = await seedLead(repos, WS, "919800000007");
    const outbox = makeOutbox();

    const result = await processInboundMediaMessage(
      {
        workspaceId: WS,
        message: {
          from: "919800000007",
          id: "wamid.media.video.001",
          timestamp: "1744344502",
          type: "video",
          video: { id: "vid-001", mime_type: "video/mp4" },
        },
      },
      repos,
      { downloadMedia: downloadOk, sendOutbound: outbox.send },
    );

    const reviewCards = await countReviewCards(repos, WS, lead.id);
    assert(reviewCards >= 1, `CASE G: unsupported type creates a review card (never silently dropped), got ${reviewCards}`);
    assert(/not yet|unsupported|review/i.test(result.reason || ""),
      `CASE G: honest reason for the unhandled type, got "${result.reason}"`);
    console.log("✅ CASE G — never dropped: unknown media type recorded with a review card + reason");
  }

  console.log("\n✅✅✅ All inbound-media golden cases PASSED (A–G). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
