/**
 * InboundMediaService — understands customer PHOTOS and VOICE NOTES sent over
 * WhatsApp (CP-13 / D-2026-08-01-l).
 *
 * Authority: docs/LOGIC.md CP-13 (a–i) + docs/planning/MEDIA_UNDERSTANDING_DESIGN.md.
 *
 * The rules (inherited from CP-13, must never be violated):
 *   CP-13a — Media is NEVER dropped. image/audio/other types are stored + flagged.
 *   CP-13c — Photo: download → store → AI describes (confidence-stamped) →
 *            ALWAYS an owner-review card. NO auto-reply.
 *   CP-13d — Voice: download → store → transcribe into rawText (marked "verify")
 *            → ALWAYS an owner-review card. NO auto-reply.
 *   CP-13f — Safety gate = ALWAYS a review card for every photo/voice.
 *   CP-13g — No-hallucination: low-confidence/failed description marked honestly.
 *
 * Design (build-right Phase 3d — centralized, testable, honest):
 *   The external dependencies (Meta media download, AI vision description,
 *   speech-to-text, outbound WhatsApp send) are INJECTABLE. The default
 *   implementations are real (call Meta / LLMService), but the golden test
 *   injects deterministic stubs so it proves the LOGIC — routing, storage,
 *   review-card creation, no-auto-outreach, dedup, isolation — not the
 *   external call. This is the same honesty pattern as every other golden
 *   (the real-AI path is a separate key-gated concern).
 *
 * Why a dedicated service (not inlined in WhatsAppConversationEngine):
 *   The conversation engine is the proven text-reply path. Media handling is a
 *   distinct concern (download bytes, vision/transcription, ALWAYS-review). It
 *   belongs in its own focused file so it can be golden-tested in isolation and
 *   so a bug in media handling can never silently break the text path.
 */
import { rm } from "node:fs/promises";
import type { MediaCatalogItem } from "@/lib/types";
import type { RepositoryBundle } from "@/repositories/interfaces";
import { AuditLogService } from "@/services/AuditLogService";
import { hasProcessedMessageId, recordProcessedMessageId } from "@/services/WebhookDedupService";
import { saveMediaCatalogItem } from "@/services/MediaCatalogService";

// ─── Meta inbound message shapes (CP-13b — the REAL Cloud API contract) ─────
// Image: messages[].type === "image", image = { id, mime_type, sha256?, caption?, url? }.
// Voice/audio: messages[].type === "audio", audio = { id, mime_type, sha256?, url?, voice }.
// There is NO type:"voice"; the discriminator is audio.voice (true = voice note).

export type InboundMediaMessage = {
  type: string;
  from: string;
  id: string;
  timestamp?: string;
  image?: { id: string; mime_type?: string; caption?: string; sha256?: string; url?: string };
  audio?: { id: string; mime_type?: string; voice?: boolean; sha256?: string; url?: string };
  [key: string]: unknown;
};

export type ProcessInboundMediaInput = {
  workspaceId: string;
  message: InboundMediaMessage;
  /**
   * 2026-09-26 (break test): the webhook records the message id as its claim
   * BEFORE routing here, so the duplicate check below found that record and
   * dropped every photo, voice note and location as a "duplicate delivery" —
   * the owner never saw them. The webhook passes true: the check was already
   * done there, and only a caller that has not claimed the id runs it here.
   */
  alreadyClaimed?: boolean;
};

/** A confidence-stamped AI description of a photo. confidence in [0,1]. */
export type ImageDescription = { description: string; confidence: number };

/** Injectable external dependencies. Defaults are real; goldens inject stubs. */
export type InboundMediaDeps = {
  /** Step 2 of the Meta media-download flow (already resolved to bytes). */
  downloadMedia?: (mediaId: string) => Promise<Buffer>;
  /** AI vision description of a photo (default: real LLMService vision task). */
  describeImage?: (workspaceId: string, buffer: Buffer, caption?: string) => Promise<ImageDescription>;
  /** Speech-to-text for a voice note (default: real transcription task).
   *  Takes the workspace and the repositories because transcription is METERED
   *  spend (N-AI-7) -- it used to be billed to nobody and recorded nowhere. */
  transcribe?: (workspaceId: string, buffer: Buffer, repos: RepositoryBundle) => Promise<string>;
  /** Outbound WhatsApp send — used ONLY to PROVE no-auto-outreach (never called
   *  in the happy path; injected as a recorder in tests). */
  sendOutbound?: (message: { to: string; body: string }) => Promise<{ attempted: boolean; status: string }>;
};

