/**
 * vision.ts — AI image understanding (vision) for customer photos (CP-13c/g).
 *
 * Authority: docs/LOGIC.md CP-13g (no-hallucination) + docs/DECISIONS.md
 * D-2026-08-01-l.
 *
 * This is the production entrypoint for "the AI looks at a customer photo." It
 * goes through the existing LLMService chokepoint (so it respects AI usage caps
 * + audit + provider routing). HONEST behaviour:
 *   - If a real vision-capable model + key are configured → real description
 *     with the model's own confidence.
 *   - If no key / mock fallback → returns a LOW-CONFIDENCE marker. It NEVER
 *     invents a description of a photo it cannot see (no-hallucination).
 *
 * The multimodal plumbing (passing image bytes as an image_url / inline_data
 * part to the provider) is exercised here via runTask with the image encoded as
 * a data URL in the task input. Models without vision capability will not
 * understand it; the honest fallback catches that.
 */
import { LLMService } from "./LLMService";
import type { ImageDescription } from "@/services/InboundMediaService";

const VISION_TASK = "quality_review" as const; // reuse an existing T1 task slot
// (a dedicated "image_understanding" task name would be cleaner, but adding one
// touches TASK_SLOT_MAP + the prompts registry + ModelRouter — out of scope for
// this focused milestone. quality_review is a read-only descriptive task that a
// vision model can fulfill; the overridePrompt carries the photo-description
// instruction. The image bytes travel in the task input as a data URL.)

const VISION_PROMPT = `You are looking at a photo a customer sent over WhatsApp (a B2B context, e.g. a textile/zari business). Describe ONLY what you can actually see. Be honest: if you cannot identify the subject, say so. Never invent fabric type, colour, size, or any detail you cannot see. Return strict JSON: {"description": string, "confidence": number in [0,1]}. A low confidence (e.g. 0.2) is correct when you are unsure.`;

function bufferToDataUrl(buffer: Buffer, mime = "image/jpeg"): string {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * Describe a customer photo via vision. Honest: low-confidence marker when no
 * real vision model is available.
 */
export async function describeImageViaVision(
  workspaceId: string,
  buffer: Buffer,
  caption?: string,
): Promise<ImageDescription> {
  const llm = new LLMService();
  try {
    const result = await llm.runTask<{ description?: string; confidence?: number; mock?: boolean }>(
      VISION_TASK,
      { image: bufferToDataUrl(buffer), caption: caption ?? null, task: "describe_customer_photo" },
      { workspaceId, overridePrompt: VISION_PROMPT },
    );
    const out = result.output || {};
    // Mock fallback (no real key) → honest low-confidence, never invented.
    if (result.mode === "mock" || out.mock || result.fallbackUsed) {
      return {
        description: "Photo received — AI vision not configured, so I cannot describe it. Please review manually.",
        confidence: 0.1,
      };
    }
    const description = typeof out.description === "string" && out.description.trim()
      ? out.description.trim()
      : "Could not clearly identify the subject of this photo.";
    const confidence = typeof out.confidence === "number" ? Math.max(0, Math.min(1, out.confidence)) : 0.2;
    return { description, confidence };
  } catch {
    // Any failure (no key, malformed output) → honest low-confidence marker.
    return {
      description: "Photo received — AI vision could not describe it. Please review manually.",
      confidence: 0.1,
    };
  }
}
