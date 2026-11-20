import { defaultWorkspaceId } from "@/lib/db";
import type { JsonRecord } from "@/lib/types";
import { createRepositories } from "@/repositories";
import { redactSecretsFromObject } from "@/lib/secret-redaction";

export type AuditAction =
  | "business_profile.created"
  | "business_profile.approved"
  | "icp.generated"
  | "icp.selected"
  | "campaign.created"
  | "campaign.approved"
  | "lead.created"
  | "lead.approved"
  | "lead.rejected"
  | "lead.enriched"
  | "lead.scored"
  | "lead.status_changed"
  | "message.generated"
  | "message.approved"
  | "outreach.marked_sent"
  | "reply.created"
  | "reply.classified"
  | "integration.connected";

export type AuditInput = {
  workspaceId?: string;
  // Cluster 4 fix (2026-07-26 audit, P1-1 / F1 / F2): `userId` is REQUIRED.
  // Previously optional, which meant 14 of 16 callsites omitted it → audit
  // rows with no actor (non-repudiation gap), and 2 sites stamped it from
  // the request body (forgery vector). Now every caller MUST pass the
  // session-resolved actor. Route handlers resolve it via `resolveActor`.
  userId: string;
  action: AuditAction | string;
  entityType?: string;
  entityId?: string;
  oldValuesJson?: JsonRecord;
  newValuesJson?: JsonRecord;
  metadataJson?: JsonRecord;
};

export class AuditLogService {
  constructor(private readonly repos = createRepositories()) {}

  async logAuditEvent(input: AuditInput) {
    return this.repos.auditLog.create({
      workspaceId: input.workspaceId || defaultWorkspaceId,
      actorUserId: input.userId,
      eventType: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: {
        oldValuesJson: redactSecretsFromObject(input.oldValuesJson || {}),
        newValuesJson: redactSecretsFromObject(input.newValuesJson || {}),
        metadataJson: redactSecretsFromObject(input.metadataJson || {}),
      },
    });
  }
}