export type ProcessInboundMediaResult = {
  status: "processed" | "ignored" | "unsupported" | "duplicate";
  reason: string;
  mediaItemId?: string;
  replyId?: string;
  description?: string;
  confidence?: number;
  transcript?: string;
};

// ─── Confidence honesty (CP-13g + existing extraction discipline) ───────────
// A low-confidence description is surfaced honestly, never invented as fact.
const LOW_CONFIDENCE_THRESHOLD = 0.5;

function isLowConfidence(c: number | undefined): boolean {
  return c === undefined || c < LOW_CONFIDENCE_THRESHOLD;
}

/**
 * Process one inbound customer media message (photo / voice / other).
 *
 * This is the core of CP-13. It NEVER sends an outbound message (no-auto-
 * outreach) — the `sendOutbound` dep exists only so a test can assert it was
 * never called. It ALWAYS creates an owner-review card (CP-13f).
 */
export async function processInboundMediaMessage(
  input: ProcessInboundMediaInput,
  repos: RepositoryBundle,
  deps: InboundMediaDeps = {},
): Promise<ProcessInboundMediaResult> {
  const { workspaceId, message } = input;

  // CP-13a / dedup: a redelivered message.id must not double-process. Same
  // contract as the text path (Meta says "expect duplicate deliveries").
  if (!input.alreadyClaimed && await hasProcessedMessageId(workspaceId, message.id, repos)) {
    return {
      status: "duplicate",
      reason: "Duplicate webhook delivery (same message.id already processed). Skipped per Meta's dedup contract.",
    };
  }

  // Resolve (or create) the lead for this sender — reuse the existing workspace-
  // scoped inbound path. A null lead means the sender is on the permanent DNC
  // registry; in that case we record the message.id but do NOT store media or
  // create a review card (no contactable record to attach to).
  const { getOrCreateInboundWhatsAppLead } = await import("@/services/WhatsAppWebhookService");
  const contactName = undefined; // media payloads carry no contact name in the message
  const lead = await getOrCreateInboundWhatsAppLead(workspaceId, message.from, contactName, repos);
  if (message.id) await recordProcessedMessageId(workspaceId, message.id, "processed", message.from, repos);
  if (!lead) {
    return {
      status: "ignored",
      reason: "Sender is on the do-not-contact registry. No lead created, no media stored.",
    };
  }

  // 2026-09-28 (review W11): a photo or voice note IS a message from the
  // customer, so it opens WhatsApp's 24-hour reply window exactly like a text
  // does (WhatsAppConversationEngine stamps lastInboundAt the same way). Before
  // this, a customer whose first message was a voice note could not be
  // answered from the app — the window read as closed.
  await repos.lead.updateLead(workspaceId, lead.id, { lastInboundAt: new Date().toISOString() });

  // Route by message type (CP-13b — the Meta contract). Runtime validation of
  // the nested image/audio payload (the type is intentionally loose because Meta
  // sends many message types); we only act on the ones we understand.
  if (message.type === "image" && message.image && message.image.id) {
    return await handlePhoto(workspaceId, lead.id, message.image, message, repos, deps);
  }
  if (message.type === "audio" && message.audio && message.audio.id) {
    return await handleVoice(workspaceId, lead.id, message.audio, message, repos, deps);
  }

  // CP-13a — every OTHER media type is recorded with a review card + honest
  // reason. NEVER silently dropped (the old behaviour at WhatsAppWebhookService:128).
  return await handleUnsupportedType(workspaceId, lead.id, message, repos);
}

