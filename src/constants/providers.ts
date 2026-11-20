export const PROVIDERS = [
  "manual",
  "whatsapp_deeplink",
  "whatsapp_cloud",
  "gmail",
  "smtp",
  "google_maps",
  "google_search",
  "instagram",
  "linkedin",
  "indiamart",
  "tradeindia",
  "apollo",
  "hunter",
  "clearbit",
  "email_verifier",
  "hubspot",
  "zoho",
  "google_sheets",
  "zapier_webhook",
] as const;

export type ProviderValue = (typeof PROVIDERS)[number];
