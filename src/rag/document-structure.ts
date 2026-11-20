/**
 * document-structure.ts — turn extracted document text into chunks that keep
 * their meaning (2026-09-17, session 56).
 *
 * WHY THIS EXISTS
 * ---------------
 * Three separate chunkers cut every document into ~900-character pieces at
 * paragraph or sentence breaks, and none of them knew what a table or a section
 * was. Two things went wrong because of that, both measured on real uploads:
 *
 * 1. TABLES LOST THEIR HEADINGS. pdf-parse emits a table as tab-separated lines
 *    with the column names on the first line only:
 *
 *        Article \t 50-199 kg \t 200-499 kg \t 500 kg and above
 *        Neem Zari \t Rs 295 / kg \t Rs 285 / kg \t Rs 272 / kg
 *
 *    A chunk boundary between those two lines leaves "Neem Zari Rs 295 Rs 285
 *    Rs 272" with nothing saying which price belongs to which quantity. Prices,
 *    MOQs and delivery times — the facts a customer asks about most — live in
 *    tables, so this is the costliest place to lose context.
 *
 * 2. SECTIONS WERE IGNORED. A chunk could start half-way through "Returns" and
 *    end half-way through "Cancellation", and nothing in it said which policy a
 *    sentence belonged to.
 *
 * WHAT IT DOES
 * ------------
 * `serializeTables` rewrites every table row as one self-contained sentence
 * that carries its own column names:
 *
 *     Neem Zari — 50-199 kg: Rs 295 / kg; 200-499 kg: Rs 285 / kg; ...
 *
 * `chunkByStructure` splits at headings, keeps each section together where it
 * fits, never cuts a line in half unless one line alone is too long, and starts
 * every chunk with the heading it came from.
 *
 * WHY NOT "SEMANTIC" CHUNKING (split where the embedding of adjacent sentences
 * diverges)? It needs an embedding call per sentence at upload, which costs
 * money and needs a provider this deployment may not have. For business
 * documents the author already marked where the meaning changes — the headings
 * — so splitting there gets most of the benefit for nothing.
 *
 * Pure functions, no I/O: safe to call from the browser, the server and tests.
 */

/** A chunk never grows past this unless a single line alone is longer. */
export const STRUCTURED_CHUNK_MAX_CHARS = 1200;

/** Lines the PDF renderer adds to every page, which are not document content. */
const PAGE_MARKER = /^--\s*\d+\s+of\s+\d+\s*--$/i;
const PAGE_FOOTER_TAIL = /\tPage\s+\d+\s+of\s+\d+\s*$/i;

const MARKDOWN_HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
/**
 * "1. Company overview", "2.3 Returns" — short, and not a sentence. The number
 * is one or two digits and must carry a dot, so a wrapped PDF line such as
 * "500 Kg MOQ" or a year ("2008. The business…") is not mistaken for a heading.
 */
const NUMBERED_HEADING = /^(?:\d{1,2}\.(?:\d{1,2}\.?)*)\s+([A-Z][^.!?]{1,78})$/;
const PIPE_ROW = /^\s*\|.*\|\s*$/;
const PIPE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cellsOfTabLine(line: string): string[] {
  return line.split("\t").map((cell) => cell.trim());
}

