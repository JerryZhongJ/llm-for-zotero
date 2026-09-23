/**
 * Outline-backed section index for plain PDFs.
 *
 * Zotero's reader sidebar shows the PDF's built-in outline (the TOC the
 * document itself carries), but the plain-PDF pipeline only labels chunks
 * with nine canonical headings matched from chunk text — real section names
 * ("2 Motivating Example") never surface there. When the paper is open in a
 * reader tab, the live pdf.js document exposes the same outline the user
 * sees; resolving each outline destination to a page and locating the
 * heading line inside that page's text yields a real sectionIndex, so
 * paper_read({sections}) matches actual document structure.
 */

import type { PaperSectionIndexEntry } from "./types";
import { getPdfViewerApplication } from "./livePdfSelectionLocator";

export type OutlineHeading = {
  title: string;
  pageIndex: number;
};

// Mirrors sectionMatcher.normalizeSectionName (agent layer): numbering is
// stripped on both sides so "1 Introduction" matches a requested
// "Introduction" and heading lines like "1 INTRODUCTION" match the outline
// title "1 Introduction".
function normalizeOutlineHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\s*\d+(?:\.\d+)*\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function pageStartOffsets(pageChars: number[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const charCount of pageChars) {
    offsets.push(offset);
    offset += charCount;
  }
  return offsets;
}

// Locate the heading line inside its page's slice of the source text.
// Returns the absolute char offset, or undefined when no line matches.
function findHeadingOffset(
  sourceText: string,
  pageStart: number,
  pageEnd: number,
  title: string,
): number | undefined {
  const target = normalizeOutlineHeading(title);
  if (!target) return undefined;
  const pageText = sourceText.slice(pageStart, pageEnd);
  const lines = pageText.split("\n");
  let cursor = 0;
  for (const line of lines) {
    const normalized = normalizeOutlineHeading(line);
    if (
      normalized === target ||
      (target.length >= 4 && normalized.startsWith(`${target} `))
    ) {
      return pageStart + cursor;
    }
    cursor += line.length + 1;
  }
  return undefined;
}

/**
 * Build a section index from resolved outline headings. Pure: the caller
 * supplies the extracted source text, its per-page char counts (as produced
 * by Zotero.PDFWorker.getFullText), and outline entries whose destinations
 * were already resolved to page indexes. Headings that cannot be placed at
 * a strictly increasing offset are dropped rather than producing empty or
 * inverted slices.
 */
export function buildOutlineSectionIndex(
  sourceText: string,
  pageChars: number[],
  outline: OutlineHeading[],
): PaperSectionIndexEntry[] {
  if (!sourceText || !pageChars.length || !outline.length) return [];
  const offsets = pageStartOffsets(pageChars);
  const placed: Array<OutlineHeading & { charStart: number }> = [];
  for (const entry of outline) {
    const title = (entry.title || "").trim();
    if (!title || !Number.isInteger(entry.pageIndex)) continue;
    if (entry.pageIndex < 0 || entry.pageIndex >= pageChars.length) continue;
    const pageStart = offsets[entry.pageIndex];
    const pageEnd = Math.min(
      sourceText.length,
      pageStart + pageChars[entry.pageIndex],
    );
    const charStart =
      findHeadingOffset(sourceText, pageStart, pageEnd, title) ?? pageStart;
    const previous = placed[placed.length - 1];
    if (previous && charStart <= previous.charStart) continue;
    placed.push({ ...entry, title, charStart });
  }
  return placed.map((entry, index) => ({
    heading: entry.title,
    charStart: entry.charStart,
    charEnd:
      index + 1 < placed.length
        ? placed[index + 1].charStart
        : sourceText.length,
    page: entry.pageIndex + 1,
  }));
}

// ── Live-reader outline collection ─────────────────────────────────────────

type PdfDocumentLike = {
  getOutline?: () => Promise<Array<{
    title?: unknown;
    dest?: unknown;
    items?: unknown[];
  } | null> | null>;
  getDestination?: (name: unknown) => Promise<unknown> | unknown;
  getPageIndex?: (ref: unknown) => Promise<number> | number;
};

async function resolveOutlinePageIndex(
  pdfDocument: PdfDocumentLike,
  dest: unknown,
): Promise<number | null> {
  try {
    let resolved = dest;
    if (typeof resolved === "string") {
      resolved = await pdfDocument.getDestination?.(resolved);
    }
    if (!Array.isArray(resolved)) return null;
    const ref = resolved[0];
    if (!ref || typeof pdfDocument.getPageIndex !== "function") return null;
    const pageIndex = await pdfDocument.getPageIndex(ref);
    return Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex : null;
  } catch {
    return null;
  }
}

type OutlineItemLike = {
  title?: unknown;
  dest?: unknown;
  items?: unknown[];
};

function flattenOutlineItems(items: unknown): OutlineItemLike[] {
  if (!Array.isArray(items)) return [];
  const flat: OutlineItemLike[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as OutlineItemLike;
    flat.push(record);
    flat.push(...flattenOutlineItems(record.items));
  }
  return flat;
}

/**
 * Read the PDF outline from a reader tab that currently shows the given
 * attachment. Returns null when no live reader (or no outline) is
 * available — the caller keeps its existing fallback.
 */
export async function collectReaderPdfOutline(
  attachmentID: number,
): Promise<OutlineHeading[] | null> {
  const readerAPI = (globalThis as any).Zotero?.Reader as
    | { _readers?: any[] }
    | undefined;
  const readers = readerAPI?._readers || [];
  const reader = readers.find(
    (candidate) =>
      Number(candidate?.itemID) === attachmentID ||
      Number(candidate?._item?.id) === attachmentID,
  );
  if (!reader) return null;
  const app = getPdfViewerApplication(reader);
  const pdfDocument = app?.pdfDocument as PdfDocumentLike | undefined;
  if (!pdfDocument || typeof pdfDocument.getOutline !== "function") return null;
  const outlineItems = await pdfDocument.getOutline();
  const flat = flattenOutlineItems(outlineItems || []);
  const headings: OutlineHeading[] = [];
  for (const item of flat) {
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title || !item.dest) continue;
    const pageIndex = await resolveOutlinePageIndex(pdfDocument, item.dest);
    if (pageIndex !== null) headings.push({ title, pageIndex });
  }
  return headings.length ? headings : null;
}
