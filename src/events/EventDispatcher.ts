import { dispatchEvent } from "./EventBus";
import { registerDefaultEventHandlers } from "./EventHandlers";
import type { AppEvent, EventInput } from "./EventTypes";
import { redactSecretsFromObject } from "@/lib/secret-redaction";
import { captureException } from "@/lib/monitoring";

function eventId() {
  return `event_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function emitEvent(input: EventInput) {
  registerDefaultEventHandlers();
  const event: AppEvent = {
    eventId: input.eventId || eventId(),
    timestamp: input.timestamp || new Date().toISOString(),
    ...input,
    payload: redactSecretsFromObject(input.payload || {}),
  };
  try {
    await dispatchEvent(event);
  } catch (error) {
    // Stage C.3: route to Sentry when configured. captureException never
    // throws, so this can never become a new error source.
    captureException(error, { eventType: input.eventType, source: "EventDispatcher.emitEvent" });
    console.error("Internal event dispatch failed", redactSecretsFromObject({ eventType: input.eventType, error }));
  }
  return event;
}
