/**
 * NeedsActionError — the request cannot go ahead until the PERSON does
 * something first ("fill in your business profile", "approve a campaign",
 * "attach a file"). Not a server fault.
 *
 * 2026-09-26 (break test): these used to be thrown as plain Errors, and the
 * API's error handler — which guesses 4xx from words like "not found" or
 * "cannot" — turned them into HTTP 500 with "Something went wrong on our side.
 * Nothing you did caused it." That was untrue, it hid the one thing the owner
 * needed to do, and it raised an operator alert for a normal situation.
 * Throw this instead; the handler shows its message as written.
 */
export class NeedsActionError extends Error {
  readonly statusCode: 400 | 404 | 409;
  constructor(message: string, statusCode: 400 | 404 | 409 = 409) {
    super(message);
    this.name = "NeedsActionError";
    this.statusCode = statusCode;
  }
}
