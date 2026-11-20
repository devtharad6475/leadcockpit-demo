import type { AppEvent, AppEventType } from "./EventTypes";
import { captureException } from "@/lib/monitoring";

export type EventHandler = (event: AppEvent) => Promise<void> | void;

const handlers = new Map<AppEventType | "*", EventHandler[]>();

export function registerEventHandler(eventType: AppEventType | "*", handler: EventHandler) {
  const current = handlers.get(eventType) || [];
  current.push(handler);
  handlers.set(eventType, current);
}

export async function dispatchEvent(event: AppEvent) {
  const selected = [...(handlers.get("*") || []), ...(handlers.get(event.eventType) || [])];
  for (const handler of selected) {
    try {
      await handler(event);
    } catch (error) {
      // Stage C.3: route to Sentry when configured, fall back to console.error
      // otherwise (captureException never throws).
      captureException(error, { eventType: event.eventType, source: "EventBus.dispatchEvent" });
      console.error("Internal event handler failed", { eventType: event.eventType, error });
    }
  }
}
