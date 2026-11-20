/**
 * transcription.ts — speech-to-text for customer voice notes (CP-13d/g).
 *
 * Authority: docs/LOGIC.md CP-13d/g + docs/DECISIONS.md D-2026-08-01-l.
 *
 * This is the production entrypoint for "turn a customer voice note into text."
 * The transcript flows into Reply.rawText so the existing whatsapp_reply
 * classification path can run on it. HONEST behaviour:
 *   - If a real transcription provider + key are configured (e.g. OpenAI
 *     Whisper) → real transcript.
 *   - If no key → THROWS (the caller records an honest "transcription failed —
 *     listen manually" reason). Transcription NEVER silently returns an empty
 *     or invented string (no-hallucination).
 *
 * Provider: OpenAI Whisper (audio/transcriptions) is the default. The token
 * comes from the OpenAI-compatible credential slot (TRANSCRIPTION_OPENAI_API_KEY
 * or the existing OPENAI_API_KEY). Audio is sent as multipart form-data.
 */
import { assertSafeFetchUrl } from "@/lib/ssrf-guard";
import { checkCanRunTask, recordUsage } from "@/services/AIUsageService";
import type { RepositoryBundle } from "@/repositories/interfaces";

const WHISPER_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL = process.env.TRANSCRIPTION_MODEL || "whisper-1";

/** whisper-1 list price, USD per minute of audio. */
const WHISPER_USD_PER_MINUTE = 0.006;

/**
 * Estimated cost of transcribing `bytes` of WhatsApp voice audio.
 *
 * Whisper is priced per MINUTE and we do not decode the audio, so this is an
 * estimate and is labelled as one. The assumption is stated rather than hidden:
 * WhatsApp voice notes are Opus at roughly 16 kbps, so ~120,000 bytes/minute.
 * We deliberately assume HALF that (60,000 bytes/minute), which makes every
 * estimate roughly 2x the real cost.
 *
 * That bias is chosen, not accidental. This number feeds a RUNAWAY BRAKE, not
 * an invoice. A brake that trips slightly early costs a customer one refused
 * voice note and a support message; a brake that never trips costs us an
 * unbounded bill. Erring high is the correct direction for the job this number
 * actually does. If per-customer billing is ever built on top of this, decode
 * the real duration first -- do not reuse this figure.
 */
function estimateTranscriptionCost(bytes: number): number {
  return (bytes / 60_000) * WHISPER_USD_PER_MINUTE;
}

/**
 * Transcribe a customer voice note. Throws if no key is configured (honest).
 * The caller is responsible for marking the transcript "verify".
 *
 * ── WHY THIS TAKES A WORKSPACE AND A REPOSITORY BUNDLE (N-AI-7, 2026-08-26) ──
 * It used to take only the audio. That meant every voice note any customer
 * sent us went straight out to OpenAI on a PLATFORM-level key read from the
 * environment, with:
 *
 *   - no spend cap checked      (the caps are per-workspace; none was named)
 *   - no usage recorded         (so the spend appeared in no report anywhere)
 *   - no audit row              (nothing recorded that the call happened)
 *
 * Every other AI call in the product goes through `LLMService.runTask`, which
 * does all three. This one bypassed the chokepoint entirely -- so it was not
 * merely attributed to the wrong tenant (that was the vision bug, fixed the
 * same day); it was invisible. A customer sending ten thousand voice notes was
 * an unbounded, unreported bill on our own card, and nothing in the system
 * would have raised its hand.
 *
 * The gate lives HERE rather than at the call site on purpose. A gate at the
 * call site is a thing every future caller has to remember; a gate inside the
 * function is a thing they cannot forget, and the required `workspaceId` means
 * the compiler asks the question rather than a reviewer. That is the same
 * lesson as the `workspace_demo` default: a rule you have to remember is a rule
 * that eventually gets forgotten.
 *
 * No `agentRun` row is written here. That record belongs to the LLM chokepoint
 * and describes a prompt/response pair, which this is not; the spend is what
 * was unaccounted for, and the spend is what is now accounted for.
 */
export async function transcribeAudio(
  workspaceId: string,
  buffer: Buffer,
  repos: RepositoryBundle,
): Promise<string> {
  // Check BEFORE spending. The estimate is deliberately conservative (see above).
  const estimatedCost = estimateTranscriptionCost(buffer.length);
  const gate = await checkCanRunTask(workspaceId, "voice_transcription", 0, estimatedCost, repos);
  if (!gate.allowed) throw new Error(gate.reason);

  const apiKey = process.env.TRANSCRIPTION_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("No transcription API key configured (TRANSCRIPTION_OPENAI_API_KEY or OPENAI_API_KEY). Cannot transcribe voice note.");
  }

  const safety = await assertSafeFetchUrl(WHISPER_ENDPOINT);
  if (!safety.safe) throw new Error(`Transcription endpoint not allowed: ${safety.reason}`);

  // Whisper accepts the audio as multipart form-data. Voice notes arrive as
  // audio/ogg; codecs=opus (CP-13b) — Whisper accepts ogg/opus directly. We
  // copy the Buffer into a fresh ArrayBuffer-backed Uint8Array because TS5's
  // strict lib.dom types reject a Node Buffer (whose backing may be a
  // SharedArrayBuffer) as a BlobPart.
  const audioBytes = new Uint8Array(buffer.length);
  audioBytes.set(buffer);
  const form = new FormData();
  form.append("file", new Blob([audioBytes]), "voice-note.ogg");
  form.append("model", WHISPER_MODEL);
  form.append("response_format", "text");
  // Indian/Hindi voice notes: Whisper auto-detects language, but we hint prompt
  // context to improve B2B product-term accuracy without forcing a language.
  form.append("prompt", "This is a customer message to a textile/zari business. They may speak Hindi or English and mention products like zari, border, fabric, metres, bulk order, delivery, price.");

  const res = await fetch(safety.url.toString(), {
    method: "POST",
    signal: AbortSignal.timeout(120000),
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Transcription failed (${res.status}): ${errText.slice(0, 200)}`);
  }
  // response_format:"text" returns the transcript as plain text.
  const text = (await res.text()).trim();
  if (!text) throw new Error("Transcription returned empty text (inaudible or corrupt audio).");

  // Record AFTER the call succeeded, matching how the LLM chokepoint does it:
  // a request that threw was not billed by the provider either. tokens=0 is
  // honest -- Whisper is not a token-priced model, and inventing a token count
  // to make the number look familiar would corrupt the token caps for every
  // other task that shares them.
  await recordUsage(workspaceId, { tokens: 0, cost: estimatedCost }, repos);
  return text;
}
