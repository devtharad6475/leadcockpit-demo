/**
 * 2026-09-28 — Messages to the OWNER's own WhatsApp (never to a customer).
 * Pure rules: the settings shape and defaults, the owner-number check, and
 * the quiet hours. The sending lives in src/services/OwnerNotifyService.ts.
 * Rules: docs/LOGIC.md OWNER-WHATSAPP; decision D-2026-09-28-a (proposed).
 */
import { istParts } from "./time";

export type OwnerNotifySettings = {
  /** "Send me a morning summary on WhatsApp". Off by default. */
  morningSummary: boolean;
  /** Urgent alerts (complaint, big order, customer waiting, ticket about to be late). Off by default. */
  urgentAlerts: boolean;
  /** An order or quote at or above this many rupees is an alert. Unset = that alert is off. */
  bigAmountInr?: number;
  /** At most this many alerts a day; the rest go into the next morning summary. */
  maxAlertsPerDay: number;
  /** The Meta-approved WhatsApp template the summary goes out in (outside the 24-hour window Meta allows nothing else). */
  summaryTemplateId?: string;
  /** The Meta-approved WhatsApp template alerts go out in. */
  alertTemplateId?: string;
};

export const DEFAULT_MAX_ALERTS_PER_DAY = 5;
export const MAX_ALERTS_PER_DAY_LIMIT = 20;
/** Quiet hours, IST: 21:00 to 08:00. An alert then waits for the morning summary. */
export const QUIET_START_MINUTE = 21 * 60;
export const QUIET_END_MINUTE = 8 * 60;
/** An urgent ticket is an alert this many minutes before its deadline. */
export const TICKET_ALERT_MINUTES_BEFORE = 30;

export const DEFAULT_OWNER_NOTIFY_SETTINGS: OwnerNotifySettings = {
  morningSummary: false,
  urgentAlerts: false,
  maxAlertsPerDay: DEFAULT_MAX_ALERTS_PER_DAY,
};

/** The stored settings with every default filled in. Anything unreadable falls back to OFF. */
export function readOwnerNotifySettings(stored: unknown): OwnerNotifySettings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const max = Number(s.maxAlertsPerDay);
  const big = Number(s.bigAmountInr);
  return {
    morningSummary: s.morningSummary === true,
    urgentAlerts: s.urgentAlerts === true,
    bigAmountInr: Number.isFinite(big) && big > 0 ? Math.round(big) : undefined,
    maxAlertsPerDay: Number.isInteger(max) && max >= 1 && max <= MAX_ALERTS_PER_DAY_LIMIT ? max : DEFAULT_MAX_ALERTS_PER_DAY,
    summaryTemplateId: typeof s.summaryTemplateId === "string" && s.summaryTemplateId.trim() ? s.summaryTemplateId.trim() : undefined,
    alertTemplateId: typeof s.alertTemplateId === "string" && s.alertTemplateId.trim() ? s.alertTemplateId.trim() : undefined,
  };
}

export type OwnerNumberCheck = { ok: true; number: string } | { ok: false; message: string };

/**
 * The owner's WhatsApp number, checked and written one way: "+<country><number>".
 * A number with no country code is Indian (+91, CEO 2026-09-27). An Indian
 * mobile is 10 digits starting 6–9; any other country needs 8–15 digits.
 */
export function normalizeOwnerWhatsappNumber(raw: unknown): OwnerNumberCheck {
  const text = typeof raw === "string" ? raw.trim() : "";
  const bad: OwnerNumberCheck = { ok: false, message: "Enter your WhatsApp mobile number, for example +91 98250 33333." };
  if (!text) return bad;
  if (/[^\d\s+().-]/.test(text)) return bad;
  let digits = text.replace(/\D/g, "");
  let international = text.startsWith("+");
  if (!international && digits.startsWith("00")) { digits = digits.slice(2); international = true; }
  if (!international) {
    if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    if (digits.length !== 10) return bad;
    digits = `91${digits}`;
  }
  if (digits.startsWith("91")) {
    const local = digits.slice(2);
    if (!/^[6-9]\d{9}$/.test(local)) return { ok: false, message: "An Indian WhatsApp number is 10 digits starting with 6, 7, 8 or 9." };
    return { ok: true, number: `+${digits}` };
  }
  if (digits.length < 8 || digits.length > 15) return bad;
  return { ok: true, number: `+${digits}` };
}

/** True between 21:00 and 08:00 IST. */
export function isOwnerQuietHours(now: Date = new Date()): boolean {
  const p = istParts(now);
  const minute = p.hours * 60 + p.minutes;
  return minute >= QUIET_START_MINUTE || minute < QUIET_END_MINUTE;
}

/**
 * Meta does not allow a line break (or a tab, or more than four spaces) inside
 * a template variable, so a many-line message goes into the template's one
 * variable as one line, the lines joined with " | ".
 */
export function toTemplateVariable(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" | ")
    .slice(0, 1000);
}
