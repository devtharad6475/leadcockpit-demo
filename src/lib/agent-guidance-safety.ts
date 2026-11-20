// Shared by save checks and runtime defence; these patterns are deliberately
// bounded and do not represent a complete prompt-injection detector.
const OVERRIDE_EVASION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|safety|security)\s+instructions?/gi,
  /disregard\s+(all\s+)?(previous|prior|above|safety|security)\s+(instructions?|rules?|policies?)/gi,
  /you\s+are\s+now\s+(in\s+)?(developer|admin|root|jailbreak|unrestricted)\s+mode/gi,
  /forget\s+(all\s+)?(previous|prior|your)\s+(instructions?|rules?|policies?)/gi,
  /override\s+(the\s+)?(safety|security|no-hallucination|global)\s+(policy|rules?|instructions?)/gi,
];

export function sanitizeWorkspaceOverride(text: string): string {
  let cleaned = text;
  for (const pattern of OVERRIDE_EVASION_PATTERNS) cleaned = cleaned.replace(pattern, "[override-evasion phrase removed by safety scanner]");
  return cleaned;
}
