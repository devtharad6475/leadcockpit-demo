/**
 * settings-field-shapes.ts — which structured-settings fields hold a LIST
 * rather than a sentence, and the one total way to read and write them.
 *
 * WHY THIS EXISTS (2026-09-01, N-DATA-22)
 * --------------------------------------
 * The Settings → Communication panel crashed the whole screen into the route
 * error boundary:
 *
 *     TypeError: (communication.humanReviewRequiredTopics || []).join is not a
 *     function          at StructuredSettingsPanel
 *
 * `humanReviewRequiredTopics` is declared `string[]` in src/lib/types.ts and
 * `Json?` in prisma/schema.prisma — but the row held a SENTENCE. The cause is a
 * single chokepoint: `setSettingValue()` in ExtractionRoutingService takes
 * `value: string` and assigns it to `[fieldKey]` whatever that field's shape
 * is. Both extraction routing and conflict resolution write through it, so
 * every answer routed at a list field was stored with the wrong type.
 *
 * `Json?` is the important detail: Postgres accepted it happily. Nothing failed
 * at write time, at read time, or in the type checker — the column's TypeScript
 * type is a claim, not a constraint. The first thing that noticed was a `.join`
 * at render, one layer too late to do anything but crash.
 *
 * So this module fixes both ends, and both must stay fixed:
 *   - WRITE: `coerceSettingValue()` turns the answer into the field's declared
 *     shape before it is persisted.
 *   - READ:  `toStringList()` accepts a list, a sentence, null, or the JSON
 *     text of a list, and always returns a list. A `Json?` column can hold
 *     anything a previous version of the code put there, so the reader has to
 *     be total no matter how correct the writer becomes.
 *
 * RESOLVED 2026-09-24: `whatsapp_communication / abusive_customer_handling`
 * used to route into `humanReviewRequiredTopics`, a list of TOPICS, although
 * its answer is a sentence about BEHAVIOUR. It now has its own text field,
 * `communication.abusiveMessageRule`, which the agent context reads. Abusive
 * messages still always go to a person; the rule only tells the AI how.
 */

/** The settings fields whose declared type is `string[]`, by "area.fieldKey". */
export const LIST_SETTING_FIELDS: ReadonlySet<string> = new Set([
  "communication.allowedAutoReplyTopics",
  "communication.humanReviewRequiredTopics",
]);

/**
 * Fields holding a keyed map rather than a list or a sentence. Listed so the
 * next person can see the whole picture in one place; nothing routes at it
 * today, and `coerceSettingValue` deliberately refuses to guess a map from a
 * sentence rather than inventing keys.
 */
export const MAP_SETTING_FIELDS: ReadonlySet<string> = new Set(["sales.productWiseMOQ"]);

export function isListSettingField(area: string, fieldKey: string): boolean {
  return LIST_SETTING_FIELDS.has(`${area}.${fieldKey}`);
}

/**
 * Read any stored value as a list of strings, without ever throwing.
 *
 * Accepts, in order: a real array; the JSON text of an array (what a `Json`
 * column round-trips to when something stringified it on the way in); a plain
 * sentence, split on the SAME separator the editor uses so what an operator
 * typed comes back as what they typed; null/undefined.
 */
export function toStringList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    if (text.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
      } catch {
        // Not JSON after all — fall through and treat it as text.
      }
    }
    return splitList(text);
  }
  // A number, a boolean, an object: show it rather than hide it, so a wrong
  // shape stays visible to the operator instead of silently becoming empty.
  return [String(value)];
}

/**
 * The editor for these fields is labelled "comma-separated", so commas are the
 * separator the operator was told about. Newlines are accepted too because
 * pasted answers arrive with them and dropping the split there would produce
 * one long fake entry.
 */
export function splitList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Render a list back into the text the editor shows. */
export function joinList(value: unknown): string {
  return toStringList(value).join(", ");
}

/**
 * Put a routed answer into the shape its target field declares.
 *
 * Returns `string | string[]`, so the caller persists the declared type instead
 * of whatever the extraction happened to produce.
 */
export function coerceSettingValue(area: string, fieldKey: string, value: string): string | string[] {
  if (isListSettingField(area, fieldKey)) return toStringList(value);
  return value;
}
