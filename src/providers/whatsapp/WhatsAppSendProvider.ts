export type WhatsAppSendInput = {
  workspaceId: string;
  to: string;
  body: string;
  previewOnly?: boolean;
  mediaAttachmentUrl?: string;
  mediaAttachmentMimeType?: string;
  mediaAttachmentFilename?: string;
  publicOrigin?: string;
};

// CP-25 (2026-08-02) — template send input. Used when the 24h window is closed.
export type WhatsAppTemplateSendInput = {
  workspaceId: string;
  to: string;
  templateName: string;
  language: string; // e.g. "en_US"
  components?: Array<{ type: "body" | "header" | "button"; parameters: Array<{ type: string; text?: string }> }>;
};

export type WhatsAppSendResult = {
  attempted: boolean;
  status: "not_attempted" | "not_configured" | "sent" | "failed" | "blocked" | "dry_run";
  provider: "meta_cloud";
  providerMessageId?: string;
  errorMessage?: string;
};

/**
 * Stage B (2026-07-26) — Test-connection result. Returned by
 * `testConnection()`. The operator sees this in the Integrations UI after
 * clicking "Save & Test". Honest about every state — never fake-success.
 */
export type WhatsAppTestResult = {
  ok: boolean;
  /** One of: "not_configured", "connected", "auth_failed", "wrong_number", "rate_limited", "network_error", "unknown_error". */
  status: "not_configured" | "connected" | "auth_failed" | "wrong_number" | "rate_limited" | "network_error" | "unknown_error";
  /** Human-readable explanation for the UI. */
  message: string;
  /** Display name of the verified phone number (when connected). */
  displayPhoneNumber?: string;
  /** Quality rating Meta reports for the number (when connected). */
  qualityRating?: string;
};

export interface WhatsAppSendProvider {
  isConfigured(): boolean;
  sendTextMessage(input: WhatsAppSendInput): Promise<WhatsAppSendResult>;
  /**
   * CP-25 (2026-08-02) — Send a pre-approved Meta template message. Used when
   * the 24-hour customer-service window is closed (Meta only allows templates
   * after 24h). The template must be pre-approved by Meta.
   */
  sendTemplateMessage?(input: WhatsAppTemplateSendInput): Promise<WhatsAppSendResult>;
  /**
   * Stage B (2026-07-26) — Validate the credentials WITHOUT sending a message.
   * Pings Meta's GET /v20.0/{phoneNumberId} endpoint, which returns the phone
   * number details if the access token is valid + the phone ID belongs to the
   * token's WABA. Honest about every failure mode (no fake "connected").
   */
  testConnection(): Promise<WhatsAppTestResult>;
}
