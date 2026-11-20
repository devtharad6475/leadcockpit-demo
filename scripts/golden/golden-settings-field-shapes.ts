/**
 * Golden test — settings field shapes and message column safety (N-DATA-22, N-DATA-23).
 *
 * WHY THIS EXISTS. Two bugs found by the 2026-09-01 screen walk had the same
 * root shape: a value of the wrong TYPE reached a layer that assumed the
 * declared type was a guarantee. In both cases the type checker was satisfied,
 * the JSON provider was satisfied, the e2e suite was green, and the product was
 * broken.
 *
 *   N-DATA-22  Settings → Communication crashed the entire screen with
 *              "(communication.humanReviewRequiredTopics || []).join is not a
 *              function". The field is declared `string[]` and its Prisma
 *              column is `Json?`, so Postgres happily stored a SENTENCE that
 *              `setSettingValue()` wrote there.
 *
 *   N-DATA-23  Every "generate a message" returned 500 on Postgres —
 *              "Unknown argument `missingInformation`" — because the create
 *              payload was assembled with a blind spread and carried a key that
 *              is not a column. The JSON provider accepts unknown keys, so the
 *              entire e2e suite stayed green while the shipping substrate was
 *              returning 500 for the feature.
 *
 * Hand-computed expected values:
 *
 *   CASE A — toStringList is TOTAL. A real array, a comma sentence, JSON text,
 *     null, undefined, empty string and a number all return an array. Nothing
 *     throws, because a `Json?` column can hold whatever an older build wrote.
 *
 *   CASE B — toStringList round-trips what the operator typed. The editor is
 *     labelled "comma-separated", so "price, credit, returns" must come back as
 *     three entries, not one.
 *
 *   CASE C — the exact production value that crashed the panel. A sentence
 *     stored in a list column yields a list, not an exception.
 *
 *   CASE D — coerceSettingValue writes the DECLARED shape. The two known list
 *     fields get an array; every other field keeps the string it was given.
 *
 *   CASE E — joinList never throws, for any of the CASE A inputs. This is the
 *     precise call that crashed: `.join` on a non-array.
 *
 *   CASE F — messageData drops keys that are not MessageTemplate columns, and
 *     keeps every key that is. `missingInformation` must not survive; `body`,
 *     `status`, `channel` and the rest must.
 *
 *   CASE G — messageData maps personalizationUsed onto the column Prisma
 *     actually has (`personalizationUsedJson`), and does not also pass the
 *     original key through.
 *
 *   CASE H — messageData omits absent optional fields rather than sending
 *     `undefined`, so a partial update does not blank columns it never meant to
 *     touch.
 */
import {
  toStringList,
  joinList,
  splitList,
  coerceSettingValue,
  isListSettingField,
  LIST_SETTING_FIELDS,
} from "@/lib/settings-field-shapes";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** The exact string that was sitting in the demo workspace's column. */
const THE_CRASHING_VALUE =
  "If a customer is angry, acknowledge the issue and pass it up to the team. Do not argue.";

