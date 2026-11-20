/**
 * pdf-text.ts — what counts as readable text in a PDF (K4, 2026-09-27).
 *
 * pdf-parse writes a marker line such as "-- 1 of 3 --" between pages, even
 * when a page has no text layer at all. A phone-scanned rate card therefore
 * came back as "\n\n-- 1 of 3 --\n\n-- 2 of 3 --..." — not blank, so the upload
 * was marked "extracted", the owner never saw the "this looks scanned" message,
 * and the marker lines were sent to the AI as the document.
 *
 * The markers are removed, and a PDF whose pages average fewer than
 * MIN_READABLE_CHARS_PER_PAGE letters or digits is treated as having no text:
 * a scan often carries a stray page number or a watermark word, which is not a
 * document anyone can learn from.
 */

export const MIN_READABLE_CHARS_PER_PAGE = 10;

const PAGE_MARKER = /^[ \t]*--[ \t]*\d+[ \t]+of[ \t]+\d+[ \t]*--[ \t]*$/gim;

/** Removes pdf-parse's "-- N of M --" page separator lines. */
export function stripPdfPageMarkers(text: string): string {
  return (text || "").replace(PAGE_MARKER, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Letters and digits in any script — the characters a reader can learn from. */
export function readableCharCount(text: string): number {
  return ((text || "").match(/[\p{L}\p{N}]/gu) || []).length;
}

/**
 * The PDF's text with page markers removed, or "" when there is too little real
 * text to be a readable document (a scanned PDF).
 */
export function readablePdfText(rawText: string, pageCount?: number): string {
  const text = stripPdfPageMarkers(rawText);
  const pages = Math.max(1, pageCount || countPdfPageMarkers(rawText) || 1);
  return readableCharCount(text) < MIN_READABLE_CHARS_PER_PAGE * pages ? "" : text;
}

/**
 * Reads a PDF's text layer and returns only readable text ("" for a scan).
 * Moved here from the upload route so the rule is testable on a real PDF.
 */
export async function extractPdfText(buffer: Buffer | Uint8Array): Promise<string> {
  const [{ PDFParse }, path, { pathToFileURL }] = await Promise.all([import("pdf-parse"), import("node:path"), import("node:url")]);
  const workerPath = path.join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs");
  PDFParse.setWorker(pathToFileURL(workerPath).href);
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const pageCount = typeof result.total === "number" ? result.total : undefined;
    const ordinary = readablePdfText(result.text || "", pageCount);
    // Generated documents retain exact logical text as tagged ActualText. The
    // ordinary PDF.js text layer returns visual glyph order for Indic scripts.
    // Use tagged text only when every visible item on every page is covered.
    const logical = ordinary ? await fullyCoveredLogicalPdfText(buffer, pathToFileURL(workerPath).href).catch(() => undefined) : undefined;
    return logical === undefined ? ordinary : readablePdfText(logical, pageCount);
  } finally {
    await parser.destroy();
  }
}

async function fullyCoveredLogicalPdfText(buffer: Buffer | Uint8Array, workerUrl: string): Promise<string | undefined> {
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = workerUrl;
  const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, isEvalSupported: false });
  const document = await loading.promise;
  try {
    const logicalPages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const tree = await page.getStructTree();
      if (!tree) return undefined;
      const lines: { text: string; ids: string[] }[] = [];
      function contentIds(node: unknown): string[] {
        if (!node || typeof node !== "object") return [];
        const value = node as { type?: string; id?: string; children?: unknown[] };
        return value.type === "content" && typeof value.id === "string" ? [value.id] : (value.children || []).flatMap(contentIds);
      }
      function visit(node: unknown) {
        if (!node || typeof node !== "object") return;
        const value = node as { role?: string; alt?: string; children?: unknown[] };
        if ((value.role === "P" || value.role === "H") && typeof value.alt === "string" && value.alt.trim()) {
          const ids = contentIds(node);
          if (ids.length) lines.push({ text: value.alt, ids });
        } else for (const child of value.children || []) visit(child);
      }
      visit(tree);
      if (!lines.length) return undefined;
      const allowedIds = new Set(lines.flatMap((line) => line.ids));
      const seenIds = new Set<string>();
      const markingStack: (string | null)[] = [];
      const content = await page.getTextContent({ includeMarkedContent: true });
      for (const item of content.items) {
        if ("type" in item) {
          if (item.type === "endMarkedContent") markingStack.pop();
          else markingStack.push("id" in item && typeof item.id === "string" ? item.id : null);
        } else if (item.str.trim()) {
          const covering = markingStack.find((id) => id !== null && allowedIds.has(id));
          if (!covering) return undefined;
          seenIds.add(covering);
        }
      }
      // Do not replace a complete transcript with an incomplete tag tree.
      if (lines.some((line) => !line.ids.some((id) => seenIds.has(id)))) return undefined;
      logicalPages.push(lines.map((line) => line.text).join("\n"));
    }
    return logicalPages.join("\n\n");
  } catch {
    // Optional accessibility data must not break normal third-party PDFs.
    return undefined;
  } finally { await document.destroy(); }
}

function countPdfPageMarkers(text: string): number {
  return ((text || "").match(PAGE_MARKER) || []).length;
}
