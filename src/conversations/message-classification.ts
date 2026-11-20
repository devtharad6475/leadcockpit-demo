import type { LeadStatus } from "@/lib/types";

export type MessageCategory =
  | "greeting"
  | "catalogue_request"
  | "price_request"
  | "sample_request"
  | "moq_request"
  | "delivery_question"
  | "payment_question"
  | "return_question"
  | "customization_question"
  | "export_question"
  | "location_question"
  | "bulk_order_interest"
  | "complaint"
  | "abusive_message"
  | "not_interested"
  | "unsubscribe"
  | "wrong_number"
  | "hot_lead"
  | "unknown_question"
  | "needs_human_review"
  | "other";

export type MessageRiskLevel = "low" | "medium" | "high";

export type MessageClassification = {
  category: MessageCategory;
  confidence: number;
  reason: string;
  leadStatusSuggestion?: LeadStatus;
  riskLevel: MessageRiskLevel;
  requiresHumanReview: boolean;
};

/**
 * N-BUG (2026-09-08). This was `text.includes(word)` — a raw substring test.
 * Measured on the live deployment:
 *
 *   "This is a complete waste of time. Your product broke on day one and your
 *    people are useless. I want this fixed today."
 *   → greeting, confidence 0.85, riskLevel low, requiresHumanReview false
 *
 * because "this" contains "hi". A furious customer was routed to the
 * greeting branch, which is one of only two categories treated as a generic
 * SAFE reply and therefore eligible to auto-send, and no ticket was opened
 * because the ticket branch fires on complaint/abusive_message/return_question.
 *
 * "hi" was the one that showed, not the only one: "rate" is inside
 * "generate" and "accurate", "custom" inside "customer", "not me" inside
 * "cannot meet", "hey" inside "they", "shop" inside "workshop".
 *
 * A keyword must therefore start at a word boundary. It may still be followed
 * by an ordinary inflection ("prices", "returned", "designing") — matching
 * "price" but not "prices" would be its own bug — but only for keywords long
 * enough that a suffix cannot rebuild an unrelated word. "hi" + "gh" is
 * exactly the failure being fixed, so the short ones stay strict.
 */
const INFLECTIONS = ["", "s", "es", "ed", "d", "ing", "ings", "ies", "'s"];
const MIN_LENGTH_FOR_INFLECTION = 4;

/** Letters and digits continue a word. A leading combining mark does too. */
const WORD_CHAR = /[\p{L}\p{N}]/u;
const LEFT_WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

function endsAtBoundary(text: string, word: string, end: number): boolean {
  const after = text.slice(end);
  if (!after || !WORD_CHAR.test(after[0])) return true;
  if (word.length < MIN_LENGTH_FOR_INFLECTION) return false;
  return INFLECTIONS.some((suffix) => {
    if (!suffix || !after.startsWith(suffix)) return false;
    const rest = after.slice(suffix.length);
    return !rest || !WORD_CHAR.test(rest[0]);
  });
}

function containsWord(text: string, word: string): boolean {
  for (let from = 0; ; from += 1) {
    const at = text.indexOf(word, from);
    if (at < 0) return false;
    const startsAWord = at === 0 || !LEFT_WORD_CHAR.test(text[at - 1]);
    if (startsAWord && endsAtBoundary(text, word, at + word.length)) return true;
    from = at;
  }
}

const includesAny = (text: string, words: string[]) => words.some((word) => containsWord(text, word));

