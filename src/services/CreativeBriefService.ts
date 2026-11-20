/**
 * 2026-08-08 — Creative + image-gen brief service.
 *
 * Closes coverage-map rows #46 ("AI generates a creative brief") and #47
 * ("AI prepares an image-gen brief"). Both were ⚫ DARK for the same reason:
 * the creative_generation / image_generation prompts have existed since the
 * task catalog was built (src/llm/prompts/index.ts) and are correctly
 * written ("draft a BRIEF, not the final asset — this system does not
 * generate images"), but NOTHING ever called LLMService.runTask with either
 * task name. A real, well-written prompt with zero callers is still a gap.
 *
 * This does NOT add real image generation (no DALL-E/Imagen adapter) — that
 * was never what rows #46/#47 asked for; their own titles say "brief", and
 * types.ts documents the no-adapter decision as deliberate. This just gives
 * the two existing brief prompts a real, explicit caller.
 *
 * Deliberately NOT reachable from Owner Copilot chat text — image_generation
 * and creative_generation are T4 in ALL_TASK_TIER_MAP (OwnerCopilotService.ts)
 * and the T4 branch is a hard, tested safety gate that never executes from a
 * casual chat line (CASE H, golden-copilot-tasks). These functions are the
 * "dedicated screen" that gate's deflect message already promises exists —
 * called explicitly (e.g. a button on the campaign screen), never from
 * freeform chat text.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import { LLMService } from "@/llm/LLMService";

async function loadCampaignContext(workspaceId: string, campaignId: string, repos: RepositoryBundle) {
  const campaign = await repos.campaign.getById(workspaceId, campaignId);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  const businessProfile = await repos.businessProfile.getByWorkspace(workspaceId);
  return { campaign, businessProfile };
}

export type CreativeBriefOutput = {
  briefName: string;
  format: string;
  audience: string;
  keyMessage: string;
  tone: string;
  mustInclude: string[];
  mustAvoid: string[];
  designerNotes: string;
  confidenceScore: number;
};

export type CreativeBriefResult = {
  brief: CreativeBriefOutput;
  mode: "real" | "mock" | "fallback";
  provider?: string;
  modelName?: string;
};

/** Draft a creative brief (audience, key message, tone, do/don't) for a campaign — for a human designer/copywriter, not a final asset. */
export async function generateCreativeBrief(
  workspaceId: string,
  campaignId: string,
  repos: RepositoryBundle,
): Promise<CreativeBriefResult> {
  const { campaign, businessProfile } = await loadCampaignContext(workspaceId, campaignId, repos);
  const llm = new LLMService();
  const result = await llm.runTask<Partial<CreativeBriefOutput>>("creative_generation", {
    campaignName: campaign.name,
    goal: campaign.goal,
    offer: campaign.offer,
    productFocus: campaign.productFocus,
    targetRegion: campaign.targetRegion,
    companyName: businessProfile?.companyName,
    products: businessProfile?.products,
    tonePreference: businessProfile?.tonePreference,
    strengths: businessProfile?.strengths,
  }, { workspaceId });

  const output = result.output || {};
  return {
    brief: {
      briefName: output.briefName || `${campaign.name} creative brief`,
      format: output.format || "image",
      audience: output.audience || "",
      keyMessage: output.keyMessage || "",
      tone: output.tone || businessProfile?.tonePreference || "",
      mustInclude: Array.isArray(output.mustInclude) ? output.mustInclude : [],
      mustAvoid: Array.isArray(output.mustAvoid) ? output.mustAvoid : ["price claims", "unverified certifications"],
      designerNotes: output.designerNotes || "",
      confidenceScore: typeof output.confidenceScore === "number" ? output.confidenceScore : 0.5,
    },
    mode: result.mode || (result.fallbackUsed ? "fallback" : "mock"),
    provider: result.provider,
    modelName: result.modelName,
  };
}

export type ImageBriefOutput = {
  prompt: string;
  style: string;
  dimensions: string;
  mustShow: string[];
  mustAvoid: string[];
};

export type ImageBriefResult = {
  brief: ImageBriefOutput;
  mode: "real" | "mock" | "fallback";
  provider?: string;
  modelName?: string;
};

/** Prepare an image-generation BRIEF (description for a designer/external tool) for a campaign — never generates the image itself. */
export async function generateImageBrief(
  workspaceId: string,
  campaignId: string,
  repos: RepositoryBundle,
): Promise<ImageBriefResult> {
  const { campaign, businessProfile } = await loadCampaignContext(workspaceId, campaignId, repos);
  const llm = new LLMService();
  const result = await llm.runTask<Partial<ImageBriefOutput>>("image_generation", {
    campaignName: campaign.name,
    offer: campaign.offer,
    productFocus: campaign.productFocus,
    companyName: businessProfile?.companyName,
    products: businessProfile?.products,
  }, { workspaceId });

  const output = result.output || {};
  return {
    brief: {
      prompt: output.prompt || "",
      style: output.style || "photorealistic",
      dimensions: output.dimensions || "1080x1080",
      mustShow: Array.isArray(output.mustShow) ? output.mustShow : [],
      mustAvoid: Array.isArray(output.mustAvoid) ? output.mustAvoid : ["text overlays", "copyrighted logos"],
    },
    mode: result.mode || (result.fallbackUsed ? "fallback" : "mock"),
    provider: result.provider,
    modelName: result.modelName,
  };
}