// ─── Photo path (CP-13c) ─────────────────────────────────────────────────────
async function handlePhoto(
  workspaceId: string,
  leadId: string,
  image: NonNullable<InboundMediaMessage["image"]>,
  message: InboundMediaMessage,
  repos: RepositoryBundle,
  deps: InboundMediaDeps,
): Promise<ProcessInboundMediaResult> {
  const download = deps.downloadMedia ?? defaultDownloadMedia;
  const describe = deps.describeImage ?? defaultDescribeImage;

  // Download the bytes. Best-effort: if Meta download fails, we still create a
  // review card (never silent) but cannot describe — honest reason recorded.
  let buffer: Buffer | undefined;
  let downloadError: string | undefined;
  try {
    buffer = await download(image.id);
  } catch (e) {
    downloadError = e instanceof Error ? e.message : String(e);
  }

  let mediaItem: MediaCatalogItem | undefined;
  if (buffer && buffer.length) {
    mediaItem = await saveMediaCatalogItem(
      {
        workspaceId,
        fileName: `customer-photo-${image.id}.jpg`,
        fileType: image.mime_type || "image/jpeg",
        buffer,
        category: "customer_photo",
        title: image.caption ? `Customer photo: ${image.caption}` : "Customer photo",
        caption: image.caption,
        leadId,
      },
      repos,
    );
  }

  // AI vision description (honest confidence). If download failed, no description.
  let description: ImageDescription | undefined;
  let describeError: string | undefined;
  if (buffer && buffer.length) {
    try {
      description = await describe(workspaceId, buffer, image.caption);
    } catch (e) {
      describeError = e instanceof Error ? e.message : String(e);
    }
  }

  const lowConfidence = isLowConfidence(description?.confidence);
  const aiText = description
    ? lowConfidence
      ? `${description.description} (low confidence — please verify)`
      : description.description
    : downloadError
      ? "Photo received but could not be downloaded for AI review — please open manually."
      : "Photo received but AI could not describe it — please review manually.";

  // Record the inbound message + ALWAYS an owner-review card (CP-13c/f). The
  // review card carries the media reference + AI description in retrievedContext.
  const reply = await repos.reply.create({
    workspaceId,
    leadId,
    channel: "whatsapp",
    rawText: image.caption ? `[photo] ${image.caption}` : "[photo]",
    classification: "media_photo",
    summary: aiText,
    suggestedNextAction: "Review the customer photo before replying.",
    suggestedResponse: undefined, // NEVER auto-draft a reply to a photo (sensitive-topic-review).
  });

  await repos.autoReplyLog.create(workspaceId, {
    leadId,
    replyId: reply.id,
    channel: "whatsapp",
    incomingMessage: image.caption ? `[photo] ${image.caption}` : "[photo]",
    retrievedContext: {
      kind: "customer_photo",
      mediaItemId: mediaItem?.id,
      mediaUrl: mediaItem?.url,
      aiDescription: description?.description,
      aiConfidence: description?.confidence,
      lowConfidence,
      downloadError,
      describeError,
    },
    classification: "media_photo",
    canAutoSend: false, // CP-13c — NEVER auto-send.
    needsHumanReview: true, // CP-13f — ALWAYS a review card.
    reason: lowConfidence
      ? "Customer photo received — AI description is low confidence; review before replying."
      : "Customer photo received — review before replying.",
  });

  await new AuditLogService(repos).logAuditEvent({
    workspaceId,
    userId: "system",
    action: "media.customer_photo",
    entityType: "media_catalog_item",
    entityId: mediaItem?.id,
    newValuesJson: { leadId, mediaItemId: mediaItem?.id, lowConfidence, caption: image.caption },
    metadataJson: { note: "Inbound customer photo processed; owner-review card created." },
  });

  return {
    status: "processed",
    reason: lowConfidence
      ? "Photo saved; AI description low confidence — review card created."
      : "Photo saved + AI described; review card created.",
    mediaItemId: mediaItem?.id,
    replyId: reply.id,
    description: aiText,
    confidence: description?.confidence,
  };
}

