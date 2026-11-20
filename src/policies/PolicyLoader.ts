import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultAgentBehaviorPolicy } from "@/policies/default-agent-behavior-policy";

const policyFiles: Record<string, string> = {
  global: "global-agent-behavior.md",
  whatsapp: "whatsapp-agent-behavior.md",
  no_hallucination: "no-hallucination-policy.md",
  human_escalation: "human-escalation-policy.md",
  lead_review: "lead-review-policy.md",
  auto_reply_safety: "auto-reply-safety-policy.md",
  website_crawler_consent: "website-crawler-consent-policy.md",
  document_extraction: "document-extraction-policy.md",
  product_application_research: "product-application-research-policy.md",
  sensitive_topic: "sensitive-topic-policy.md",
  abusive_customer: "abusive-customer-policy.md",
  do_not_contact: "do-not-contact-policy.md",
};

export async function loadPolicyMarkdown(key: string) {
  const fileName = policyFiles[key] || policyFiles.global;
  try {
    return await readFile(path.join(process.cwd(), "policies", fileName), "utf8");
  } catch {
    return JSON.stringify(defaultAgentBehaviorPolicy, null, 2);
  }
}
