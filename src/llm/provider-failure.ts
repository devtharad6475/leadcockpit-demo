/**
 * provider-failure.ts — why an LLM call failed, in words the owner can act on.
 *
 * ── THE DEFECT THIS EXISTS FOR (2026-09-08) ─────────────────────────────────
 * LLMService.runTask catches EVERY provider error in one `catch` and swaps to
 * the mock provider. Balance exhausted, key revoked, provider down, network
 * blip — all of them become the same thing: a silent downgrade.
 *
 * The mock provider returns `{ taskName, input, mock: true }` for most tasks,
 * which is not a usable answer, so the WhatsApp engine falls through to a
 * canned per-category reply. Nothing is invented — but the product gets
 * quietly worse at every job it does, and the only trace is a `warning` field
 * on one response object that nobody stores and no screen aggregates.
 *
 * Meanwhile the header chip on every screen reads "AI running 6/6", because it
 * reports which autonomy jobs are switched on and has never known whether the
 * key behind them works. An owner whose balance hit zero is told, on every
 * screen, that everything is fine.
 *
 * ── WHY CLASSIFY RATHER THAN JUST SAY "AI IS OFF" ───────────────────────────
 * Because the owner's next action is different in each case, and if we don't
 * say which one it is, they have to diagnose it themselves:
 *
 *   no_key         → nothing is configured yet. Add a key.
 *   invalid_key    → the key is wrong, revoked, or for the wrong provider.
 *   out_of_balance → the key works; the account has no credit. Top up.
 *   rate_limited   → nothing is wrong. Wait; it heals itself.
 *   timeout        → slow or unreachable. Usually transient.
 *   provider_down  → their side, not yours.
 *   unknown        → say so plainly rather than guess.
 *
 * "Top up your DeepSeek account" and "your key is invalid" are different jobs,
 * and telling someone the wrong one wastes their afternoon.
 *
 * ── HOW THE MATCHING WORKS ──────────────────────────────────────────────────
 * Providers disagree about how to signal the same condition. OpenAI returns
 * 429 with `insufficient_quota` for "no credit" — the same status code it uses
 * for real rate limiting. Anthropic uses 400 with `credit balance is too low`.
 * DeepSeek uses 402 `Insufficient Balance`. So status code alone is not enough,
 * and message text alone is not enough either.
 *
 * The order below is deliberate: BALANCE is checked before RATE LIMIT,
 * because OpenAI's out-of-credit error is a 429 and would otherwise be read as
 * "just wait" forever — the one misclassification that costs the owner the
 * most, since waiting never fixes an empty account.
 */

export type ProviderFailureReason =
  | "no_key"
  | "invalid_key"
  | "out_of_balance"
  | "rate_limited"
  | "timeout"
  | "provider_down"
  | "unknown";

export type ProviderFailure = {
  reason: ProviderFailureReason;
  /** Short, owner-facing. No stack traces, no provider jargon. */
  summary: string;
  /** The single next action. Empty when there is nothing for them to do. */
  action: string;
  /** True when waiting is genuinely the right answer and nobody needs to act. */
  transient: boolean;
};

const DETAIL: Record<ProviderFailureReason, Omit<ProviderFailure, "reason">> = {
  no_key: {
    summary: "No API key is set for this model.",
    action: "Add a key in AI Settings, or pick a model that does not need one.",
    transient: false,
  },
  invalid_key: {
    summary: "The API key was rejected.",
    action: "Check the key in AI Settings — it may be revoked, mistyped, or for a different provider.",
    transient: false,
  },
  out_of_balance: {
    summary: "The API key works, but the account has no credit left.",
    action: "Top up your provider account. The AI stays on canned replies until you do.",
    transient: false,
  },
  rate_limited: {
    summary: "The provider is rate-limiting requests.",
    action: "",
    transient: true,
  },
  timeout: {
    summary: "The provider did not respond in time.",
    action: "",
    transient: true,
  },
  provider_down: {
    summary: "The provider returned a server error.",
    action: "",
    transient: true,
  },
  unknown: {
    summary: "The AI call failed for an unrecognised reason.",
    action: "Open AI Settings and run the connection test to see the provider's own message.",
    transient: false,
  },
};

