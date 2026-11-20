/**
 * Stage A+ / Cluster 10a (2026-07-26) — Shared API client helper.
 *
 * The single frontend chokepoint for calling the backend. Replaces the 6
 * divergent `api()` copies (1 in page.tsx + 5 in section files) that each
 * had subtle differences:
 *
 *   - page.tsx version: auto-stringifies the body, parses JSON error envelopes
 *     properly (handles {error:{message}} and {error:"string"}).
 *   - section versions: took raw RequestInit, forcing every caller to
 *     JSON.stringify themselves — the source of the latent [object Object]
 *     body bug (P2-3) when a caller forgets to stringify.
 *
 * Per build-right Phase 3d "centralized chokepoint": one function, one job,
 * every caller imports it. No more copy-paste drift.
 *
 * P2-4 fix: apiForm now parses error bodies too (was throwing generic
 * "Request failed (status)" with no server message — media-upload errors
 * lost the server's explanation).
 */

/**
 * The error every failed call throws.
 *
 * N-SEC-2 (2026-09-03). It used to be a bare `Error` carrying only the server's
 * message, which meant no caller could tell WHY a call failed — and one caller
 * that badly needed to was the boot sequence. It treats a failure to reach
 * /api/auth/status as "we cannot establish who you are", and correctly fails
 * closed by showing the login screen. When the front-door rate limit answered
 * 429, that arrived as an indistinguishable `Error`, so a busy server signed
 * the operator out and lost their place — on every refresh, for as long as the
 * block lasted.
 *
 * `status` and `retryAfterSeconds` exist so "come back shortly" can be handled
 * as what it is. `.message` is still the server's plain string, so every
 * existing `catch (e) { setNotice(e.message) }` keeps working unchanged.
 */
export class ApiError extends Error {
  readonly status: number;
  /** From the `Retry-After` header, when the server sent one. */
  readonly retryAfterSeconds?: number;
  /** The server's error code from the envelope, e.g. "EDGE_RATE_LIMITED". */
  readonly code?: string;

  constructor(message: string, status: number, options: { retryAfterSeconds?: number; code?: string } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.code = options.code;
  }

  /** The server is up and knows us — it is just refusing volume right now. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/** True for a 429 from any layer. Safe on values that are not ApiErrors. */
export function isRateLimitError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.isRateLimited;
}

export type ApiOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip the JSON content-type header (e.g. for FormData bodies). */
  skipContentType?: boolean;
};

/**
 * JSON-style call. Auto-stringifies the body, sets content-type, parses the
 * response, and throws an Error with the server's message on failure.
 *
 * The thrown Error's `.message` is always a plain string (the server's
 * message if available, else a fallback) so callers can pass it straight to
 * setError/toast.
 */
/**
 * 2026-08-05 (audit F-8) — truncation ledger.
 *
 * When a list endpoint has to cap its response (a workspace larger than
 * BARE_LIST_CEILING rows), the server marks it with `X-Truncated: true` plus
 * the true `X-Total-Count`. The UI computes several dashboard figures by
 * filtering these arrays client-side, so a capped array would render a
 * confidently WRONG number with no outward sign.
 *
 * Every truncated response is recorded here, and the app surfaces a banner
 * instead of pretending the list is complete. An empty ledger is the normal
 * case and costs nothing.
 */
export type TruncationNotice = { url: string; returned: number; total: number };
const truncationLedger = new Map<string, TruncationNotice>();

/** Every list response truncated since the last `clearTruncations()`. */
export function getTruncations(): TruncationNotice[] {
  return [...truncationLedger.values()];
}

/** Reset the ledger. Call at the start of a full reload. */
export function clearTruncations(): void {
  truncationLedger.clear();
}

function recordTruncation(url: string, response: Response): void {
  if (response.headers.get("X-Truncated") !== "true") return;
  truncationLedger.set(url, {
    url,
    returned: Number(response.headers.get("X-Returned-Count") || 0),
    total: Number(response.headers.get("X-Total-Count") || 0),
  });
}

export async function api<T>(url: string, options?: ApiOptions): Promise<T> {
  const isStringBody = typeof options?.body === "string";
  const headers: Record<string, string> = { ...(options?.headers || {}) };
  if (options?.body !== undefined && !options.skipContentType && !isStringBody) {
    headers["content-type"] = headers["content-type"] || "application/json";
  }
  const response = await fetch(url, {
    method: options?.method || "GET",
    cache: "no-store",
    headers,
    body: options?.body !== undefined
      ? (isStringBody ? (options.body as string) : JSON.stringify(options.body))
      : undefined,
  });
  recordTruncation(url, response);
  return parseResponse<T>(response);
}

/**
 * FormData-style call (file uploads, multipart). Does NOT stringify or set
 * content-type (the browser sets multipart/form-data with the boundary).
 *
 * Stage A+ / Cluster 10a (P2-4): now parses the JSON error envelope on
 * failure, same as `api()`. Was throwing generic "Request failed (status)"
 * — media-upload errors lost the server's validation message.
 */
export async function apiForm<T>(url: string, formData: FormData, options?: { method?: string }): Promise<T> {
  const response = await fetch(url, {
    method: options?.method || "POST",
    body: formData,
  });
  return parseResponse<T>(response);
}

/**
 * Shared response parser. Both `api` and `apiForm` route through this so
 * error handling is identical everywhere (build-right Phase 3d: one gate).
 *
 * Honors the project's error envelope `{success:false, error:{code,message,
 * details}}` (per AGENTS.md). Falls back gracefully if the server returns a
 * non-envelope error or non-JSON body.
 */
async function parseResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type");
  let payload: Record<string, unknown> | null = null;
  if (contentType && contentType.includes("application/json")) {
    try {
      payload = await response.json() as Record<string, unknown>;
    } catch {
      throw new Error("Server returned an invalid JSON response. Please check logs or try again.");
    }
  } else {
    // Non-JSON response. If it's a success (2xx), return empty object.
    if (response.ok) return {} as T;
    throw new ApiError(`Server returned a non-JSON response with status ${response.status}.`, response.status);
  }

  if (!response.ok) {
    // N-SEC-2: carry the status and Retry-After through, so a caller can tell a
    // busy server from a broken one. The message stays exactly what it was.
    const retryAfterRaw = response.headers.get("retry-after");
    const retryAfterSeconds = retryAfterRaw && Number.isFinite(Number(retryAfterRaw))
      ? Number(retryAfterRaw)
      : undefined;
    const envelope = payload && typeof payload.error === "object"
      ? (payload.error as Record<string, unknown>)
      : null;
    const code = envelope && typeof envelope.code === "string" ? envelope.code : undefined;
    const fail = (message: string) =>
      new ApiError(message, response.status, { retryAfterSeconds, code });

    if (payload && payload.error) {
      // Envelope shape: { error: { code, message, details } }
      if (envelope && envelope.message) {
        throw fail(String(envelope.message));
      }
      // Flat shape: { error: "some message" }
      if (typeof payload.error === "string") {
        throw fail(payload.error);
      }
      throw fail(String(payload.error));
    }
    throw fail(`Request failed with status ${response.status}`);
  }
  return payload as T;
}
