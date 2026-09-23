import type { QuoteCitation } from "../../../shared/types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../../modules/contextPanel/paperAttribution";
import {
  buildQuoteCitation,
  mergeQuoteCitations,
} from "../../../modules/contextPanel/quoteCitations";
import { normalizePositiveInt, validateObject } from "../shared";
import type { PdfTarget } from "./pdfToolUtils";

const MAX_OVERVIEW_QUOTES_PER_RESULT = 3;
const MIN_OVERVIEW_QUOTE_CHARS = 40;
const MAX_OVERVIEW_QUOTE_CHARS = 360;

export function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map((entry) => normalizeString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return entries.length ? Array.from(new Set(entries)) : undefined;
}

export function dedupePaperContexts(
  paperContexts: NonNullable<PdfTarget["paperContext"]>[],
): NonNullable<PdfTarget["paperContext"]>[] {
  const seen = new Set<string>();
  return paperContexts.filter((paperContext) => {
    const key = `${paperContext.libraryID || 0}:${paperContext.itemId}:${paperContext.contextItemId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function readTextFile(filePath: string): Promise<string> {
  const IOUtils = (globalThis as any).IOUtils;
  if (IOUtils?.read) {
    return IOUtils.read(filePath).then((data: Uint8Array | ArrayBuffer) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      return new TextDecoder().decode(bytes);
    });
  }
  const OS = (globalThis as any).OS;
  if (OS?.File?.read) {
    return OS.File.read(filePath).then((data: Uint8Array | ArrayBuffer) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      return new TextDecoder().decode(bytes);
    });
  }
  throw new Error("No file reader is available for MinerU markdown");
}

export function paperContextKey(
  paperContext: NonNullable<PdfTarget["paperContext"]>,
): string {
  return `${paperContext.itemId}:${paperContext.contextItemId}`;
}

export function buildTargetedPaperGroups(
  targets: NonNullable<PdfTarget["paperContext"]>[],
  results: Array<Record<string, unknown>>,
  quoteCitationCollector?: QuoteCitation[],
): Array<Record<string, unknown>> {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const result of results) {
    const paperContext = validateObject<Record<string, unknown>>(
      result.paperContext,
    )
      ? result.paperContext
      : undefined;
    const itemId = normalizePositiveInt(paperContext?.itemId);
    const contextItemId = normalizePositiveInt(paperContext?.contextItemId);
    if (!itemId || !contextItemId) continue;
    const key = `${itemId}:${contextItemId}`;
    const passage: Record<string, unknown> = {
      text: normalizeString(result.text) || "",
      sourceLabel: normalizeString(result.sourceLabel),
      citationLabel: normalizeString(result.citationLabel),
    };
    const chunkIndex = Number(result.chunkIndex);
    if (Number.isFinite(chunkIndex))
      passage.chunkIndex = Math.floor(chunkIndex);
    const score = Number(result.score);
    if (Number.isFinite(score)) passage.score = score;
    const sectionLabel = normalizeString(result.sectionLabel);
    if (sectionLabel) passage.sectionLabel = sectionLabel;
    const chunkKind = normalizeString(result.chunkKind);
    if (chunkKind) passage.chunkKind = chunkKind;
    const pageIndex = Number(result.pageIndex);
    if (Number.isFinite(pageIndex) && pageIndex >= 0) {
      passage.pageIndex = Math.floor(pageIndex);
    }
    const pageLabel = normalizeString(result.pageLabel);
    if (pageLabel) passage.pageLabel = pageLabel;
    for (const field of [
      "sourceStart",
      "sourceEnd",
      "pageStart",
      "pageEnd",
    ] as const) {
      const value = Number(result[field]);
      if (Number.isFinite(value) && value >= 0) {
        passage[field] = Math.floor(value);
      }
    }
    const sourceFingerprint = normalizeString(result.sourceFingerprint);
    if (sourceFingerprint) passage.sourceFingerprint = sourceFingerprint;
    const quoteCitations = buildQuoteCitationsFromResult(result);
    quoteCitationCollector?.push(...quoteCitations);
    if (quoteCitations.length) {
      if (quoteCitations.length === 1) {
        passage.quoteCitationId = quoteCitations[0].id;
      }
      passage.quoteCitationIds = quoteCitations.map((citation) => citation.id);
      passage.quoteAnchors = quoteCitations.map(
        (citation) => `[[quote:${citation.id}]]`,
      );
    }
    const entries = groups.get(key) || [];
    entries.push(passage);
    groups.set(key, entries);
  }

  return targets.map((paperContext) => {
    const passages = groups.get(paperContextKey(paperContext)) || [];
    return {
      paperContext,
      status: passages.length ? "matched" : "no_matches",
      sourceKind: "paper_text",
      citationLabel: formatPaperCitationLabel(paperContext),
      sourceLabel: formatPaperSourceLabel(paperContext),
      passages,
    };
  });
}

export function buildQuoteCitationFromResult(
  result: Record<string, unknown>,
  quoteText?: string,
): ReturnType<typeof buildQuoteCitation> {
  const paperContext = validateObject<Record<string, unknown>>(
    result.paperContext,
  )
    ? result.paperContext
    : undefined;
  const itemId = Number(paperContext?.itemId);
  const contextItemId = Number(paperContext?.contextItemId);
  if (
    !Number.isFinite(itemId) ||
    itemId <= 0 ||
    !Number.isFinite(contextItemId) ||
    contextItemId <= 0
  ) {
    return undefined;
  }
  const explicitPageIndex = Number(result.pageIndex);
  const pageStart = Number(result.pageStart);
  const pageEnd = Number(result.pageEnd);
  const pageHintIndex =
    Number.isFinite(explicitPageIndex) && explicitPageIndex >= 0
      ? Math.floor(explicitPageIndex)
      : Number.isFinite(pageStart) &&
          Number.isFinite(pageEnd) &&
          pageStart >= 0 &&
          pageStart === pageEnd
        ? Math.floor(pageStart)
        : undefined;
  const exactQuoteText = normalizeString(quoteText) || "";
  if (!exactQuoteText) return undefined;
  return buildQuoteCitation({
    quoteText: exactQuoteText,
    sourceMatchText: exactQuoteText,
    sourceMatchKind: "exact",
    sourceMatchSource:
      pageHintIndex === undefined ? "context-text" : "pdf-page-text",
    citationLabel:
      normalizeString(result.sourceLabel) ||
      normalizeString(result.citationLabel),
    sourceSectionLabel: result.sectionLabel,
    sourceChunkKind: result.chunkKind,
    contextItemId,
    itemId,
    sourceFingerprint: result.sourceFingerprint,
    pageHintIndex,
    pageHintLabel: result.pageLabel,
    allowShortQuoteText: true,
  });
}

export function buildQuoteCitationsFromResult(
  result: Record<string, unknown>,
): QuoteCitation[] {
  const resultText = normalizeString(result.text) || "";
  const candidates = splitOverviewQuoteCandidates(resultText);
  const quoteTexts = candidates.length ? candidates : [resultText];
  return quoteTexts
    .map((quoteText) => buildQuoteCitationFromResult(result, quoteText))
    .filter((entry): entry is QuoteCitation => Boolean(entry));
}

export function splitOverviewQuoteCandidates(text: string): string[] {
  const withoutChunkMarkers = text.replace(/^\s*\[chunk\s+\d+\]\s*$/gim, "");
  const blocks = withoutChunkMarkers
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.replace(/^#{1,6}\s+/, "").trim())
        .filter(Boolean)
        .join(" "),
    )
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const sentences = block.match(/[^.!?。！？]+[.!?。！？]+(?=\s|$)/g) || [
      block,
    ];
    let candidate = "";
    for (const sentence of sentences) {
      const next = `${candidate}${candidate ? " " : ""}${sentence.trim()}`;
      if (next.length > MAX_OVERVIEW_QUOTE_CHARS) break;
      candidate = next;
      if (candidate.length >= MIN_OVERVIEW_QUOTE_CHARS) break;
    }
    candidate = candidate || block;
    if (
      candidate.length < MIN_OVERVIEW_QUOTE_CHARS ||
      candidate.length > MAX_OVERVIEW_QUOTE_CHARS
    ) {
      continue;
    }
    if (/^(?:title|authors?|date|publication|doi|abstract):/i.test(candidate)) {
      continue;
    }
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
    if (out.length >= MAX_OVERVIEW_QUOTES_PER_RESULT) break;
  }
  return out;
}

export function getUniqueSourceLabels(entries: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const record = validateObject<Record<string, unknown>>(entry)
      ? entry
      : null;
    const sourceLabel = normalizeString(record?.sourceLabel);
    if (!sourceLabel || seen.has(sourceLabel)) continue;
    seen.add(sourceLabel);
    out.push(sourceLabel);
  }
  return out;
}

export function countGroupedPassages(papers: unknown[]): number {
  return papers.reduce<number>((count, paper) => {
    const record = validateObject<Record<string, unknown>>(paper)
      ? paper
      : null;
    const passages = Array.isArray(record?.passages) ? record.passages : [];
    return count + passages.length;
  }, 0);
}

export function extractWarningText(value: unknown): string | undefined {
  if (!validateObject<Record<string, unknown>>(value)) return undefined;
  return normalizeString(value.warning);
}

export function combineWarnings(
  ...warnings: Array<string | undefined>
): string | undefined {
  const unique = Array.from(
    new Set(warnings.map((entry) => normalizeString(entry)).filter(Boolean)),
  );
  return unique.length ? unique.join("; ") : undefined;
}

export function formatSourcePhrase(
  sourceLabels: string[],
  fallbackPaperCount?: number,
): string | null {
  if (sourceLabels.length === 1) return sourceLabels[0];
  if (sourceLabels.length > 1) return `${sourceLabels.length} sources`;
  if (fallbackPaperCount && fallbackPaperCount > 0) {
    const paperLabel = fallbackPaperCount === 1 ? "paper" : "papers";
    return `${fallbackPaperCount} ${paperLabel}`;
  }
  return null;
}

export async function hydrateFigureTargetsWithMineruMetadata(
  targets: NonNullable<PdfTarget["paperContext"]>[],
  zoteroGateway: ZoteroGateway,
): Promise<NonNullable<PdfTarget["paperContext"]>[]> {
  const attachmentInfoLoader = (
    zoteroGateway as unknown as {
      getAllChildAttachmentInfos?: (itemId: number) => Promise<
        Array<{
          contextItemId?: number;
          mineruCacheDir?: string;
        }>
      >;
    }
  ).getAllChildAttachmentInfos;
  const attachmentInfoByItem = new Map<
    number,
    Promise<Array<{ contextItemId?: number; mineruCacheDir?: string }>>
  >();
  const hydrated: NonNullable<PdfTarget["paperContext"]>[] = [];
  for (const target of targets) {
    if (normalizeString(target.mineruCacheDir)) {
      hydrated.push(target);
      continue;
    }
    if (!attachmentInfoLoader) {
      hydrated.push(target);
      continue;
    }
    const itemId = Math.floor(Number(target.itemId || 0));
    const contextItemId = Math.floor(Number(target.contextItemId || 0));
    if (!itemId || !contextItemId) {
      hydrated.push(target);
      continue;
    }
    let infoPromise = attachmentInfoByItem.get(itemId);
    if (!infoPromise) {
      infoPromise = attachmentInfoLoader.call(zoteroGateway, itemId);
      attachmentInfoByItem.set(itemId, infoPromise);
    }
    let infos: Array<{ contextItemId?: number; mineruCacheDir?: string }> = [];
    try {
      infos = await infoPromise;
    } catch (_error) {
      void _error;
    }
    const matchingAttachment = infos.find(
      (entry) => Math.floor(Number(entry.contextItemId || 0)) === contextItemId,
    );
    const mineruCacheDir = normalizeString(matchingAttachment?.mineruCacheDir);
    if (!mineruCacheDir) {
      hydrated.push(target);
      continue;
    }
    hydrated.push({
      ...target,
      contentSourceMode: target.contentSourceMode || "mineru",
      mineruCacheDir,
    });
  }
  return hydrated;
}
