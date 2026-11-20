/**
 * tolerant-json.ts — read a model's JSON reply when the only thing wrong with it
 * is a raw line break inside a string (2026-09-24).
 *
 * Found on the Command Center's first live run: the message writer answered
 * correctly ("no eligible leads"), but wrote its multi-line answer with REAL
 * newlines inside the JSON string instead of "\n". JSON.parse rejects that
 * ("Bad control character in string literal"), so a correct answer was
 * reported as a failed step and the job ended "partly finished".
 *
 * The repair is deliberately narrow: control characters (U+0000–U+001F) that
 * sit INSIDE a string literal are escaped. Nothing outside strings is touched,
 * and nothing else is "fixed" — a reply that is broken in any other way still
 * fails loudly, because guessing at a model's meaning is how made-up data gets
 * in.
 */
const ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };

export function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += char;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        out += char;
        continue;
      }
      if (char === "\"") {
        inString = false;
        out += char;
        continue;
      }
      const code = char.charCodeAt(0);
      if (code < 0x20) {
        out += ESCAPES[char] ?? `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += char;
      continue;
    }
    if (char === "\"") inString = true;
    out += char;
  }
  return out;
}

/** JSON.parse, then one retry with raw control characters inside strings escaped. */
export function parseModelJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (firstError) {
    const repaired = escapeControlCharsInStrings(text);
    if (repaired === text) throw firstError;
    try {
      return JSON.parse(repaired);
    } catch {
      // Report the ORIGINAL problem; the repair was only ever a narrow retry.
      throw firstError;
    }
  }
}