export function classifyCustomerMessage(rawText: string): MessageClassification {
  // 2026-09-26 (break test): phones type a curly apostrophe (’), so
  // "Don’t message me" matched none of the "don't ..." keywords below.
  const text = rawText.toLowerCase().replace(/[‘’ʼ]/g, "'").trim();

  if (!text) {
    return result("unknown_question", 0.4, "Empty message cannot be answered safely.", "needs_review", "medium", true);
  }
  // 2026-08-05: bilingual keywords (English + Hindi/Hinglish). The product
  // targets Indian B2B — customers message in Hindi (Devanagari) + Hinglish
  // (Romanized Hindi) constantly. The old English-only keyword set missed
  // these → classified as "other" even when intent was clear. The LLM layer
  // on top catches most, but the deterministic classifier is the safety
  // floor + drives the initial review-routing, so it must understand both.
  // 2026-09-26 (break test): an opt-out goes on the PERMANENT do-not-contact
  // list, so a word here must mean "stop contacting me" and nothing else.
  // "नहीं चाहिए" ("don't need") was here and made "सैंपल नहीं चाहिए, रेट बताओ"
  // (no sample needed, tell me the rate) a permanent opt-out. On its own it
  // only says what the buyer does not need; the whole phrase "मुझे नहीं चाहिए"
  // (I don't want it) stays here, as before. "one-stop shop" and
  // "non-stop" are not a "stop". Missing opt-out phrasings added.
  const optOutText = text.replace(/\b(?:one|non)[\s-]?stop\b/g, " ");
  // 2026-09-27 (review W3): a bare "stop" is an opt-out only when it IS the
  // message ("Stop", "please stop") or is about the messages themselves. "Stop
  // the dispatch", "near which bus stop?" and "payment stop ho gaya hai" were
  // permanent opt-outs of buyers in the middle of an order.
  const bareStop = /^(?:please\s+|pls\s+|plz\s+)?stop(?:\s+(?:please|pls|plz|it|this|now))?[\s.!]*$/.test(optOutText);
  if (bareStop || includesAny(optOutText, [
    "stop messaging", "stop sending", "stop contacting", "stop texting", "stop calling", "stop the messages",
    "stop these messages", "stop your messages", "stop msg", "stop msgs",
    // Not "don't send me …" — "don't send me the sample yet" is a buyer.
    "don't send these", "dont send these", "do not send these",
    "no more messages", "don't want these messages", "don't want your messages",
    "don't contact me", "dont contact me", "never contact me",
    "unsubscribe", "remove me", "remove my number", "don't message", "do not message", "dont message",
    "do not contact", "opt out", "opt-out", "optout",
    "message mat karo", "msg mat karo", "message mat bhejo", "messages mat bhejo",
    // 2026-09-27 (review W4): romanised Hindi and Gujarati opt-outs. Only
    // phrases about MESSAGES — "band karo" / "mat bhejo" alone also mean "stop
    // the dispatch" / "don't send the sample".
    "message band karo", "msg band karo", "messages band karo", "message band kar do", "message bandh karo",
    "mujhe message mat", "message mat bhejna", "msg mat bhejna", "whatsapp mat karo", "whatsapp band karo",
    "મેસેજ ના મોકલો", "મેસેજ ન મોકલો", "મેસેજ બંધ કરો", "મેસેજ મોકલશો નહીં", "મને મેસેજ ના કરો",
    "मुझे हटाओ", "मुझे मैसेज मत करो", "मैसेज मत भेजो", "मैसेज मत करो", "बंद करो", "मुझे नहीं चाहिए",
    // 2026-09-28 (real-AI eval): with the model down, these two reached no
    // opt-out at all — the keyword pass is the only reader left then. Phrases
    // about MESSAGES only ("sample nahi chahiye" is a buyer, not an opt-out).
    "message nahi chahiye", "messages nahi chahiye", "msg nahi chahiye", "koi message nahi", "message mat karna",
    "मैसेज नहीं चाहिए", "कोई मैसेज नहीं",
    "મેસેજ ના કરો", "મેસેજ ન કરો", "મેસેજ નથી જોઈતા", "મેસેજ નહીં કરો", "મેસેજ કરશો નહીં",
  ])) {
    return result("unsubscribe", 0.96, "Customer asked to stop contact.", "do_not_contact", "high", true);
  }
  if (includesAny(text, ["wrong number", "wrong person", "not me", "गलत नंबर"])) {
    return result("wrong_number", 0.9, "Customer says this is the wrong person or number.", "invalid", "high", true);
  }
  if (includesAny(text, ["not interested", "no need", "not required", "don't need", "मुझे नहीं चाहिए", "ज़रूरत नहीं", "मना"])) {
    return result("not_interested", 0.88, "Customer is not interested.", "not_interested", "medium", false);
  }
  if (includesAny(text, ["idiot", "stupid", "shut up", "abuse", "fraud", "चोर", "बेईमान", "कमीने", "बकवास", "फ्रॉड"])) {
    return result("abusive_message", 0.82, "Message appears abusive or hostile.", undefined, "high", true);
  }
  // 2026-09-08: the live complaint that exposed the substring-matching bug —
  // "Your product broke on day one and your people are useless" — matched none
  // of these words either. A customer complaining rarely types "complaint";
  // they say what broke. The Tickets screen promises that a complaint on
  // WhatsApp opens a ticket, and the ticket branch fires on this category, so a
  // complaint this plain going unrecognised is that promise not being kept.
  if (includesAny(text, [
    "complaint", "bad", "issue", "problem", "not received", "damaged",
    "broke", "broken", "not working", "doesn't work", "does not work",
    "defective", "faulty", "useless", "waste of time", "poor quality",
    "worst", "terrible", "unacceptable",
    "शिकायत", "खराब", "समस्या", "परेशानी", "टूट", "काम नहीं", "बेकार",
    // 2026-09-27 (review W4): romanised Hindi and Gujarati.
    "kharab", "kharaab", "toota", "tuta", "galat maal", "shikayat", "bekar", "bekaar",
    "ખરાબ", "ફરિયાદ", "તૂટેલ", "તૂટી", "બેકાર",
  ])) {
    return result("complaint", 0.8, "Customer appears to be raising a complaint.", "replied", "high", true);
  }
  if (includesAny(text, ["price", "rate", "cost", "quotation", "quote", "how much", "दाम", "कीमत", "भाव", "रेट", "दाम क्या", "कितने का",
    // 2026-09-27 (review W4): romanised Hindi and Gujarati price words.
    "bhav", "bhaav", "daam", "kitne ka", "kitna ka", "kitne ki", "kitne me", "kitne mein", "kitna padega",
    "ભાવ", "કિંમત", "રેટ", "કેટલા નો", "કેટલાનું"])) {
    return result("price_request", 0.9, "Customer asked about price or quotation.", "hot_lead", "medium", true);
  }
  if (includesAny(text, ["sample", "swatch", "नमूना", "सैंपल", "namuna", "નમૂનો", "નમૂના", "સેમ્પલ",
    // 2026-09-28 (real-AI eval): "Shade card milega?" fell through to unknown.
    "shade card", "शेड कार्ड", "શેડ કાર્ડ"])) {
    return result("sample_request", 0.88, "Customer asked for a sample.", "hot_lead", "medium", true);
  }
  if (includesAny(text, ["moq", "minimum order", "minimum quantity", "न्यूनतम ऑर्डर", "कम से कक्षन", "कम से कम", "kam se kam", "minimum kitna", "ઓછામાં ઓછું", "ઓછામાં ઓછા"])) {
    return result("moq_request", 0.86, "Customer asked about minimum order quantity.", "hot_lead", "medium", true);
  }
  if (includesAny(text, ["delivery", "dispatch", "shipping", "when can", "deliver", "डिलीवरी", "भेजना", "पहुँचना", "भेजोगे",
    // 2026-09-27 (review W4): romanised Hindi and Gujarati.
    "kab tak", "kab milega", "kab aayega", "kab bhejoge", "kab bhejenge",
    "ડિલિવરી", "ક્યારે મળશે", "ક્યારે મોકલશો", "ક્યાં સુધી"])) {
    return result("delivery_question", 0.82, "Customer asked about delivery or dispatch.", "hot_lead", "medium", true);
  }
  if (includesAny(text, ["payment", "advance", "credit", "terms", "भुगतान", "अडवांस", "क्रेडिट", "उधार", "पेमेंट",
    "udhaar", "udhar", "udhari", "ઉધાર", "પેમેન્ટ", "ચુકવણી"])) {
    return result("payment_question", 0.82, "Customer asked about payment terms.", "sql", "high", true);
  }
  if (includesAny(text, ["return", "refund", "exchange", "वापसी", "रिफंड", "वापस"])) {
    return result("return_question", 0.82, "Customer asked about return or refund policy.", "replied", "high", true);
  }
  if (includesAny(text, ["custom", "customize", "design", "photo", "made to order", "कस्टम", "डिज़ाइन", "अपने अनुसार"])) {
    return result("customization_question", 0.78, "Customer asked about customization.", "sql", "medium", true);
  }
  if (includesAny(text, ["export", "international", "overseas", "uae", "dubai", "निर्यात", "एक्सपोर्ट"])) {
    return result("export_question", 0.74, "Customer asked about export or international supply.", "sql", "medium", true);
  }
  if (includesAny(text, ["location", "located", "address", "where are you", "shop", "पता", "कहाँ", "दुकान",
    // 2026-09-28 (real-AI eval). Whole phrases about the BUSINESS's place —
    // a bare "kahan" / "ક્યાં" is also "where is my order", which is not this.
    "factory kahan", "shop kahan", "dukan kahan", "office kahan", "godown kahan", "aapka address", "address kya",
    "દુકાન ક્યાં", "ઓફિસ ક્યાં", "ફેક્ટરી ક્યાં", "સરનામું"])) {
    return result("location_question", 0.78, "Customer asked for business location.", "interested", "low", false);
  }
  if (includesAny(text, ["bulk", "large quantity", "wholesale", "distributor", "थोक", "बल्क", "बड़ा ऑर्डर"])) {
    return result("bulk_order_interest", 0.84, "Customer mentioned bulk or wholesale interest.", "hot_lead", "medium", true);
  }
  if (includesAny(text, ["catalogue", "catalog", "brochure", "send designs", "send pics", "सूची", "लिस्ट", "उत्पादों की सूची", "प्रोडक्ट्स की लिस्ट", "कैटलॉग", "सारे प्रोडक्ट",
    // 2026-09-28 (real-AI eval): Gujarati catalogue and "product list".
    "product list", "products list", "કેટલોગ", "કેટાલોગ", "કૅટલોગ", "પ્રોડક્ટ લિસ્ટ"])) {
    return result("catalogue_request", 0.92, "Customer asked for catalogue or product list.", "mql", "low", false);
  }
  // 2026-09-27 (review W2): a greeting is a message that is ONLY a greeting.
  // "Hi, is 500m gold zari available?" was a greeting — the safest kind, the
  // one that needs no approved knowledge — and could go out automatically.
  if (includesAny(text, GREETING_WORDS) && isOnlyAGreeting(text)) {
    return result("greeting", 0.85, "Customer sent a greeting.", "replied", "low", false);
  }
  if (text.endsWith("?") || /[?؟]/.test(text)) {
    return result("unknown_question", 0.65, "Question does not match a safe known category.", "replied", "medium", true);
  }
  return result("other", 0.55, "General customer message.", "replied", "low", false);
}

