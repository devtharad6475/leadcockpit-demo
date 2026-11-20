import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getAuthMode } from "./auth";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function validateApiKeyOrWebhookSecret(request: NextRequest) {
  const authMode = getAuthMode();
  const configured = process.env.INBOUND_WEBHOOK_SECRET || process.env.API_SHARED_SECRET;
  if (!configured) {
    // Fail CLOSED in production: a missing secret means webhooks are rejected,
    // not silently allowed. Demo/local keeps the permissive placeholder so the
    // JSON demo and smoke tests keep working.
    if (authMode === "production") return { ok: false, mode: "missing-secret" as const };
    console.warn("Inbound API shared secret is not configured; allowing request in demo/local auth mode.");
    return { ok: true, mode: "development-placeholder" as const };
  }
  const provided = request.headers.get("x-webhook-secret") || request.headers.get("x-api-key");
  if (!provided) return { ok: false, mode: "shared-secret" as const };
  // Constant-time compare to avoid timing-based secret recovery.
  return { ok: safeEqual(provided, configured), mode: "shared-secret" as const };
}

export function assertSameWorkspace(entityWorkspaceId: string | undefined, requestWorkspaceId: string) {
  if (!entityWorkspaceId || entityWorkspaceId !== requestWorkspaceId) {
    throw new Error("Workspace access denied");
  }
}
