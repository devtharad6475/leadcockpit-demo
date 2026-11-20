/**
 * Golden test — the pre-login "Demo safety boundaries" panel must describe the
 * system that is actually running, and must never be able to under-report
 * (N-OBS-2).
 *
 * WHY THIS EXISTS (2026-08-20, CEO-loop session 13)
 * ------------------------------------------------
 * The panel on the landing page is the LAST thing an operator reads before
 * clicking into the product, and it is the thing they trust when deciding
 * whether it is safe to press buttons. It was five hardcoded strings. Checked
 * one by one against `/api/health/deep` on the running server, three were
 * wrong:
 *
 *   "Persistence: JSON default"          — live value was `prisma`. The
 *                                          operator reads "JSON" and thinks the
 *                                          data is a throwaway file. It is the
 *                                          Postgres ship database.
 *   "LLM: Sample AI responses (demo)"    — 4 of 6 model slots resolved to
 *                                          provider `deepseek`. Real, billed
 *                                          calls on a live key, while the panel
 *                                          said nothing leaves the box.
 *   "WhatsApp: Dry-run only, no real     — true on the day it was read, and
 *    sending"                              true BY ACCIDENT: the string is
 *                                          fixed, so the day WhatsApp
 *                                          credentials are supplied (D4) it
 *                                          keeps promising "no real sending"
 *                                          while messages reach customers.
 *
 * That last one is the reason this is a golden and not a copy edit. A safety
 * notice that cannot become false is not a safety notice.
 *
 * WHAT THIS GOLDEN PINS.
 *
 *   CASE A — GET /api/health serves the rows, and Persistence tracks the real
 *     provider rather than a constant.
 *
 *   CASE B — with WhatsApp credentials present in the environment, the WhatsApp
 *     row says LIVE and does NOT say "dry-run" or "no real sending". This is the
 *     failure that is scheduled to happen the day the CEO supplies credentials.
 *
 *   CASE C — with a real (non-mock) model slot configured, the LLM row does not
 *     claim sample/demo responses.
 *
 *   CASE D — the panel renders what the server returned. A source assertion,
 *     because no API-level check can see a .tsx quietly holding its own copy of
 *     the answer; it also pins that a FAILED check renders a warning, not a
 *     reassuring default.
 *
 *   CASE E — in production auth mode the block is omitted entirely, so this fix
 *     adds no new anonymous surface. The detailed inventory stays where it was:
 *     `health/deep`, owner/admin-gated.
 *
 *   CASE F — `health` answers inside a hard time budget, and the model-slot
 *     lookup that feeds the LLM row is bounded in source. Found by running the
 *     fix rather than reading it: the first version awaited the slot lookup with
 *     no bound, and with the database unreachable the dev server logged
 *     `GET /api/health 200 in 7.0min`. `health` is what a container healthcheck
 *     and a load balancer call — a seven-minute answer reports the whole service
 *     as hung. A safety panel is not worth taking liveness down for.
 *
 * Run: npx tsx --import ./scripts/golden/_helpers/force-json-provider.ts \
 *        scripts/golden/golden-demo-boundaries-honesty.ts
 */
