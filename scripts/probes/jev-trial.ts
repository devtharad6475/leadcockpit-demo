/**
 * jev-trial.ts — step 2 of the Jev trial (docs/planning/JEV_TRIAL.md).
 *
 * Asks three contestants the same two factual questions about each business
 * collected by jev-trial-collect.ts, and scores them against the labels that
 * were frozen before any model ran:
 *   A. today's built-in rule (heuristicScores, the product's own code) — free
 *   B. our current AI (DeepSeek deepseek-chat, the workhorse slot default)
 *   C. Jev (TypeSafe, jev-latest)
 *
 * Every answer is cached in _receipts/jev-trial-answers.json, so a re-run
 * never pays twice. A contestant whose key is missing is skipped, not faked.
 * Read-only: nothing is written to the database, nothing is sent. Keys are
 * read from .env and never printed.
 *
 *   npx tsx scripts/probes/jev-trial.ts
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());
process.env.PERSISTENCE_PROVIDER = "json";

const DIR = path.join(process.cwd(), "scripts/probes/_receipts");
// JEV_TRIAL_SET=2 reads the second, held-out set (collected after the rule was written).
const SET = process.env.JEV_TRIAL_SET === "2" ? "-2" : "";
const BUSINESSES = path.join(DIR, `jev-trial-businesses${SET}.json`);
const LABELS = path.join(DIR, `jev-trial-labels${SET}.json`);
const ANSWERS = path.join(DIR, `jev-trial-answers${SET}.json`);

type Kind = "maker" | "wholesaler" | "retail" | "unrelated";
type Business = { id: string; companyName: string; buyerType?: string; industry?: string; discoveredInfo?: string; address?: string; websiteUrl?: string };
type Answer = { kind: Kind | null; textile: boolean | null; confidence?: number; ms: number; inputTokens: number; outputTokens: number; costUsd: number; error?: string };

const KIND_CRITERIA: Record<Kind, string> = {
  maker: "Makes textiles, garments, sarees, lehengas or embroidery: a factory, mill, manufacturer, or embroidery / job-work unit",
  wholesaler: "Buys and sells textiles or garments in bulk to other businesses: a wholesaler, trader or bulk dealer",
  retail: "Sells to the public: a shop, showroom, boutique, bridal store, dress rental, or tailor",
  unrelated: "Something else: a school, classes, design studio, or an unrelated trade",
};
const KIND_QUESTION = "What kind of business is this?";
const TEXTILE_QUESTION = "This business works with textiles, garments, embroidery or trims.";

// List prices (USD). Jev: $0.042 per million input tokens, output free
// (docs.typesafe.ai pricing). DeepSeek: the rates the product itself uses
// (src/llm/LLMService.ts RATES_PER_1K_TOKENS_USD).
const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
const DEEPSEEK_USD = { input: 0.0003 / 1000, output: 0.0012 / 1000 };

function listingText(b: Business) {
  return [
    `Business name: ${b.companyName}`,
    b.buyerType ? `Google Maps category: ${b.buyerType}` : "",
    b.industry && b.industry !== b.buyerType ? `Other categories: ${b.industry}` : "",
    b.discoveredInfo ? `Listing details: ${b.discoveredInfo}` : "",
    b.websiteUrl ? `Website: ${b.websiteUrl}` : "",
  ].filter(Boolean).join("\n");
}

async function askJev(b: Business, key: string): Promise<Answer> {
  const start = performance.now();
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      state: listingText(b),
      model: "jev-latest",
      questions: {
        kind: { type: "choice", instructions: KIND_QUESTION, criteria: KIND_CRITERIA },
        textile: { type: "noul", instructions: TEXTILE_QUESTION },
      },
    }),
  });
  const ms = performance.now() - start;
  if (!response.ok) throw new Error(`Jev returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json() as {
    model?: string;
    answers: { kind: { choice: Kind; confidence: number }; textile: { noul: number } };
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const inputTokens = body.usage?.input_tokens ?? 0;
  return {
    kind: body.answers.kind.choice,
    confidence: body.answers.kind.confidence,
    textile: body.answers.textile.noul >= 0.5,
    ms,
    inputTokens,
    outputTokens: body.usage?.output_tokens ?? 0,
    costUsd: inputTokens * JEV_USD_PER_INPUT_TOKEN,
  };
}

async function askDeepSeek(b: Business, key: string): Promise<Answer> {
  const options = (Object.keys(KIND_CRITERIA) as Kind[]).map((k) => `- "${k}": ${KIND_CRITERIA[k]}`).join("\n");
  const prompt = `${listingText(b)}\n\nQuestion 1: ${KIND_QUESTION} Pick exactly one:\n${options}\n\nQuestion 2: True or false? ${TEXTILE_QUESTION}\n\nReply with JSON only: {"kind": "<one option>", "textile": true|false}`;
  const start = performance.now();
  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const ms = performance.now() - start;
  if (!response.ok) throw new Error(`DeepSeek returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const parsed = JSON.parse(body.choices[0].message.content) as { kind?: string; textile?: boolean };
  const inputTokens = body.usage?.prompt_tokens ?? 0;
  const outputTokens = body.usage?.completion_tokens ?? 0;
  const kind = (Object.keys(KIND_CRITERIA) as string[]).includes(String(parsed.kind)) ? parsed.kind as Kind : null;
  return {
    kind,
    textile: typeof parsed.textile === "boolean" ? parsed.textile : null,
    ms,
    inputTokens,
    outputTokens,
    costUsd: inputTokens * DEEPSEEK_USD.input + outputTokens * DEEPSEEK_USD.output,
  };
}

async function runPool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

const worth = (kind: Kind | null) => kind === "maker" || kind === "wholesaler";
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");

(async () => {
  const { businesses } = JSON.parse(fs.readFileSync(BUSINESSES, "utf8")) as { businesses: Business[] };
  const { labels } = JSON.parse(fs.readFileSync(LABELS, "utf8")) as { labels: Record<string, Kind | "unclear"> };
  const cache: Record<string, Record<string, Answer>> = fs.existsSync(ANSWERS) ? JSON.parse(fs.readFileSync(ANSWERS, "utf8")) : {};
  const save = () => fs.writeFileSync(ANSWERS, JSON.stringify(cache, null, 1));

  const contestants: Array<{ name: string; key?: string; ask: (b: Business, key: string) => Promise<Answer>; parallel: number }> = [
    { name: "deepseek", key: process.env.PLATFORM_DEEPSEEK_API_KEY?.trim(), ask: askDeepSeek, parallel: 5 },
    { name: "jev", key: process.env.TYPESAFE_API_KEY?.trim(), ask: askJev, parallel: 5 },
  ];
  for (const c of contestants) {
    if (!c.key) { console.log(`${c.name}: no key in .env — skipped (not faked).`); continue; }
    cache[c.name] ||= {};
    const todo = businesses.filter((b) => !cache[c.name][b.id]);
    let failures = 0;
    await runPool(todo, c.parallel, async (b) => {
      try { cache[c.name][b.id] = await c.ask(b, c.key!); }
      catch (error) { failures += 1; console.error(`${c.name} ${b.id}: ${error instanceof Error ? error.message : error}`); }
    });
    save();
    console.log(`${c.name}: asked ${todo.length}, failed ${failures}.`);
    if (failures > 3) process.exit(1);
  }

  // The built-in rule (contestant A) was removed on 2026-09-25 when lead
  // scoring became AI-only; its measured numbers are kept in JEV_TRIAL.md.
  const scored = businesses.filter((b) => labels[b.id] && labels[b.id] !== "unclear");
  console.log(`\nScored on ${scored.length} businesses (${businesses.length - scored.length} unclear left out). Good buyers: ${scored.filter((b) => worth(labels[b.id] as Kind)).length}.`);

  for (const name of ["deepseek", "jev"]) {
    const answers = cache[name];
    if (!answers) continue;
    const rows = scored.filter((b) => answers[b.id]);
    let kindRight = 0, worthRight = 0, worthRightBoutiquesGood = 0, falseKeep = 0, falseDrop = 0, cost = 0, tokensIn = 0;
    const ms: number[] = [];
    const buckets: Record<string, { n: number; right: number }> = { "0.9+": { n: 0, right: 0 }, "0.7-0.9": { n: 0, right: 0 }, "<0.7": { n: 0, right: 0 } };
    for (const b of rows) {
      const a = answers[b.id];
      const truth = labels[b.id] as Kind;
      if (a.kind === truth) kindRight += 1;
      const said = worth(a.kind), real = worth(truth);
      if (said === real) worthRight += 1;
      else if (said) falseKeep += 1; else falseDrop += 1;
      if ((said || a.kind === "retail") === (real || truth === "retail")) worthRightBoutiquesGood += 1;
      cost += a.costUsd; tokensIn += a.inputTokens; ms.push(a.ms);
      if (typeof a.confidence === "number") {
        const bucket = a.confidence >= 0.9 ? "0.9+" : a.confidence >= 0.7 ? "0.7-0.9" : "<0.7";
        buckets[bucket].n += 1;
        if (a.kind === truth) buckets[bucket].right += 1;
      }
    }
    ms.sort((x, y) => x - y);
    console.log(`\n${name === "jev" ? "C. Jev" : "B. Our current AI (DeepSeek)"} — ${rows.length} answered`);
    console.log(`  kind of business right:       ${pct(kindRight, rows.length)}`);
    console.log(`  "worth a look" right:         ${pct(worthRight, rows.length)}   (kept a shop: ${falseKeep}, dropped a real buyer: ${falseDrop})`);
    console.log(`  same, if boutiques count too: ${pct(worthRightBoutiquesGood, rows.length)}`);
    console.log(`  cost per 1,000 businesses:    $${((cost / rows.length) * 1000).toFixed(4)}   (avg ${Math.round(tokensIn / rows.length)} input tokens)`);
    console.log(`  time per business:            median ${Math.round(ms[Math.floor(ms.length / 2)])} ms`);
    if (name === "jev") {
      for (const [bucket, v] of Object.entries(buckets)) console.log(`  when ${bucket.padEnd(8)} sure: ${v.n} answers, right ${pct(v.right, v.n)}`);
    }
    const wrong = rows.filter((b) => answers[b.id].kind !== labels[b.id]).map((b) => `${b.id} said ${answers[b.id].kind} / label ${labels[b.id]}${typeof answers[b.id].confidence === "number" ? ` (${answers[b.id].confidence!.toFixed(2)})` : ""}`);
    console.log(`  disagreements: ${wrong.join("; ")}`);
  }
  process.exit(0);
})();
