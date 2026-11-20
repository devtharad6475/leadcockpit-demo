/**
 * read-source.ts — read a source file for a golden that parses source TEXT.
 *
 * WHY THIS EXISTS (2026-09-05, session 52).
 *
 * `golden-lead-create-field-fidelity` went red with:
 *
 *     could not locate normalizeLead() in src/repositories/json/index.ts —
 *     this golden's source parse needs updating
 *
 * Nothing about `normalizeLead` had changed. The repository is checked out with
 * `core.autocrlf=true`, so git rewrites line endings to CRLF on the way OUT of
 * the object store and back to LF on the way IN. What that means in practice is
 * that a working-tree file's line endings depend on whether git last wrote it
 * (CRLF) or a tool did (LF) — and a `git stash` / `git stash pop`, or a fresh
 * clone on Windows, silently flips a file from one to the other.
 *
 * A golden whose regex spells `\{\n {2}return` therefore passes or fails
 * according to which of those happened most recently. That is a test that
 * reports on the developer's git history rather than on the product, and it
 * fails in the most misleading way available: by claiming the code it parses has
 * moved.
 *
 * Normalising here fixes the whole class in one place. It is a PARSING fix, not
 * a loosened assertion — every pattern still has to match exactly what it
 * matched before, on exactly the same text, minus a carriage return that was
 * never part of what the golden was asserting about.
 *
 * Use this instead of `readFileSync(path, "utf8")` in any golden that matches a
 * multi-line pattern against source. Byte-level checks (a golden asserting a
 * file's literal encoding, say) must keep using readFileSync — normalising
 * would erase the very thing they exist to check.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Read a repository file as text with line endings normalised to `\n`.
 *
 * @param path repo-relative (or absolute) path to the file.
 */
export function readSource(path: string): string {
  return readFileSync(resolve(path), "utf8").replace(/\r\n/g, "\n");
}