// N-DATA-22: first import, so the data dir is redirected before src/lib/db.ts
// freezes it. Without this a hand-run of this file writes into the LIVE store.
import "./_helpers/isolate-standalone";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getModelSlots } from "@/services/AISettingsService";
import { defaultWorkspaceId } from "@/lib/db";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function getHealth(): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/api/[[...path]]/route");
  const request = new Request("http://localhost/api/health");
  const response = await GET(
    request as never,
    { params: Promise.resolve({ path: ["health"] }) },
  );
  assert(response.status === 200, `GET /api/health returned HTTP ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function rows(payload: Record<string, unknown>): Record<string, string> {
  const boundaries = payload.demoBoundaries;
  assert(
    boundaries && typeof boundaries === "object",
    "GET /api/health returned no demoBoundaries block. The landing panel has nothing to read, and the fallback " +
    "it renders is a warning — which is correct, but means the operator is told nothing useful.",
  );
  return boundaries as Record<string, string>;
}

/** Set an env var for one check and always put it back exactly as it was. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const SAFE_CLAIM = /dry-run|no real sending|cannot leave|sample ai|demo only|mocked/i;

async function main() {
  // ─── CASE A: the rows exist and track the real provider ───────────────────
  {
    const payload = await getHealth();
    const boundaries = rows(payload);
    for (const key of ["Auth mode", "Persistence", "WhatsApp", "LLM", "Prospecting"]) {
      assert(typeof boundaries[key] === "string" && boundaries[key].length > 0, `CASE A: the "${key}" row is missing`);
    }
    const provider = process.env.PERSISTENCE_PROVIDER || "json";
    const persistence = boundaries.Persistence.toLowerCase();
    if (provider === "prisma") {
      assert(
        persistence.includes("postgres"),
        `CASE A: PERSISTENCE_PROVIDER is "prisma" but the panel says "${boundaries.Persistence}". This is the ` +
        "original defect verbatim — the operator was told the data was a throwaway JSON file while the app ran " +
        "on the Postgres ship database.",
      );
    } else {
      assert(
        persistence.includes("json"),
        `CASE A: PERSISTENCE_PROVIDER is "${provider}" but the panel says "${boundaries.Persistence}"`,
      );
    }
    console.log(`✅ CASE A — the five rows come from the server and Persistence follows the real provider ("${boundaries.Persistence}")`);
  }

  // ─── CASE B: configured WhatsApp credentials flip the row to LIVE ─────────
  {
    // Literal test values. Nothing here is a credential and nothing is sent.
    const boundaries = await withEnv(
      {
        WHATSAPP_CLOUD_ACCESS_TOKEN: "golden-test-token-not-a-real-credential",
        WHATSAPP_CLOUD_PHONE_NUMBER_ID: "0000000000",
      },
      async () => rows(await getHealth()),
    );
    assert(
      /live/i.test(boundaries.WhatsApp),
      `CASE B: WhatsApp credentials are configured but the panel says "${boundaries.WhatsApp}". This is the ` +
      "scheduled failure: the string used to be hardcoded, so the day the CEO supplies credentials (D4) the " +
      "landing page would keep promising \"no real sending\" while messages reached real customers.",
    );
    assert(
      !SAFE_CLAIM.test(boundaries.WhatsApp),
      `CASE B: the WhatsApp row still contains a safe-sounding claim while sending is live: "${boundaries.WhatsApp}"`,
    );
    console.log(`✅ CASE B — configured WhatsApp credentials turn the row into a warning ("${boundaries.WhatsApp}")`);
  }

  // ─── CASE C: a real model slot means the LLM row cannot claim "sample" ────
  {
    const boundaries = rows(await getHealth());
    const llm = boundaries.LLM;
    // The counts are read INDEPENDENTLY here, from the same service the route
    // uses, so this case fails if the row is asserted rather than derived. In
    // demo auth mode the route resolves the default workspace unconditionally
    // (route.ts resolveWorkspaceId), so this is the same lookup.
    let truthTotal = -1;
    let truthLive = 0;
    let truthKeyless = 0;
    try {
      const slots = await getModelSlots(defaultWorkspaceId);
      truthTotal = slots.length;
      // 2026-09-08 — this used to be `provider !== "mock"`, which asks whether a
      // provider was CHOSEN, not whether a call can be made. The demo
      // deployment had four DeepSeek slots and no PLATFORM_DEEPSEEK_API_KEY, so
      // the panel said "LIVE — 4 of 6 … are billed" while AI Settings said
      // "No API key is set for this model. (deepseek) … 25 recent AI calls have
      // been affected". The rule below is the one LLMService.providerFor
      // actually applies: the slot's own credential first, else the platform
      // key; Ollama is a local runtime and needs neither.
      const realProviderSlots = slots.filter((slot) => slot.provider && slot.provider !== "mock");
      truthLive = realProviderSlots.filter(
        (slot) => slot.provider === "ollama" || Boolean(slot.credentialId) || Boolean(slot.hasPlatformKey),
      ).length;
      truthKeyless = realProviderSlots.length - truthLive;
    } catch {
      truthTotal = -1;
    }
    if (truthTotal >= 0) {
      if (truthLive === 0 && truthKeyless > 0) {
        assert(
          !/^LIVE/i.test(llm) && !SAFE_CLAIM.test(llm),
          `CASE C: ${truthKeyless} of ${truthTotal} model slots name a real provider that has NO API key. ` +
          `Nothing is billed and nothing is answered, so the row must not read as live, and it must not read ` +
          `as safe either — a keyless slot falls back to canned text, which is not the same as a mock model. ` +
          `Panel says: "${llm}"`,
        );
      } else if (truthLive === 0) {
        assert(
          /sample|mocked/i.test(llm) && !/^LIVE/i.test(llm),
          `CASE C: every one of the ${truthTotal} model slots is mocked, but the panel says "${llm}"`,
        );
      } else {
        assert(
          /live/i.test(llm) && llm.includes(`${truthLive} of ${truthTotal}`),
          `CASE C: ${truthLive} of ${truthTotal} model slots call a real provider, but the panel says "${llm}". ` +
          "This is the original defect verbatim — four of six slots were live DeepSeek while the landing page " +
          "promised sample responses.",
        );
      }
    }
    const claimsLive = /live/i.test(llm);
    const claimsSample = /sample|mocked/i.test(llm);
    // "Could not be checked" is a legitimate third state — the slot lookup goes
    // through the repositories, and on the Postgres substrate that can be down.
    // It is only acceptable because it reads as a WARNING; an unknown answer
    // that renders as reassurance is the defect this golden exists for.
    const claimsUnknown = /could not be checked/i.test(llm);
    // "NOT ANSWERING" is a legitimate fourth state, added 2026-09-08: a slot can
    // name a real provider and still have no key, in which case nothing is
    // billed AND nothing is mocked — the reply falls back to canned text. It has
    // to be spelled out, because both of the other two readings are wrong and
    // one of them ("LIVE — 4 of 6 … are billed") is what shipped.
    const claimsNotAnswering = /not answering/i.test(llm);
    if (claimsUnknown) {
      assert(
        !SAFE_CLAIM.test(llm.replace(/could not be checked/i, "")),
        `CASE C: the LLM row could not be determined and still reads as safe: "${llm}"`,
      );
    } else if (claimsNotAnswering) {
      assert(
        !SAFE_CLAIM.test(llm) && !claimsSample,
        `CASE C: a keyless LLM row must not also read as safe or as mocked: "${llm}"`,
      );
    } else {
      assert(
        claimsLive !== claimsSample,
        `CASE C: the LLM row is ambiguous — it must claim live, sample, an explicit "could not be checked", or ` +
        `"NOT ANSWERING", never two of those and never none: "${llm}"`,
      );
    }
    if (claimsLive && !claimsUnknown && !claimsNotAnswering) {
      assert(
        /\d+ of \d+/.test(llm),
        `CASE C: a live LLM row must say HOW MANY slots are live, so the operator can tell "one image model" from ` +
        `"everything": "${llm}"`,
      );
    }
    console.log(`✅ CASE C — the LLM row is derived from the real model slots, not asserted ("${llm}")`);
  }

  // ─── CASE D: the panel renders the server's answer, and fails loudly ──────
  {
    const src = readFileSync(resolve("src/app/page.tsx"), "utf8");
    assert(
      !/"Persistence":\s*"JSON default"/.test(src),
      "CASE D: the hardcoded \"Persistence: JSON default\" row is back in page.tsx. The panel must not hold its own " +
      "copy of an answer the server computes.",
    );
    assert(
      !/"LLM":\s*"Sample AI responses \(demo\)"/.test(src),
      "CASE D: the hardcoded \"Sample AI responses (demo)\" row is back in page.tsx.",
    );
    assert(
      src.includes("demoBoundaries"),
      "CASE D: page.tsx no longer reads demoBoundaries from the health endpoint, so whatever it is showing is not " +
      "what the server reported.",
    );
    assert(
      src.includes("boundariesError"),
      "CASE D: the failure branch is gone. If the check cannot be made, the panel must SAY so — rendering a " +
      "reassuring default when the answer is unknown is how the original defect read to an operator.",
    );
    console.log("✅ CASE D — the panel renders the server's answer, and says so plainly when it could not get one");
  }

  // ─── CASE E: production mode publishes nothing new ────────────────────────
  {
    const payload = await withEnv({ AUTH_MODE: "production" }, async () => getHealth());
    assert(
      payload.demoBoundaries === undefined,
      "CASE E: the boundaries block is served in production auth mode. This panel is a demo-mode affordance; the " +
      "full inventory belongs to health/deep, which is owner/admin-gated precisely because it is reconnaissance " +
      "material.",
    );
    console.log("✅ CASE E — production auth mode omits the block entirely: no new anonymous surface");
  }

  // ─── CASE F: health stays fast, and the slow path is bounded in source ────
  {
    const started = Date.now();
    await getHealth();
    const elapsed = Date.now() - started;
    assert(
      elapsed < 5_000,
      `CASE F: GET /api/health took ${elapsed}ms. This endpoint is the liveness check — the container healthcheck ` +
      "and any load balancer call it. The first version of this panel awaited the model-slot lookup with no bound " +
      "and the running server answered in 7.0 MINUTES with the database unreachable.",
    );

    const route = readFileSync(resolve("src/app/api/[[...path]]/route.ts"), "utf8");
    const health = route.slice(route.indexOf('if (match(path, ["health"]))'));
    const body = health.slice(0, health.indexOf("return json({ ok: true"));
    assert(
      /Promise\.race/.test(body) && /setTimeout/.test(body),
      "CASE F: the model-slot lookup in the health handler is no longer bounded by a timeout. Under the JSON " +
      "substrate it returns instantly, so the timing check above cannot see the regression — on Postgres with the " +
      "database down it is a seven-minute liveness endpoint.",
    );
    console.log(`✅ CASE F — health answered in ${elapsed}ms and the slot lookup is bounded, so a dead database cannot hang the liveness check`);
  }

  // ─── CASE G: a real provider with no key is NOT live ─────────────────────
  /**
   * 2026-09-08, session 54. Found by opening the live demo deployment as a
   * customer would, not by any test here.
   *
   * lead-cockpit-demo had all four text slots pointed at DeepSeek and no
   * PLATFORM_DEEPSEEK_API_KEY on the service. The landing panel said:
   *
   *     LLM — LIVE — 4 of 6 model slots call a real AI provider and are billed
   *
   * while the AI Settings screen inside the same deployment said:
   *
   *     No API key is set for this model. (deepseek) … 25 recent AI calls have
   *     been affected.
   *
   * Both cannot be true. The panel was counting slots whose PROVIDER was not
   * "mock" — a question about configuration — and printing the answer as though
   * it were a question about billing. A whole knowledge extraction ran on canned
   * fallbacks while the operator had been told the AI was live and paid for.
   *
   * This case builds that exact state and pins both directions.
   */
  {
    const { updateModelSlots } = await import("@/services/AISettingsService");
    const deepseekSlots = [
      { slotId: "fast_customer_reply", provider: "deepseek", modelName: "deepseek-chat" },
      { slotId: "daily_workhorse", provider: "deepseek", modelName: "deepseek-chat" },
      { slotId: "deep_reasoning", provider: "deepseek", modelName: "deepseek-reasoner" },
      { slotId: "research_search", provider: "deepseek", modelName: "deepseek-chat" },
      { slotId: "creative_image", provider: "mock", modelName: "mock-image" },
      { slotId: "embedding_advanced", provider: "mock", modelName: "mock-embedding" },
    ];
    await updateModelSlots(defaultWorkspaceId, deepseekSlots);

    const keyless = await withEnv({ PLATFORM_DEEPSEEK_API_KEY: undefined }, async () => rows(await getHealth()));
    assert(
      !/^LIVE/i.test(keyless.LLM),
      `CASE G: four slots name DeepSeek and no key is configured, so no call can be made and nothing can be ` +
      `billed — but the panel says "${keyless.LLM}". This is the shipped defect verbatim.`,
    );
    assert(
      /not answering/i.test(keyless.LLM) && /no api key/i.test(keyless.LLM),
      `CASE G: a keyless row must say so in words the operator can act on: "${keyless.LLM}"`,
    );
    assert(
      !SAFE_CLAIM.test(keyless.LLM),
      `CASE G: a keyless row must not read as safe — replies fall back to canned text, which is not a mock model ` +
      `and is not "sample AI": "${keyless.LLM}"`,
    );

    const keyed = await withEnv(
      { PLATFORM_DEEPSEEK_API_KEY: "sk-golden-not-a-real-key" },
      async () => rows(await getHealth()),
    );
    assert(
      /^LIVE/i.test(keyed.LLM) && keyed.LLM.includes("4 of 6"),
      `CASE G: with a platform key present the same four slots ARE live and billed, so the panel must say so: ` +
      `"${keyed.LLM}"`,
    );
    console.log(`✅ CASE G — a keyless real provider reads as "${keyless.LLM.split(" —")[0]}", and becomes LIVE the moment a key exists`);
  }

  console.log("\n✅✅✅ All demo-boundary honesty golden cases PASSED (A–G). ✅✅✅");
}

main().catch((err) => {
  console.error("\n❌ GOLDEN FAILED:", err);
  process.exit(1);
});