function cellsOfPipeLine(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTabRow(line: string): boolean {
  return line.includes("\t") && cellsOfTabLine(line).filter(Boolean).length >= 2;
}

/**
 * Serialise one table. Two-column tables are almost always key/value lists
 * ("Registered name | Om Jari"), where the column names add nothing, so they
 * become "key: value". Wider tables name every column after the first.
 */
function serializeRows(header: string[], rows: string[][]): string[] {
  const out: string[] = [];
  const width = header.length;
  if (width >= 3) out.push(`Table columns: ${header.join(" | ")}.`);
  for (const row of rows) {
    const cells = row.slice();
    // A row with more cells than the header folds the extras into the last one
    // rather than dropping them.
    if (cells.length > width) cells.splice(width - 1, cells.length - width + 1, cells.slice(width - 1).join(" "));
    const first = cells[0] || "";
    if (width <= 2) {
      const value = cells.slice(1).join(" ").trim();
      if (first || value) out.push(value ? `${first}: ${value}` : first);
      continue;
    }
    const pairs = cells
      .slice(1)
      .map((cell, index) => (cell ? `${header[index + 1] || `Column ${index + 2}`}: ${cell}` : ""))
      .filter(Boolean);
    const label = first ? `${first}` : header[0] || "Row";
    out.push(pairs.length ? `${label} — ${pairs.join("; ")}.` : `${label}.`);
  }
  return out;
}

/**
 * Rewrite tab-separated (PDF) and pipe (Markdown / DOCX-to-text) tables as one
 * sentence per row. Everything that is not a table is returned unchanged,
 * except the page markers and footers a PDF renderer stamps on every page.
 *
 * Wrapped cells: pdf-parse puts the overflow of a long cell on its own line
 * with no tab. A non-tab line INSIDE a table (a later line in the same block is
 * a tab row again) is treated as that overflow and appended to the previous
 * row, so its text is never dropped. A wrapped last row has nothing after it to
 * prove it belongs to the table and stays as ordinary text right below it —
 * adjacent, so it still lands in the same section chunk.
 */
export function serializeTables(text: string): string {
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    // A line ending in "<tab>Page N of M" is the page footer as a whole — its
    // left half is the footer's own caption, not document content.
    .filter((line) => !PAGE_MARKER.test(line.trim()) && !PAGE_FOOTER_TAIL.test(line));
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ── Markdown pipe table ────────────────────────────────────────────────
    if (PIPE_ROW.test(line) && i + 1 < lines.length && PIPE_SEPARATOR.test(lines[i + 1])) {
      const header = cellsOfPipeLine(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && PIPE_ROW.test(lines[j])) {
        if (!PIPE_SEPARATOR.test(lines[j])) rows.push(cellsOfPipeLine(lines[j]));
        j += 1;
      }
      out.push(...serializeRows(header, rows));
      i = j;
      continue;
    }

    // ── Tab-separated table (pdf-parse) ───────────────────────────────────
    if (isTabRow(line)) {
      // A table needs a header AND at least one more tab row soon after it.
      // A lone tab line (a masthead, a footer) is not a table.
      const nextTab = lines.slice(i + 1, i + 5).findIndex(isTabRow);
      if (nextTab >= 0) {
        const header = cellsOfTabLine(line);
        const rows: string[][] = [];
        let j = i + 1;
        while (j < lines.length) {
          if (isTabRow(lines[j])) {
            rows.push(cellsOfTabLine(lines[j]));
            j += 1;
            continue;
          }
          const current = lines[j].trim();
          if (
            !current
            || MARKDOWN_HEADING.test(current)
            || NUMBERED_HEADING.test(current)
            || SOURCE_LINE.test(current)
            || RULE_LINE.test(current)
          ) break;
          // Overflow only if the table resumes within the next few lines.
          const resumes = lines.slice(j + 1, j + 4).some(isTabRow);
          if (!resumes) break;
          if (rows.length) {
            const last = rows[rows.length - 1];
            last[last.length - 1] = `${last[last.length - 1]} ${current}`.trim();
          } else {
            header[header.length - 1] = `${header[header.length - 1]} ${current}`.trim();
          }
          j += 1;
        }
        out.push(...serializeRows(header, rows));
        i = j;
        continue;
      }
      // Not a table: keep the text, drop the tabs.
      out.push(cellsOfTabLine(line).filter(Boolean).join(" "));
      i += 1;
      continue;
    }

    out.push(line);
    i += 1;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

type Section = { source: string; heading: string; lines: string[] };

/**
 * The markers the pipeline puts between documents when it joins them:
 * "[Source: File - x.pdf]" (KnowledgeSourceBundleService.buildCombinedSourceText)
 * and "Source file: x.pdf" (the upload route). Without honouring them, a file
 * with no headings of its own was silently filed under the LAST heading of the
 * file before it — measured on the Meghdoot fixture, where a sales notepad was
 * labelled "Section: Below-minimum enquiries" from the pricing policy.
 */
const SOURCE_LINE = /^(?:\[Source:\s*(.+?)\]|Source file:\s*(.+))$/;
/** A horizontal rule ("---") is a topic break: the previous heading stops applying. */
const RULE_LINE = /^(?:-{3,}|\*{3,}|_{3,})$/;

function headingOf(line: string): string | null {
  const trimmed = line.trim();
  const markdown = MARKDOWN_HEADING.exec(trimmed);
  if (markdown) return markdown[1].trim();
  if (trimmed.length <= 80 && NUMBERED_HEADING.test(trimmed)) return trimmed;
  return null;
}

function splitLongLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const sentences = line.split(/(?<=[.!?])\s+/);
  const parts: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && (current + " " + sentence).length > maxChars) {
      parts.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) parts.push(current);
  // A single sentence longer than the limit is cut hard; nothing else can be done.
  return parts.flatMap((part) => {
    if (part.length <= maxChars) return [part];
    const pieces: string[] = [];
    for (let k = 0; k < part.length; k += maxChars) pieces.push(part.slice(k, k + maxChars));
    return pieces;
  });
}

/**
 * Split text into chunks that follow the document's own sections.
 *
 * Every chunk that belongs to a section starts with "Section: <heading>", so a
 * chunk read on its own still says what it is about —
 * which is also what makes a keyword or vector search find it. Tables are
 * serialised first, so a row is one line and is never cut in half.
 */
export function chunkByStructure(text: string, maxChars = STRUCTURED_CHUNK_MAX_CHARS): string[] {
  const limit = Math.max(200, maxChars);
  const serialized = serializeTables(text);
  if (!serialized) return [];

  const sections: Section[] = [{ source: "", heading: "", lines: [] }];
  for (const rawLine of serialized.split("\n")) {
    const line = rawLine.trim();
    const current = sections[sections.length - 1];
    const source = SOURCE_LINE.exec(line);
    if (source) {
      sections.push({ source: (source[1] || source[2] || "").trim(), heading: "", lines: [] });
      continue;
    }
    if (RULE_LINE.test(line)) {
      sections.push({ source: current.source, heading: "", lines: [] });
      continue;
    }
    const heading = headingOf(rawLine);
    if (heading) {
      sections.push({ source: current.source, heading, lines: [] });
      continue;
    }
    if (!line) continue;
    current.lines.push(line);
  }

  const chunks: string[] = [];
  for (const section of sections) {
    if (!section.lines.length) {
      // A heading with no body still carries information ("7. Customisation"
      // followed directly by the next heading) only in context; skip it.
      continue;
    }
    const label = [
      section.source ? `Source: ${section.source}` : "",
      section.heading ? `Section: ${section.heading}` : "",
    ].filter(Boolean);
    const prefix = label.length ? `${label.join("\n")}\n` : "";
    const room = limit - prefix.length;
    let current = "";
    for (const line of section.lines.flatMap((item) => splitLongLine(item, room))) {
      if (current && (current + "\n" + line).length > room) {
        chunks.push(prefix + current);
        current = line;
      } else {
        current = current ? `${current}\n${line}` : line;
      }
    }
    if (current) chunks.push(prefix + current);
  }
  return chunks;
}
