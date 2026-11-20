/**
 * no-platform-ai-keys.ts — keep the golden suite OFFLINE, DETERMINISTIC and FREE.
 *
 * WHY THIS EXISTS (2026-08-20, N-AI-2 fallout — found by the suite itself)
 * ----------------------------------------------------------------------
 * N-AI-2 made the six model-slot defaults resolve from the environment, so a
 * fresh workspace runs on the operator's real key instead of answering
 * customers with mock text. Correct for the product — and it silently changed
 * what the TEST SUITE does, because:
 *
 *   1. `@prisma/client` loads `.env` when it is imported, and almost every
 *      golden imports `@/repositories`, which imports Prisma. So the real
 *      PLATFORM_* keys appear in a golden's environment without any golden
 *      asking for them.
 *   2. With a key present, a golden that exercises the reply engine and does
 *      NOT create its own routing rows now resolves to the real provider.
 *
 * `golden-whatsapp-conversation-engine` CASE A caught it, quoting the change:
 *   `llm is honestly mock/fallback (mode='real', provider='deepseek', fallbackUsed=false)`
 * — a logic golden had started making live, billable, network-dependent API
 * calls. A test that hits the network is not a golden; it is a weather report.
 *
 * HOW IT WORKS
 * ------------
 * dotenv (which Prisma uses) does NOT overwrite a variable that is already
 * present in `process.env`. So defining each key as an empty string HERE, in a
 * preload module that runs before any import, wins permanently — `.env` cannot
 * put the real value back. `platformApiKey()` treats empty/whitespace as absent
 * (golden-platform-ai-defaults CASE E pins that), so every slot resolves to the
 * mock default exactly as it did before N-AI-2.
 *
 * A golden that wants to test key-present behaviour sets the variable itself
 * after startup — see `golden-platform-ai-defaults`, which owns both branches.
 */
export const NEUTRALISED_AI_ENV = [
  "PLATFORM_DEEPSEEK_API_KEY",
  "PLATFORM_OPENAI_API_KEY",
  "PLATFORM_ANTHROPIC_API_KEY",
  "PLATFORM_GEMINI_API_KEY",
  "PLATFORM_KIMI_API_KEY",
  "PLATFORM_MINIMAX_API_KEY",
  "PLATFORM_DEFAULT_PROVIDER",
  // 2026-09-08 — platformApiKey() now also reads the UNPREFIXED names, because
  // an operator who names the variable `DEEPSEEK_API_KEY` (the name DeepSeek's
  // own docs use) had a key nothing could see. Those names must be neutralised
  // here for exactly the reason the prefixed ones are: a developer with
  // `DEEPSEEK_API_KEY` in their .env would otherwise have the golden suite
  // start making live, billable calls, which is the failure this file exists to
  // prevent.
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  // Search is billable too. Pin aliases before dotenv can load local keys.
  "PLATFORM_SERPAPI_API_KEY",
  "SERPAPI_API_KEY",
  "SERP_API_KEY",
  "GOOGLE_MAPS_API_KEY",
  "PLATFORM_GOOGLE_MAPS_API_KEY",
] as const;

for (const name of NEUTRALISED_AI_ENV) process.env[name] = "";