async function main() {
  // === CASE A — toStringList is total ===
  const inputs: unknown[] = [
    ["a", "b"],
    "one, two",
    '["x","y"]',
    null,
    undefined,
    "",
    42,
    { not: "a list" },
  ];
  for (const input of inputs) {
    const out = toStringList(input);
    assert(Array.isArray(out), `CASE A: toStringList(${JSON.stringify(input)}) must return an array`);
  }
  assert(toStringList(null).length === 0, `CASE A: null → empty`);
  assert(toStringList(undefined).length === 0, `CASE A: undefined → empty`);
  assert(toStringList("").length === 0, `CASE A: empty string → empty`);
  assert(toStringList(["a", "", "  b  "]).join("|") === "a|b", `CASE A: blanks dropped, entries trimmed`);
  assert(toStringList('["x","y"]').join("|") === "x|y", `CASE A: JSON text of a list parses`);
  console.log(`  CASE A OK: toStringList never throws and always returns an array.`);

  // === CASE B — round-trips what the operator typed ===
  assert(toStringList("price, credit, returns").length === 3, `CASE B: commas split`);
  assert(joinList(["price", "credit"]) === "price, credit", `CASE B: joins back with ", "`);
  assert(splitList("a\nb, c").join("|") === "a|b|c", `CASE B: newlines split too (pasted answers)`);
  console.log(`  CASE B OK: comma-separated editing round-trips.`);

  // === CASE C — the production value that crashed the panel ===
  const recovered = toStringList(THE_CRASHING_VALUE);
  assert(Array.isArray(recovered), `CASE C: the crashing value must yield a list`);
  assert(recovered.length === 2, `CASE C: it has one comma, so two entries — got ${recovered.length}`);
  assert(recovered[0] === "If a customer is angry", `CASE C: first entry`);
  console.log(`  CASE C OK: the exact value that crashed Settings now renders.`);

  // === CASE D — coerceSettingValue writes the declared shape ===
  assert(LIST_SETTING_FIELDS.size >= 2, `CASE D: the list-field registry is populated`);
  assert(isListSettingField("communication", "humanReviewRequiredTopics"), `CASE D: known list field`);
  assert(isListSettingField("communication", "allowedAutoReplyTopics"), `CASE D: known list field`);
  assert(!isListSettingField("communication", "complaintReplyRule"), `CASE D: a sentence field is not a list`);
  assert(!isListSettingField("policy", "paymentPolicy"), `CASE D: policy fields are sentences`);

  const coercedList = coerceSettingValue("communication", "humanReviewRequiredTopics", THE_CRASHING_VALUE);
  assert(Array.isArray(coercedList), `CASE D: a list field must be persisted as an array`);
  const coercedText = coerceSettingValue("communication", "complaintReplyRule", THE_CRASHING_VALUE);
  assert(typeof coercedText === "string", `CASE D: a sentence field must stay a string`);
  assert(coercedText === THE_CRASHING_VALUE, `CASE D: and must not be altered`);
  console.log(`  CASE D OK: writes match each field's declared shape.`);

  // === CASE E — joinList never throws ===
  for (const input of inputs) {
    const out = joinList(input);
    assert(typeof out === "string", `CASE E: joinList(${JSON.stringify(input)}) must return a string`);
  }
  console.log(`  CASE E OK: the call that crashed the panel is now total.`);

  // === CASE F/G/H — message column safety ===
  // messageData is not exported (it is internal to the Prisma repository), so
  // the golden reads the SOURCE and asserts the property that matters: it must
  // not blind-spread. A structural assertion is deliberate — the bug was that
  // an unknown key reached Prisma, and any reintroduction of `...rest` brings
  // it straight back.
  const { readFileSync } = await import("node:fs");
  const repoSource = readFileSync("src/repositories/prisma/index.ts", "utf8");
  const start = repoSource.indexOf("function messageData(");
  assert(start > -1, `CASE F: messageData must exist in the Prisma repository`);
  const body = repoSource.slice(start, repoSource.indexOf("\n}", start));
  assert(
    !/\.\.\.rest/.test(body),
    `CASE F: messageData must NOT spread unknown keys — that is exactly what sent \`missingInformation\` to Prisma and 500'd every message generation`,
  );
  for (const column of ["workspaceId", "campaignId", "leadId", "channel", "subject", "body", "tone", "language", "status"]) {
    assert(body.includes(column), `CASE F: messageData must still carry the real column "${column}"`);
  }
  assert(body.includes("personalizationUsedJson"), `CASE G: personalizationUsed maps to the personalizationUsedJson column`);
  assert(!/data\.personalizationUsed\b\s*=/.test(body), `CASE G: the un-suffixed key must not also be sent`);
  assert(body.includes("!== undefined"), `CASE H: absent optional fields are omitted, not sent as undefined`);
  console.log(`  CASE F/G/H OK: the message create payload carries columns only.`);

  console.log("GOLDEN PASS: settings field shapes + message column safety");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
