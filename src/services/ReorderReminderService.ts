/**
 * Reorder and dormant-customer reminders from order history (2026-09-28, CEO
 * overnight; review 2026-09-27 §2 proposal 2).
 *
 * For a customer with 2+ placed orders, the USUAL GAP is the median number of
 * days between consecutive orders. The daily routine then:
 *   - past the usual gap        → PROPOSES a "reorder" reminder;
 *   - at twice the usual gap    → the customer is "dormant": a still-waiting
 *                                 reorder proposal is upgraded to dormant, or,
 *                                 if the owner already kept/dismissed it, one
 *                                 dormant proposal is made.
 * At most one reorder and one dormant proposal per customer per cycle (a cycle
 * ends when a new order arrives — the last order's id is the cycle key).
 * Never for a customer on do-not-contact (lead flag, status, or the permanent
 * register). A proposal counts for nothing until the owner keeps it; nothing
 * is ever sent to the customer. Deterministic, no AI call.
 */
import type { RepositoryBundle } from "@/repositories/interfaces";
import type { FollowUp, Order } from "@/lib/types";
import { isContactBlocked } from "@/lib/dnc-registry";
import { todayIstIsoDate } from "@/lib/time";

const DAY_MS = 86_400_000;
/** Gaps shorter than this are split deliveries, not a buying rhythm. */
export const MIN_USUAL_GAP_DAYS = 7;
export const DORMANT_MULTIPLE = 2;
const PLACED = new Set(["confirmed", "in_progress", "partial_shipped", "shipped", "delivered", "partial_cancelled"]);

export type OrderRhythm = {
  orderCount: number;
  usualGapDays: number;
  lastOrderId: string;
  lastOrderAt: string;
  daysSinceLast: number;
  stage: "on_track" | "reorder" | "dormant";
};

function orderDate(order: Order): number {
  return Date.parse(order.confirmedAt || order.createdAt || "");
}

/** Pure: the customer's buying rhythm, or undefined when there is none yet. */
export function orderRhythm(orders: Order[], now: Date): OrderRhythm | undefined {
  const placed = orders
    .filter((o) => PLACED.has(o.status) && Number.isFinite(orderDate(o)))
    .sort((a, b) => orderDate(a) - orderDate(b));
  if (placed.length < 2) return undefined;
  const gaps: number[] = [];
  for (let i = 1; i < placed.length; i++) gaps.push((orderDate(placed[i]) - orderDate(placed[i - 1])) / DAY_MS);
  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const usualGapDays = Math.round(median);
  if (usualGapDays < MIN_USUAL_GAP_DAYS) return undefined;
  const last = placed[placed.length - 1];
  const daysSinceLast = Math.floor((now.getTime() - orderDate(last)) / DAY_MS);
  const stage = daysSinceLast >= usualGapDays * DORMANT_MULTIPLE ? "dormant" : daysSinceLast > usualGapDays ? "reorder" : "on_track";
  return { orderCount: placed.length, usualGapDays, lastOrderId: last.id, lastOrderAt: new Date(orderDate(last)).toISOString(), daysSinceLast, stage };
}

/** The order history in plain words — the evidence on the proposal. */
export function rhythmEvidence(r: OrderRhythm): string {
  return `Orders every ~${r.usualGapDays} days (${r.orderCount} orders); last order ${r.daysSinceLast} days ago on ${r.lastOrderAt.slice(0, 10)}.`;
}

function noteFor(stage: "reorder" | "dormant"): string {
  return stage === "dormant"
    ? "Has gone quiet — twice their usual time between orders. Worth a call?"
    : "Usually orders again about now — check in about their next order?";
}

export type ReorderRunResult = { proposed: number; upgraded: number };

export async function proposeReorderReminders(workspaceId: string, repos: RepositoryBundle, now: Date = new Date()): Promise<ReorderRunResult> {
  const result: ReorderRunResult = { proposed: 0, upgraded: 0 };
  const orders = await repos.order.listByWorkspace(workspaceId);
  const byLead = new Map<string, Order[]>();
  for (const o of orders) if (o.leadId) byLead.set(o.leadId, [...(byLead.get(o.leadId) ?? []), o]);
  const today = todayIstIsoDate(now);
  for (const [leadId, leadOrders] of byLead) {
    const rhythm = orderRhythm(leadOrders, now);
    if (!rhythm || rhythm.stage === "on_track") continue;
    const lead = await repos.lead.getLeadById(workspaceId, leadId);
    if (!lead) continue;
    if ((await isContactBlocked(workspaceId, lead, repos)).blocked) continue;
    const thisCycle = (await repos.followUp.listByWorkspace(workspaceId, { leadId }))
      .filter((f: FollowUp) => f.source === "ai_proposed" && f.cycleKey === rhythm.lastOrderId);
    const evidence = rhythmEvidence(rhythm);
    if (rhythm.stage === "dormant") {
      if (thisCycle.some((f) => f.kind === "dormant")) continue;
      const waiting = thisCycle.find((f) => f.kind === "reorder" && f.status === "proposed");
      if (waiting) {
        await repos.followUp.update(workspaceId, waiting.id, { kind: "dormant", note: noteFor("dormant"), evidence });
        result.upgraded++;
        continue;
      }
    } else if (thisCycle.some((f) => f.kind === "reorder")) {
      continue;
    }
    await repos.followUp.create(workspaceId, {
      leadId,
      dueOn: today,
      note: noteFor(rhythm.stage),
      source: "ai_proposed",
      evidence,
      status: "proposed",
      kind: rhythm.stage,
      cycleKey: rhythm.lastOrderId,
    });
    result.proposed++;
  }
  return result;
}