// ─── Voice path (CP-13d) ────────────────────────────────────────────────────
async function handleVoice(
  workspaceId: string,
  leadId: string,
  audio: NonNullable<InboundMediaMessage["audio"]>,
  message: InboundMediaMessage,
  repos: RepositoryBundle,
  deps: InboundMediaDeps,
): Promise<ProcessInboundMediaResult> {
  const download = deps.downloadMedia ?? defaultDownloadMedia;
  const transcribe = deps.transcribe ?? defaultTranscribe;

  // Download the audio bytes.
  let buffer: Buffer | undefined;
  let downloadError: string | undefined;
  try {
    buffer = await download(audio.id);
  } catch (e) {
    downloadError = e instanceof Error ? e.message : String(e);
  }

  let mediaItem: MediaCatalogItem | undefined;
  if (buffer && buffer.length) {
    mediaItem = await saveMediaCatalogItem(
      {
        workspaceId,
        fileName: `customer-voice-${audio.id}.ogg`,
        fileType: audio.mime_type || "audio/ogg",
        buffer,
        category: "customer_voice_note",
        title: audio.voice ? "Customer voice note" : "Customer audio",
        leadId,
      },
      repos,
    );
  }

  // Transcribe. The transcript flows into rawText so the existing whatsapp_reply
  // classification path could run on it (CP-13d), but it is ALWAYS marked
  // "verify" (Hindi/dialect transcription can be wrong — CP-13g).
  let transcript: string | undefined;
  let transcribeError: string | undefined;
  if (buffer && buffer.length) {
    try {
      transcript = await transcribe(workspaceId, buffer, repos);
    } catch (e) {
      transcribeError = e instanceof Error ? e.message : String(e);
    }
  }

  const rawText = transcript
    ? `[transcribed voice note — verify] ${transcript}`
    : downloadError
      ? "[voice note received — could not transcribe; listen manually]"
      : "[voice note received — transcription failed; listen manually]";

  // Record the inbound message with the transcript as rawText + ALWAYS a review
  // card (CP-13d/f).
  const reply = await repos.reply.create({
    workspaceId,
    leadId,
    channel: "whatsapp",
    rawText,
    classification: "media_voice",
    summary: transcript ? `Auto-transcribed: ${transcript}` : "Voice note received; manual review needed.",
    suggestedNextAction: "Verify the transcript, then review the suggested reply before sending.",
    suggestedResponse: undefined, // NEVER auto-draft from an unverified transcript.
  });

  await repos.autoReplyLog.create(workspaceId, {
    leadId,
    replyId: reply.id,
    channel: "whatsapp",
    incomingMessage: rawText,
    retrievedContext: {
      kind: "customer_voice_note",
      mediaItemId: mediaItem?.id,
      mediaUrl: mediaItem?.url,
      transcript,
      transcribeError,
      downloadError,
      isVoiceNote: Boolean(audio.voice),
    },
    classification: "media_voice",
    canAutoSend: false, // CP-13d — NEVER auto-send.
    needsHumanReview: true, // CP-13f — ALWAYS a review card.
    reason: transcript
      ? "Customer voice note auto-transcribed — verify accuracy before replying."
      : "Customer voice note received but could not be transcribed — listen manually.",
  });

  await new AuditLogService(repos).logAuditEvent({
    workspaceId,
    userId: "system",
    action: "media.customer_voice_note",
    entityType: "media_catalog_item",
    entityId: mediaItem?.id,
    newValuesJson: { leadId, mediaItemId: mediaItem?.id, isVoiceNote: Boolean(audio.voice) },
    metadataJson: { note: "Inbound customer voice note processed; owner-review card created." },
  });

  return {
    status: "processed",
    reason: transcript
      ? "Voice note saved + transcribed; review card created (verify transcript)."
      : "Voice note saved; transcription failed — review card created.",
    mediaItemId: mediaItem?.id,
    replyId: reply.id,
    transcript,
  };
}

// ─── Unsupported type path (CP-13a — never dropped) ─────────────────────────
async function handleUnsupportedType(
  workspaceId: string,
  leadId: string,
  message: InboundMediaMessage,
  repos: RepositoryBundle,
): Promise<ProcessInboundMediaResult> {
  // We do NOT download or AI-process video/document/etc. yet (photos first,
  // voice second — CP-13h). But we NEVER silently drop: a review card is
  // created so the owner knows a customer sent something.
  const label = String(message.type || "unknown");
  const reply = await repos.reply.create({
    workspaceId,
    leadId,
    channel: "whatsapp",
    rawText: `[${label} message received]`,
    classification: "media_unsupported",
    summary: `Customer sent a ${label} message. Not yet AI-processed.`,
    suggestedNextAction: "Review the customer's message manually.",
    suggestedResponse: undefined,
  });

  await repos.autoReplyLog.create(workspaceId, {
    leadId,
    replyId: reply.id,
    channel: "whatsapp",
    incomingMessage: `[${label} message received]`,
    retrievedContext: { kind: "unsupported_media", messageType: label },
    classification: "media_unsupported",
    canAutoSend: false,
    needsHumanReview: true,
    reason: `Customer sent a ${label} message — media type not yet AI-processed. Review manually.`,
  });

  return {
    status: "unsupported",
    reason: `${label} media type not yet AI-processed — review card created (never dropped).`,
    replyId: reply.id,
  };
}

