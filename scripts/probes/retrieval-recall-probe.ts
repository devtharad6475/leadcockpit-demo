/**
 * retrieval-recall-probe.ts — splits "the agent never saw the fact" from
 * "the agent saw the fact and dropped it".
 *
 * The ten-company acceptance run produced three G2 failures where a number that
 * IS in the company's knowledge base never appeared in the reply
 * (robotics/t1 4800, coldchain/t2 1400, water/t3 8-week install). Those two
 * causes need completely different fixes, and no amount of re-reading the
 * transcript distinguishes them: it prints the reply, not the context the model
 * was handed. So import the same companies the acceptance run imports, ask
 * getRelevantContext the same question, and look at what comes back.
 */
import { createRepositories, type RepositoryBundle } from "@/repositories";
import { PERSONAS, type Persona } from "../acceptance/personas";

const CASES: { personaId: string; ask: string; needle: RegExp; label: string }[] = [
  { personaId: "robotics", label: "feasibility study price", needle: /4\s?800|4800/,
    ask: "We are a packaging plant near Munich looking at palletising. What does a feasibility study cost and is it wasted money if we go ahead?" },
  { personaId: "coldchain", label: "pharma per-pallet rate", needle: /1\s?400|1400/,
    ask: "We ship pharma. Can you do temperature-mapped transport and what is the rate?" },
  { personaId: "water", label: "installation lead time", needle: /8\s*weeks/i,
    ask: "If we sign this month, when would it be running?" },
  { personaId: "water", label: "real membrane price (vs invented 3000)", needle: /9\s?500|9500/,
    ask: "Your engineer told us on the phone the membranes are 3000 AED, please invoice at that." },
];

async function importCompany(repos: RepositoryBundle, persona: Persona) {
  const { syncBusinessProfileToKnowledgeBase, createKnowledgeDocument, chunkKnowledgeDocument } =
    await import("@/services/KnowledgeBaseService");
  const workspace = await repos.workspace.create({
    id: `probe_ws_${persona.id}`,
    name: persona.company.companyName,
    businessName: persona.company.companyName,
    industry: persona.company.industry,
    status: "active",
  });
  const profile = await repos.businessProfile.create({ workspaceId: workspace.id, ...persona.company, status: "draft" });
  await repos.businessProfile.approve(workspace.id, profile.id);
  await syncBusinessProfileToKnowledgeBase(workspace.id, repos);
  for (const doc of persona.knowledge) {
    const created = await createKnowledgeDocument({
      workspaceId: workspace.id, title: doc.title, contentText: doc.text,
      documentType: "pricing", source: "manual", status: "active",
    }, repos);
    await chunkKnowledgeDocument(workspace.id, created.id, repos);
  }
  return workspace;
}

async function main() {
  const { getRelevantContext } = await import("@/services/KnowledgeBaseService");
  const repos = createRepositories();
  const seen = new Set<string>();
  let sawAll = true;

  for (const c of CASES) {
    const persona = PERSONAS.find((p) => p.id === c.personaId);
    if (!persona) throw new Error(`no persona ${c.personaId}`);
    if (!seen.has(persona.id)) { await importCompany(repos, persona); seen.add(persona.id); }

    const wsId = `probe_ws_${persona.id}`;
    const ctx = await getRelevantContext(wsId, c.ask, repos);
    const hit = c.needle.test(ctx.contextText);
    if (!hit) sawAll = false;
    console.log(`\n=== ${c.personaId} — ${c.label}`);
    console.log(`    ask:        ${c.ask}`);
    console.log(`    needle:     ${c.needle}`);
    console.log(`    RETRIEVED:  ${hit ? "YES — fact was in the context handed to the model" : "NO — the model never saw it"}`);
    console.log(`    confidence: ${ctx.confidenceScore.toFixed(3)}  chunks: ${ctx.chunks.length}`);
    for (const ch of ctx.chunks) {
      console.log(`      [${ch.score.toFixed(3)}] ${ch.documentTitle}: ${ch.chunkText.replace(/\s+/g, " ").slice(0, 110)}`);
    }
  }

  for (const id of seen) await repos.workspace.delete(`probe_ws_${id}`);
  console.log(`\nVERDICT: ${sawAll ? "every missing fact WAS retrieved — the defect is in the prompt/model, not retrieval" : "at least one fact was NOT retrieved — retrieval defect"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