/** Everything we can learn from an error, without trusting any single signal. */
function surfaceOf(error: unknown): { text: string; status?: number } {
  const raw = error as { message?: unknown; status?: unknown; statusCode?: unknown; response?: { status?: unknown } } | null;
  const text = String(
    (error instanceof Error ? error.message : undefined) ?? (typeof raw?.message === "string" ? raw.message : "") ?? "",
  ).toLowerCase() || String(error ?? "").toLowerCase();
  const statusish = raw?.status ?? raw?.statusCode ?? raw?.response?.status;
  let status = typeof statusish === "number" ? statusish : undefined;
  // Providers routinely bury the code in the message rather than on the object.
  if (status === undefined) {
    const m = text.match(/\b(?:status|http|code)\D{0,3}(\d{3})\b/) || text.match(/\b(4\d\d|5\d\d)\b/);
    if (m) status = Number(m[1]);
  }
  return { text, status };
}

export function classifyProviderFailure(error: unknown): ProviderFailure {
  const { text, status } = surfaceOf(error);

  // Our own guard, thrown before any network call is made.
  if (/missing api key/.test(text)) return { reason: "no_key", ...DETAIL.no_key };

  // BALANCE FIRST — see the header. OpenAI signals "no credit" with a 429,
  // which would otherwise be read as "wait a moment" for as long as the
  // account stays empty.
  if (
    /insufficient[_ ]?(?:quota|balance|funds|credit)/.test(text)
    || /credit balance is too low/.test(text)
    || /exceeded your current quota/.test(text)
    || /billing|payment required|no credit|out of credit|top ?up/.test(text)
    || status === 402
  ) {
    return { reason: "out_of_balance", ...DETAIL.out_of_balance };
  }

  if (
    /invalid[_ ]api[_ ]key|incorrect api key|unauthorized|unauthenticated|authentication[_ ]error|invalid authentication|permission denied|forbidden/.test(text)
    || status === 401
    || status === 403
  ) {
    return { reason: "invalid_key", ...DETAIL.invalid_key };
  }

  if (/rate[_ ]?limit|too many requests|slow down/.test(text) || status === 429) {
    return { reason: "rate_limited", ...DETAIL.rate_limited };
  }

  if (/timeout|timed out|etimedout|abort|econnreset|socket hang up/.test(text) || status === 408 || status === 504) {
    return { reason: "timeout", ...DETAIL.timeout };
  }

  if (/overloaded|service unavailable|bad gateway|internal server error|econnrefused|enotfound/.test(text)
    || (typeof status === "number" && status >= 500)) {
    return { reason: "provider_down", ...DETAIL.provider_down };
  }

  return { reason: "unknown", ...DETAIL.unknown };
}

/** The owner-facing detail for a reason already stored on a past run. */
export function describeProviderFailure(reason: string): ProviderFailure {
  const key = (Object.keys(DETAIL) as ProviderFailureReason[]).includes(reason as ProviderFailureReason)
    ? (reason as ProviderFailureReason)
    : "unknown";
  return { reason: key, ...DETAIL[key] };
}

/**
 * K3 (2026-09-27): the owner-facing form of an error message that may carry a
 * provider's raw reply. Runs stored before the extraction fix still hold text
 * like `Provider request failed with 401: {"error":{...}}`; screens pass their
 * stored message through this so raw JSON never reaches the owner. Text with
 * no raw provider reply in it is returned unchanged.
 */
export function ownerFacingFailureText(text: string | undefined): string {
  const value = (text || "").trim();
  if (!value) return "";
  if (!/\{\s*"|authentication_error|invalid_request_error|Provider request failed/i.test(value)) return value;
  const failure = classifyProviderFailure(new Error(value));
  if (failure.reason !== "unknown") return [failure.summary, failure.action].filter(Boolean).join(" ");
  return value.replace(/\{[\s\S]*\}/g, "").replace(/:\s+(?=\()/g, " ").replace(/:\s*$/, "").replace(/\s{2,}/g, " ").trim() || failure.summary;
}
