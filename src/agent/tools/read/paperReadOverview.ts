import type { PdfTarget } from "./pdfToolUtils";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../../modules/contextPanel/paperAttribution";
import { stripMineruSourceImageEmbedsFromMarkdown } from "../../../modules/contextPanel/mineruCache";
import { joinLocalPath } from "../../../utils/localPath";
import type {
  ProjectedPaperMetadata,
  ZoteroMetadataResolver,
} from "../../../services/zoteroMetadata/types";
import { projectPaperMetadata } from "../../../services/zoteroMetadata/projections";
import { normalizeString, readTextFile } from "./paperReadShared";

export function selectMineruOverview(
  fullMd: string,
  maxChars: number,
): {
  text: string;
  sections: string[];
} {
  const clean = fullMd.trim();
  const sections: string[] = ["frontmatter"];
  const intro = clean.slice(
    0,
    Math.min(clean.length, Math.floor(maxChars * 0.6)),
  );
  const headingPattern =
    /^#{1,6}\s+.*\b(discussion|conclusion|conclusions|summary|general discussion)\b.*$/gim;
  const matches = Array.from(clean.matchAll(headingPattern));
  const tailStart = matches.length
    ? Math.max(0, matches[matches.length - 1].index || 0)
    : Math.max(0, clean.length - Math.floor(maxChars * 0.4));
  const tail = clean.slice(tailStart, tailStart + Math.floor(maxChars * 0.5));
  if (tailStart > 0) sections.push("discussion_or_conclusion");
  const combined =
    tail && !intro.includes(tail.slice(0, 200))
      ? `${intro}\n\n[Later overview section]\n${tail}`
      : intro;
  return {
    text: combined.slice(0, maxChars).trim(),
    sections,
  };
}

export async function tryReadMineruOverview(
  paperContext: NonNullable<PdfTarget["paperContext"]>,
  maxChars: number,
): Promise<unknown | null> {
  const cacheDir = normalizeString(paperContext.mineruCacheDir);
  if (!cacheDir) return null;
  try {
    const filePath = joinLocalPath(cacheDir, "full.md");
    const fullMd = stripMineruSourceImageEmbedsFromMarkdown(
      await readTextFile(filePath),
    );
    const selected = selectMineruOverview(fullMd, maxChars);
    return {
      backend: "mineru",
      filePath,
      text: selected.text,
      sections: selected.sections,
      citationLabel: formatPaperCitationLabel(paperContext),
      sourceLabel: formatPaperSourceLabel(paperContext),
      paperContext,
    };
  } catch (error) {
    return {
      backend: "mineru",
      ok: false,
      warning: `Could not read MinerU full.md: ${
        error instanceof Error ? error.message : String(error)
      }`,
      paperContext,
    };
  }
}

function normalizeMetadataValue(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function resolveMetadataOverviewTitle(
  metadata: ProjectedPaperMetadata,
): string {
  const bibliographicTitle = normalizeMetadataValue(metadata.title);
  if (bibliographicTitle) return bibliographicTitle;
  const contentSource = metadata.contentSource;
  const standaloneContentTitle =
    contentSource?.itemId === metadata.itemId &&
    contentSource.parentItemId === undefined
      ? normalizeMetadataValue(contentSource.title)
      : "";
  return standaloneContentTitle || `Paper ${metadata.itemId}`;
}

export const resolveMetadataOverviewTitleForTests =
  resolveMetadataOverviewTitle;

export function buildMetadataOverview(params: {
  paperContext: NonNullable<PdfTarget["paperContext"]>;
  metadataResolver: ZoteroMetadataResolver;
  warning?: string;
}): unknown | null {
  const metadata = projectPaperMetadata(
    params.metadataResolver.resolvePaperMetadata(params.paperContext),
    params.paperContext,
  );
  const title = resolveMetadataOverviewTitle(metadata);
  const authors = normalizeMetadataValue(metadata.creatorDisplay);
  const abstract = normalizeMetadataValue(metadata.abstract);
  const lines = [
    `Title: ${title}`,
    authors ? `Authors: ${authors}` : "",
    metadata.publicationDate ? `Date: ${metadata.publicationDate}` : "",
    metadata.year ? `Year: ${metadata.year}` : "",
    metadata.containerTitle
      ? `Container: ${metadata.containerTitle} (Zotero field: ${metadata.containerSourceField})`
      : "",
    metadata.eventTitle
      ? `Event: ${metadata.eventTitle} (Zotero field: ${metadata.eventSourceField})`
      : "",
    metadata.doi ? `DOI: ${metadata.doi}` : "",
    abstract ? `Abstract: ${abstract}` : "",
  ].filter(Boolean);
  if (!lines.length) return null;
  const warningText = params.warning || "";
  const contentStatus = /no\s+pdf\s+attachment/i.test(warningText)
    ? "no_pdf_attachment"
    : "no_extractable_pdf_text";
  return {
    backend: "zotero_metadata",
    sourceKind: "zotero_metadata",
    contentStatus,
    warning:
      params.warning ||
      "No extractable PDF text was available; using Zotero metadata and abstract.",
    text: lines.join("\n"),
    citationLabel: formatPaperCitationLabel(params.paperContext),
    sourceLabel: formatPaperSourceLabel(params.paperContext),
    paperContext: params.paperContext,
  };
}