// 2026-09-28 (real-AI eval): "नमस्ते जी" and "Jai Shree Krishna 🙏" — the
// commonest trade greetings in Surat — were "other", so an owner who proved
// greetings still had them all waiting.
const GREETING_WORDS = ["hi", "hii", "hiii", "hello", "helo", "hey", "namaste", "नमस्ते", "namaskar", "namaskaar", "नमस्कार", "નમસ્તે", "નમસ્કાર", "kem cho", "કેમ છો", "good morning", "good afternoon", "good evening",
  "jai shree krishna", "jai shri krishna", "jai shree krishn", "ram ram", "jai jinendra", "जय श्री कृष्ण", "राम राम", "જય શ્રી કૃષ્ણ", "જય જિનેન્દ્ર"];
const GREETING_FILLER = ["sir", "madam", "mam", "ma'am", "ji", "जी", "bhai", "भाई", "bhaiya", "team", "there", "all", "everyone", "dear", "sahab", "saheb", "साहब", "સાહેબ", "ભાઈ",
  // Check-ins that ask nothing about the business.
  "are you there", "anyone there", "is anyone there", "how are you", "kaise ho", "aap kaise ho"];

/** True when nothing but greeting words, polite fillers and punctuation is left. */
function isOnlyAGreeting(text: string): boolean {
  let rest = ` ${text.replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ")} `;
  for (const word of [...GREETING_WORDS, ...GREETING_FILLER].sort((a, b) => b.length - a.length)) {
    rest = rest.split(` ${word} `).join(" ");
  }
  return rest.trim().length === 0;
}

function result(
  category: MessageCategory,
  confidence: number,
  reason: string,
  leadStatusSuggestion?: LeadStatus,
  riskLevel: MessageRiskLevel = "low",
  requiresHumanReview = false,
): MessageClassification {
  return { category, confidence, reason, leadStatusSuggestion, riskLevel, requiresHumanReview };
}
