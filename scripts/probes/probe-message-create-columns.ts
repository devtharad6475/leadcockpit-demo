/**
 * probe-message-create-columns.ts — N-DATA-23 verification.
 *
 * THE BUG. Every "generate a message" returned 500 against Postgres:
 *
 *     Invalid `model("messageTemplate").create()` invocation
 *     Unknown argument `missingInformation`. Available options are marked with ?.
 *
 * `createReviewedOutreachDraft()` spread `...normalized` into the create, and
 * `normalized` carries `missingInformation`, which is not a MessageTemplate
 * column — its home is `personalizationUsed.generationMeta.missingInformation`.
 *
 * WHY NOTHING CAUGHT IT. The e2e suite runs on the JSON provider, which accepts
 * unknown keys and stores them. Prisma does not. So the suite was green while
 * the shipping substrate was returning 500 for the feature.
 *
 * WHAT THIS PROVES, AND WHY IT COSTS NOTHING. The failing call is behind a paid
 * DeepSeek generation, so re-driving it through the UI would spend money to
 * learn one fact. This calls the REPOSITORY directly with the exact payload
 * shape from the error log — including the stray key — which is the layer the
 * error came from. No LLM, no network, no cost.
 *
 * WHAT IT WRITES AND DELETES. One message_templates row, created and then
 * deleted in a `finally`, inside this project's own database only. It touches
 * nothing else.
 *
 * Run: npx tsx scripts/probes/probe-message-create-columns.ts
 */
import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd());

async function main() {
  process.env.PERSISTENCE_PROVIDER = "prisma";
  const { createRepositories } = await import("@/repositories");
  const { prisma } = await import("@/lib/prisma");
  const repos = createRepositories();

  const workspaceId = "workspace_demo";
  const campaign = (await repos.campaign.listByWorkspace(workspaceId))[0];
  if (!campaign) throw new Error("no campaign in workspace_demo — cannot probe");

  // The exact shape from the 500, stray key included. If the repository still
  // forwards unknown keys to Prisma, this create throws exactly as it did in
  // the server log; if the fix holds, the key is dropped and the row is written.
  const payload = {
    workspaceId,
    campaignId: campaign.id,
    channel: "whatsapp",
    body: "N-DATA-23 probe row. Not a real outreach message.",
    tone: "Warm, concise, businesslike",
    language: "English",
    status: "draft" as const,
    personalizationUsed: { generationMeta: { agentName: "probe", missingInformation: ["a", "b"] } },
    // NOT a column. This is the whole point of the probe.
    missingInformation: ["reviewed Product Settings", "open knowledge conflicts"],
  };

  let createdId = "";
  try {
    const created = await repos.messageTemplate.create(payload as Parameters<typeof repos.messageTemplate.create>[0]);
    createdId = created.id;

    const meta = (created.personalizationUsed as { generationMeta?: { missingInformation?: unknown } } | undefined)?.generationMeta;
    const metaList = Array.isArray(meta?.missingInformation) ? meta?.missingInformation : undefined;

    console.log("PASS  create() accepted the payload with the stray key present.");
    console.log(`      row id            : ${createdId}`);
    console.log(`      body stored       : ${created.body === payload.body ? "matches" : "MISMATCH"}`);
    console.log(`      stray key dropped : ${"missingInformation" in (created as Record<string, unknown>) ? "NO — still present" : "yes"}`);
    console.log(`      meta list kept    : ${metaList ? JSON.stringify(metaList) : "MISSING — generationMeta lost its list"}`);

    if (!metaList) {
      console.error("FAIL  the list that belongs in generationMeta did not survive the write.");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("FAIL  create() still rejects the payload:");
    console.error("      " + (error as Error).message.split("\n").slice(0, 6).join("\n      "));
    process.exitCode = 1;
  } finally {
    if (createdId) {
      await prisma.messageTemplate.delete({ where: { id: createdId } }).catch(() => {});
      console.log(`      probe row ${createdId} deleted.`);
    }
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
