/** Shared, measured document layout. Fonts are bundled with their OFL license. */
import PDFDocument from "pdfkit";
import { create, type Font } from "fontkit";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NeedsActionError } from "@/lib/user-errors";

const pageWidth = 595.28;
const pageHeight = 841.89;
const margin = 48;
const contentWidth = pageWidth - margin * 2;
const families = ["NotoSans", "NotoSansDevanagari", "NotoSansGujarati"];
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
type EmbeddedFont = { name: string; bytes: Buffer; font: Font };
type Run = { text: string; font: EmbeddedFont };
type PreparedLine = { text: string; size: number; bold: boolean; heading: boolean };
const fontCache = new Map<string, EmbeddedFont>();

function fontsFor(bold: boolean): EmbeddedFont[] {
  return families.map((family) => {
    const name = `${family}-${bold ? "Bold" : "Regular"}`;
    let result = fontCache.get(name);
    if (!result) {
      const bytes = readFileSync(path.join(process.cwd(), "public", "fonts", "pdf", `${name}.ttf`));
      result = { name, bytes, font: create(bytes) as Font };
      fontCache.set(name, result);
    }
    return result;
  });
}

function runsFor(text: string, bold: boolean): Run[] {
  const fonts = fontsFor(bold);
  const runs: Run[] = [];
  for (const { segment } of segmenter.segment(text)) {
    const codePoints = Array.from(segment).map((character) => character.codePointAt(0)!);
    // Joiners participate in Indic shaping but need not have a visible glyph.
    const selected = fonts.find(({ font }) => codePoints.every((codePoint) =>
      codePoint === 0x200c || codePoint === 0x200d || font.hasGlyphForCodePoint(codePoint)));
    if (!selected) {
      throw new NeedsActionError("This PDF contains text in a language or a symbol that is not supported yet. Your saved information is unchanged.", 400);
    }
    const previous = runs.at(-1);
    if (previous?.font.name === selected.name) previous.text += segment;
    else runs.push({ text: segment, font: selected });
  }
  return runs;
}

function measure(text: string, bold: boolean, size: number): number {
  return runsFor(text, bold).reduce((width, run) =>
    width + run.font.font.layout(run.text).advanceWidth * size / run.font.font.unitsPerEm, 0);
}

/** Preserve words where possible; split oversized words only at grapheme boundaries. */
function wrap(text: string, bold: boolean, size: number): string[] {
  if (!text) return [""];
  const output: string[] = [];
  let current = "";
  for (const token of text.match(/\S+|\s+/gu) || []) {
    if (measure(current + token, bold, size) <= contentWidth) { current += token; continue; }
    if (current.trim()) { output.push(current.trimEnd()); current = ""; }
    if (!token.trim()) continue;
    if (measure(token, bold, size) <= contentWidth) { current = token; continue; }
    for (const { segment } of segmenter.segment(token)) {
      if (measure(current + segment, bold, size) > contentWidth) {
        if (!current) throw new NeedsActionError("A character in this document is too wide to fit on the page. Your saved information is unchanged.", 400);
        output.push(current); current = "";
      }
      current += segment;
    }
  }
  if (current.trim() || !output.length) output.push(current.trimEnd());
  return output;
}

export async function buildPdfFromLines(lines: string[]): Promise<Buffer> {
  const prepared: PreparedLine[] = [];
  for (const raw of lines.length ? lines : ["# Document"]) {
    const title = raw.startsWith("# ");
    const heading = title || raw.startsWith("## ");
    const size = title ? 18 : heading ? 15 : 11;
    for (const paragraph of sanitizePdfText(raw.replace(/^##?\s*/, "")).split("\n")) {
      runsFor(paragraph, heading);
      for (const text of wrap(paragraph, heading, size)) prepared.push({ text, size, bold: heading, heading });
    }
  }
  const doc = new PDFDocument({ size: [pageWidth, pageHeight], margin, pdfVersion: "1.4", autoFirstPage: true, tagged: true });
  const chunks: Buffer[] = [];
  const buffer = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  try {
    for (const font of [...fontsFor(false), ...fontsFor(true)]) doc.registerFont(font.name, font.bytes);
    let y = margin;
    for (const line of prepared) {
      const runs = runsFor(line.text, line.bold);
      const metrics = runs.length ? runs.map((run) => run.font.font) : [fontsFor(line.bold)[0].font];
      const ascent = Math.max(...metrics.map((font) => font.ascent / font.unitsPerEm)) * line.size;
      const descent = Math.max(...metrics.map((font) => -font.descent / font.unitsPerEm)) * line.size;
      const height = ascent + descent + 4;
      const keepWithNext = line.heading ? height + 20 : height;
      if (y + keepWithNext > pageHeight - margin && y > margin) { doc.addPage(); y = margin; }
      let x = margin;
      const structureContent = line.text ? doc.markStructureContent(line.heading ? "H" : "P", { actual: line.text }) : null;
      for (const run of runs) {
        doc.font(run.font.name).fontSize(line.size).fillColor(line.heading ? "#163354" : "#202A35");
        // Glyph order differs from logical text for Indic vowels and ligatures.
        // ActualText retains the exact original run for accessible copy/search.
        doc.markContent("Span", { actual: run.text });
        doc.text(run.text, x, y + ascent, { lineBreak: false, baseline: "alphabetic" });
        doc.endMarkedContent();
        x += doc.widthOfString(run.text);
      }
      if (structureContent) {
        doc.endMarkedContent();
        doc.addStructure(doc.struct(line.heading ? "H" : "P", { actual: line.text }, structureContent));
      }
      y += height;
    }
    doc.end();
  } catch (error) {
    doc.destroy(error instanceof Error ? error : new Error(String(error)));
  }
  return buffer;
}

/** Keep Unicode intact; remove non-printing ASCII controls and normalize whitespace. */
export function sanitizePdfText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").normalize("NFC");
}

export function safeFilePart(value: string, fallback = "document"): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || fallback;
}
