import { NextResponse } from "next/server";

export function successResponse(data: unknown, meta: Record<string, unknown> = {}, status = 200) {
  return NextResponse.json({ success: true, data, meta }, { status });
}

export function errorResponse(message: string, statusCode = 400, details?: unknown, code = "api_error") {
  return NextResponse.json({ success: false, error: { message, code: code.toUpperCase(), details } }, { status: statusCode });
}

export function validationErrorResponse(errors: unknown) {
  return errorResponse("Validation failed", 422, errors, "validation_error");
}

export function notFoundResponse(message = "Resource not found") {
  return errorResponse(message, 404, undefined, "not_found");
}

export function forbiddenResponse(message = "Forbidden") {
  return errorResponse(message, 403, undefined, "FORBIDDEN");
}

export function unauthorizedResponse(message = "Unauthorized") {
  return errorResponse(message, 401, undefined, "UNAUTHORIZED");
}

export function rateLimitedResponse(message = "Daily limit reached. Try again later or increase your limit.", details?: unknown) {
  return errorResponse(message, 429, details, "RATE_LIMITED");
}

export function configurationErrorResponse(message = "Configuration error", details?: unknown) {
  return errorResponse(message, 400, details, "CONFIGURATION_ERROR");
}

/**
 * A single entity addressed by an id in the URL. Absent means 404, never 200.
 *
 * ── WHY THIS EXISTS (found 2026-08-26 by walking the product as two customers) ─
 * Seven GET routes read one row by id and returned it straight through `json()`.
 * Every repository `getById` resolves to `undefined` when the row is not there,
 * and `json()` deliberately coerces `undefined` to `null` so the serializer
 * cannot crash. The two behaviours compose into a wrong answer: asking for a
 * lead that does not exist -- or one belonging to ANOTHER CUSTOMER, since the
 * lookup is workspace-scoped and simply finds nothing -- returned
 * `200 null`.
 *
 * No data leaked: the scoping was correct, and the walk checked the body for the
 * other tenant's fields and found none. What was wrong is the ANSWER. "Here you
 * go, it is nothing" is not the same statement as "that does not exist", and a
 * caller cannot tell an empty record from a refused one. The tenant boundary
 * should say so out loud.
 *
 * Note what hid it: `json()`'s undefined-to-null coercion was added to stop a
 * real 500 (the 2026-07-27 sla-settings P0). It did its job -- and in doing so
 * turned every one of these misses from a loud crash into a quiet success. The
 * chokepoint stays; routes that address one row by id opt into this instead.
 *
 * It lives here rather than in the route file because a Next.js route module
 * should export only its handlers, and because a golden has to be able to
 * import it and prove it.
 */
export function jsonOne<T>(value: T | undefined | null, what: string) {
  if (value === undefined || value === null) return notFoundResponse(`${what} not found`);
  return NextResponse.json(value, { status: 200, headers: { "cache-control": "no-store" } });
}
