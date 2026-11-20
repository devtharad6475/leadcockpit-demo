import path from "node:path";
import { pathToFileURL } from "node:url";

/** Read actual PDF objects/text positions, not implementation-specific encoded bytes. */
export async function inspectPdf(buffer: Buffer) {
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs")).href;
  const document = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, isEvalSupported: false }).promise;
  try {
    const pages = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      const items = content.items.flatMap((item) => "str" in item ? [{ text: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height }] : []);
      const tree = await page.getStructTree();
      const accessibleLines: string[] = [];
      function visit(node: unknown) {
        if (!node || typeof node !== "object") return;
        const entry = node as { role?: string; alt?: string; children?: unknown[] };
        if ((entry.role === "P" || entry.role === "H") && typeof entry.alt === "string") accessibleLines.push(entry.alt);
        else for (const child of entry.children || []) visit(child);
      }
      visit(tree);
      pages.push({ text: items.map((item) => item.text).join(" "), accessibleText: accessibleLines.join(" "), items });
    }
    return { pages, text: pages.map((page) => page.text).join("\n").replace(/\s+/gu, " ").trim(), accessibleText: pages.map((page) => page.accessibleText).join("\n").replace(/\s+/gu, " ").trim() };
  } finally { await document.destroy(); }
}
