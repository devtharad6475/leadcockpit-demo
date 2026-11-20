/**
 * golden-truncated-answer.ts — an answer that ran out of room says so
 * (2026-09-18, session 57).
 *
 * ── THE DEFECT, SEEN IN PRODUCTION ──────────────────────────────────────────
 * Nothing set `max_tokens`, so each provider used its own default — 4,096 on
 * deepseek-chat. A document-extraction batch answers up to 17 questions in one
 * JSON array, and on the largest question group that array ran past the
 * ceiling. The model stopped mid-element; the text was perfectly valid JSON up
 * to the cut; the parser rejected the whole thing with "Expected ',' or ']'
 * after array element". All 17 answers were thrown away, on every attempt,
 * including the retries — and the message blamed the model for returning
 * "malformed JSON" when it had simply been given no room to finish.
 *
 * Reproduced identically in the lab and on production the same day, on the same
 * group (`extra_unmapped_information`).
 *
 *   CASE A — the request asks for enough room, and the ceiling is configurable.
 *   CASE B — a cut-off answer is reported AS a cut-off answer: the error names
 *            the cause and what to do, and does not say "malformed JSON".
 *   CASE C — a genuinely malformed answer that was NOT cut off still reports as
 *            malformed. The new message must not swallow the old one.
 *   CASE D — a complete answer is unaffected, and usage still comes through.
 *
 * Run: npx tsx scripts/golden/golden-truncated-answer.ts
 */
import "./_helpers/isolate-standalone";
import assert from "node:assert";
import { DeepSeekProvider } from "@/llm/providers/OpenAICompatibleProvider";

let pass = 0;
let fail = 0;
const cases: Array<{ name: string; fn: () => Promise<void> }> = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });

type Body = { max_tokens?: number; messages?: unknown[] };

async function call(respond: (body: Body) => Response, env?: string) {
  const saved = process.env.LLM_MAX_OUTPUT_TOKENS;
  if (env === undefined) delete process.env.LLM_MAX_OUTPUT_TOKENS;
  else process.env.LLM_MAX_OUTPUT_TOKENS = env;
  const realFetch = globalThis.fetch;
  let seen: Body = {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen = JSON.parse(String(init?.body || "{}")) as Body;
    return respond(seen);
  }) as typeof fetch;
  try {
    const provider = new DeepSeekProvider({ apiKey: "golden-key-not-real" });
    const result = await provider.runJsonTask({ taskName: "document_extraction_mapping", modelTier: "balanced", prompt: "p", input: {} });
    return { seen, result, error: undefined as Error | undefined };
  } catch (error) {
    return { seen, result: undefined, error: error as Error };
  } finally {
    globalThis.fetch = realFetch;
    if (saved === undefined) delete process.env.LLM_MAX_OUTPUT_TOKENS;
    else process.env.LLM_MAX_OUTPUT_TOKENS = saved;
  }
}

const reply = (content: string, finish = "stop", usage?: Record<string, number>) =>
  Response.json({ choices: [{ message: { content }, finish_reason: finish }], usage });

test("CASE A — the request asks for room to finish, and the ceiling is configurable", async () => {
  const a = await call(() => reply('{"ok":true}'));
  assert.ok(
    typeof a.seen.max_tokens === "number" && a.seen.max_tokens >= 8192,
    `every request must ask for enough output room; a provider default of 4,096 truncates a 17-answer batch. Got ${a.seen.max_tokens}`,
  );
  const b = await call(() => reply('{"ok":true}'), "20000");
  assert.strictEqual(b.seen.max_tokens, 20000, "LLM_MAX_OUTPUT_TOKENS must be able to raise the ceiling without a code change");
});

test("CASE B — a cut-off answer is reported as cut off, not as malformed", async () => {
  // Exactly the production shape: valid JSON up to the cut, finish_reason=length.
  const truncated = '{"answers":[{"questionKey":"a","answer":"first"},{"questionKey":"b","answer":"seco';
  const r = await call(() => reply(truncated, "length", { prompt_tokens: 20000, completion_tokens: 4096, total_tokens: 24096 }));
  assert.ok(r.error, "a cut-off answer must be an error, not a half-parsed object");
  const message = r.error!.message;
  assert.match(message, /cut off/i, `the error must say the answer was cut off. Got: ${message}`);
  assert.match(message, /4096|output room/i, "it must say how far it got, or that the room ran out");
  assert.match(message, /fewer items|LLM_MAX_OUTPUT_TOKENS/, "it must say what to do about it");
  assert.ok(
    !/malformed/i.test(message),
    "THE POINT: calling this 'malformed JSON' sends the reader hunting for a model bug. The model did nothing wrong — " +
      `it was given no room to finish. Got: ${message}`,
  );
});

test("CASE C — a genuinely malformed answer still reports as malformed", async () => {
  const r = await call(() => reply("this is not json at all", "stop"));
  assert.ok(r.error, "unparseable output must still be an error");
  assert.match(r.error!.message, /malformed|empty or null/i, `a real parse failure must keep its own diagnosis. Got: ${r.error!.message}`);
  assert.ok(!/cut off/i.test(r.error!.message), "a complete-but-broken answer must NOT be blamed on truncation");
});

test("CASE D — a complete answer is unaffected", async () => {
  const r = await call(() => reply('{"answers":[{"questionKey":"a"}]}', "stop", { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }));
  assert.ifError(r.error);
  assert.deepStrictEqual(r.result!.output, { answers: [{ questionKey: "a" }] });
  assert.strictEqual(r.result!.usage?.totalTokens, 110, "usage must still be reported");
});

(async () => {
  console.log("\n=== GOLDEN: an answer that ran out of room says so ===\n");
  for (const c of cases) {
    try {
      await c.fn();
      pass += 1;
      console.log(`  ✓ ${c.name}`);
    } catch (error) {
      fail += 1;
      console.log(`  ✗ ${c.name}\n    ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("❌ GOLDEN FAILED: truncated-answer");
    process.exit(1);
  }
})();
