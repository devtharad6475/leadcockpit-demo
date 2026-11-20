/**
 * CP-24 (2026-08-02) — WhatsApp 24-hour customer-service window helper.
 *
 * Meta's rule: within 24 hours of the customer's last inbound message, a
 * business may reply freely (free-form text). After 24 hours, the business
 * may ONLY send pre-approved Message Templates. This is a hard Meta rule,
 * not a feature — violating it causes the Meta API to REJECT the send.
 *
 * This module computes whether the window is open given a lead's
 * `lastInboundAt` timestamp, and how many hours remain.
 */

/**
 * Meta's 24-hour customer-service window, in milliseconds.
 *
 * Exported (2026-08-24, N-OBS-1) so `demo-freshness.ts` can ask the same
 * question about a whole dataset without keeping a second copy of the number.
 * `isWithin24hWindow` reads the wall clock; the demo check has to be able to
 * judge any instant, so it needs the constant rather than the function.
 */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const WINDOW_MS = WHATSAPP_WINDOW_MS;

export type WindowStatus = {
  /** true if free-text replies are allowed (within 24h of customer's last message). */
  open: boolean;
  /** when the window closes (or closed). Undefined if the customer never messaged. */
  closesAt?: Date;
  /** hours remaining in the window (0 if closed; undefined if never messaged). */
  hoursRemaining?: number;
  /** human-readable explanation for the UI. */
  label: string;
};

/**
 * Check whether the 24-hour customer-service window is open for a lead.
 * @param lastInboundAt ISO timestamp of the customer's last inbound message, or undefined.
 */
export function isWithin24hWindow(lastInboundAt: string | undefined): WindowStatus {
  if (!lastInboundAt) {
    return {
      open: false,
      label: "Customer hasn't messaged you yet — the 24-hour window is not open. A pre-approved template is required to send.",
    };
  }
  const lastInbound = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(lastInbound)) {
    return {
      open: false,
      label: "Last message timestamp is invalid — treating the window as closed.",
    };
  }
  const now = Date.now();
  const elapsed = now - lastInbound;
  const remaining = WINDOW_MS - elapsed;
  if (remaining <= 0) {
    return {
      open: false,
      closesAt: new Date(lastInbound + WINDOW_MS),
      hoursRemaining: 0,
      label: "The 24-hour customer-service window has closed. WhatsApp requires a pre-approved template to reply now.",
    };
  }
  const hoursRemaining = Math.floor(remaining / (60 * 60 * 1000));
  return {
    open: true,
    closesAt: new Date(lastInbound + WINDOW_MS),
    hoursRemaining,
    label: `24-hour window open — ${hoursRemaining}h ${Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000))}m remaining. Free-text replies allowed.`,
  };
}
