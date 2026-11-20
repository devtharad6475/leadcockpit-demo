/**
 * Stage A+ / Cluster 10b (2026-07-26, P2-8) — Shared clipboard helper.
 *
 * Replaces 6 inline `navigator.clipboard.writeText(...)` sites in page.tsx,
 * 3 of which had NO `.catch` (unhandled promise rejection if the clipboard
 * API is unavailable — common in older browsers, insecure contexts, or
 * when the user denies clipboard permission) and 3 of which had a silent
 * `.catch(() => {})` (per the build-right "No Silent Failures" rule, a
 * failed copy should tell the user, not vanish).
 *
 * This helper returns a Promise<boolean> (true on success) so the caller can
 * optionally show a confirmation toast. It catches all clipboard errors and
 * surfaces them via the optional onFailure callback (the caller wires that to
 * the toast system).
 *
 * Note: clipboard writes can fail when:
 *   - The page is served over http (not https) — clipboard requires secure context
 *   - The user denied the clipboard-permission prompt
 *   - The browser is older / doesn't implement the async clipboard API
 *   - The document doesn't have focus (rare)
 */
export async function copyToClipboard(
  text: string,
  onFailure?: (message: string) => void,
): Promise<boolean> {
  try {
    if (!navigator?.clipboard?.writeText) {
      const msg = "Clipboard not available in this browser. Select the text and press Ctrl+C.";
      onFailure?.(msg);
      return false;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    const msg = error instanceof Error && error.message
      ? `Couldn't copy: ${error.message}. Select the text and press Ctrl+C.`
      : "Couldn't copy to clipboard. Select the text and press Ctrl+C.";
    onFailure?.(msg);
    return false;
  }
}
