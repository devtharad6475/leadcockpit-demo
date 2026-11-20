import { z } from "zod";
import { EmailSendError, getActiveEmailProvider, sendEmail, type EmailSendInput, type EmailSendResult } from "@/providers/email";

/** Account mail never assumes the operator owns a particular domain. */
export function accountEmailSender(): string {
  const sender = (process.env.TRANSACTIONAL_EMAIL_FROM || "").trim();
  if (!sender) {
    if (getActiveEmailProvider() === "mock") return "LeadCockpit demo <accounts@example.invalid>";
    throw new EmailSendError("Account email sender is not configured. Ask your administrator to set TRANSACTIONAL_EMAIL_FROM to a sender verified with the email provider.", { provider: "resend" });
  }
  const named = /^([^<>\r\n;,]+)\s*<([^<>\r\n]+)>$/.exec(sender);
  const mailbox = named ? named[2].trim() : sender;
  if (/[\r\n]/.test(sender) || !z.string().email().safeParse(mailbox).success) {
    throw new EmailSendError("Account email sender is invalid. Use one email address, optionally with a display name, in TRANSACTIONAL_EMAIL_FROM.", { provider: "resend" });
  }
  return named ? `${named[1].trim()} <${mailbox}>` : mailbox;
}

/** Configuration only: a ready sender still needs provider acceptance and inbox verification. */
export function getAccountEmailConfiguration(): {
  provider: "resend" | "mock";
  senderConfigured: boolean;
  ready: boolean;
  reason?: string;
} {
  const provider = getActiveEmailProvider();
  try {
    accountEmailSender();
    const senderConfigured = Boolean(process.env.TRANSACTIONAL_EMAIL_FROM?.trim());
    return { provider, senderConfigured, ready: provider === "resend" && senderConfigured,
      ...(provider === "mock" ? { reason: "Account email provider is not connected." } : {}) };
  } catch (error) {
    return { provider, senderConfigured: false, ready: false, reason: error instanceof Error ? error.message : "Account email sender is invalid." };
  }
}

/** Account-only choke point; reviewed customer outreach keeps its own sender rules. */
export async function sendAccountEmail(input: Omit<EmailSendInput, "from" | "purpose"> & {
  purpose: Exclude<EmailSendInput["purpose"], "outbound_lead">;
}): Promise<EmailSendResult> {
  return sendEmail({ ...input, from: accountEmailSender() });
}