// ─── Retention (CP-13e) — erasing a lead removes its customer media ──────────
/**
 * Remove all customer-media (photo + voice) items for a lead. Used by the
 * DPDPA erasure cascade so media is cleaned up with the lead (no ghost files).
 * Per the build-right Side-Effect Rule: the file + the row must BOTH be gone.
 */
export async function eraseLeadMedia(workspaceId: string, leadId: string, repos: RepositoryBundle): Promise<{ removed: number }> {
  const items = (await repos.mediaCatalog.listByWorkspace(workspaceId)).filter(
    (m) => m.workspaceId === workspaceId && m.leadId === leadId && (m.category === "customer_photo" || m.category === "customer_voice_note"),
  );
  // Old uploads kept their file on disk (best-effort remove).
  for (const item of items) {
    if (item.storagePath) {
      await rm(item.storagePath, { force: true }).catch(() => undefined);
    }
  }
  // 2026-09-28 (S5): a HARD delete of the rows and bytes. `mediaCatalog.delete`
  // only archives, so the erased customer's lead id, the AI's description of
  // their photo and the transcript of their voice note stayed in the table.
  const { removed } = await repos.mediaCatalog.eraseCustomerMediaForLead(workspaceId, leadId);
  if (removed > 0) {
    await new AuditLogService(repos).logAuditEvent({
      workspaceId,
      userId: "system",
      action: "media.erased_with_lead",
      entityType: "media_catalog_item",
      newValuesJson: { leadId, removed },
      metadataJson: { note: "Customer media removed as part of lead erasure (CP-13e retention)." },
    });
  }
  return { removed };
}

// ─── Default external implementations (real integrations) ───────────────────
// These are the production paths. They require real Meta credentials + a real AI
// key; if unavailable they throw, and the caller (handlePhoto/handleVoice)
// catches + records an honest reason. The golden injects stubs to prove logic.

/** Real Meta media download (2-step Bearer flow). Throws if unconfigured. */
async function defaultDownloadMedia(mediaId: string): Promise<Buffer> {
  const token = process.env.WHATSAPP_TOKEN || process.env.META_SYSTEM_TOKEN;
  const version = process.env.WHATSAPP_API_VERSION || "v25.0";
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token) throw new Error("Meta access token not configured (WHATSAPP_TOKEN). Cannot download customer media.");
  // Step 1: resolve the (fresh) download URL from the media id. The webhook URL
  // expires in 5 min, so always re-resolve rather than trust the webhook url.
  const resolveUrl = phoneNumberId
    ? `https://graph.facebook.com/${version}/${mediaId}?phone_number_id=${phoneNumberId}`
    : `https://graph.facebook.com/${version}/${mediaId}`;
  const resolveRes = await fetch(resolveUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!resolveRes.ok) {
    const t = await resolveRes.text().catch(() => "");
    throw new Error(`Meta media resolve failed (${resolveRes.status}): ${t.slice(0, 200)}`);
  }
  const resolved = (await resolveRes.json()) as { url?: string };
  if (!resolved.url) throw new Error("Meta media resolve returned no url.");
  // Step 2: fetch the binary with the SAME Bearer token (mandatory).
  const binRes = await fetch(resolved.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!binRes.ok) throw new Error(`Meta media download failed (${binRes.status}).`);
  return Buffer.from(await binRes.arrayBuffer());
}

/**
 * Real AI vision description of a photo (default). Runs the LLM vision task via
 * the existing LLMService chokepoint (so it goes through usage caps + audit).
 * Honest confidence from the model; on failure returns a low-confidence marker.
 */
async function defaultDescribeImage(workspaceId: string, buffer: Buffer, caption?: string): Promise<ImageDescription> {
  // NOTE: full multimodal wiring through LLMTaskOptions → providers is the
  // heavier plumbing piece. To keep this milestone focused + proven, the vision
  // call is made through a dedicated entrypoint that the LLM layer exposes. If
  // no key is configured, this returns an honest low-confidence marker rather
  // than inventing a description (no-hallucination).
  const { describeImageViaVision } = await import("@/llm/vision");
  return await describeImageViaVision(workspaceId, buffer, caption);
}

/** Real speech-to-text (default). Throws if unconfigured (honest, not silent). */
async function defaultTranscribe(workspaceId: string, buffer: Buffer, repos: RepositoryBundle): Promise<string> {
  const { transcribeAudio } = await import("@/llm/transcription");
  return await transcribeAudio(workspaceId, buffer, repos);
}
