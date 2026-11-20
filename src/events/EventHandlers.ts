import { AuditLogService } from "@/services/AuditLogService";
import { registerEventHandler } from "./EventBus";
import type { AppEvent } from "./EventTypes";

let registered = false;

export function registerDefaultEventHandlers() {
  if (registered) return;
  registered = true;
  registerEventHandler("*", auditEventHandler);
}

async function auditEventHandler(event: AppEvent) {
  await new AuditLogService().logAuditEvent({
    workspaceId: event.workspaceId,
    // Cluster 4 fix: events don't carry a user actor in the current AppEvent
    // shape; tag as "system" so the row is never blank. (User-initiated actions
    // are also logged directly by their route handler with the session actor.)
    userId: (event.metadata && typeof event.metadata.actorUserId === "string") ? event.metadata.actorUserId : "system",
    action: event.eventType,
    entityType: event.entityType,
    entityId: event.entityId,
    newValuesJson: event.payload,
    metadataJson: { source: event.source, eventId: event.eventId, ...event.metadata },
  });
}
