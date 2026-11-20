export const CHANNELS = [
  "whatsapp",
  "email",
  "instagram_dm",
  "linkedin",
  "contact_form",
  "phone_script",
  "sms",
] as const;

export type ChannelValue = (typeof CHANNELS)[number];
