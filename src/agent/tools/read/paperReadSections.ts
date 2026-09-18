import type { PdfTarget } from "./pdfToolUtils";
import type { PdfService } from "../../services/pdfService";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../../modules/contextPanel/paperAttribution";
import type { PdfChunkMeta } from "../../../modules/contextPanel/types";
import type { QuoteCitation } from "../../../shared/types";
import { mergeQuoteCitations } from "../../../modules/contextPanel/quoteCitations";
import { buildTargetedPaperGroups } from "./paperReadShared";
import { matchSectionName, suggestSections } from "./sectionMatcher";

const MAX_AVAILABLE_SECTION_NAMES = 20;

// chunkKind aliases let canonical names ("abstract", "methods") keep working
// on plain-PDF papers whose chunkMeta only carries the nine canonical labels
// — or no label at all.
const SECTION_KIND_ALIASES: Record<string, string> = {
  abstract: "abstract",
  introduction: "introduction",
  methods: "methods",
  results: "results",
  discussion: "discussion",
  conclusion: "conclusion",
  references: "references",
  appendix: "appendix",
};

type UnmatchedSectionPaper = {
  paperContext: NonNullable<PdfTarget["paperContext"]>;
  status: "no_matching_sections";
  requested: string[];
  suggestions: string[];
  availableSections: string[];
};

function collectSectionCandidates(chunkMeta: PdfChunkMeta[]): {
  labels: string[];
  kindAliases: string[];
} {
  const labels: string[] = [];
  const seenLabels = new Set<string>();
  const kinds: string[] = [];
  const seenKinds = new Set<string>();
  for (const meta of chunkMeta) {
    if (meta.sectionLabel && !seenLabels.has(meta.sectionLabel)) {
      seenLabels.add(meta.sectionLabel);
      labels.push(meta.sectionLabel);
    }
    if (
      meta.chunkKind &&
      SECTION_KIND_ALIASES[meta.chunkKind] &&
      !seenKinds.has(meta.chunkKind)
    ) {
      seenKinds.add(meta.chunkKind);
      kinds.push(meta.chunkKind);
    }
  }
  return { labels, kindAliases: kinds };
}

function selectSectionChunks(
  chunkMeta: PdfChunkMeta[],
  matchedLabels: Set<string>,
  matchedKinds: Set<string>,
): PdfChunkMeta[] {
  return chunkMeta.filter((meta) => {
    if (meta.sectionLabel && matchedLabels.has(meta.sectionLabel)) return true;
    // Kind-alias selection only applies to unlabeled chunks so a canonical
    // name never sweeps a labeled paper's unrelated sections.
    if (!meta.sectionLabel && matchedKinds.has(meta.chunkKind || "")) {
      return true;
    }
    return false;
  });
}

function toResultRows(
  paperContext: NonNullable<PdfTarget["paperContext"]>,
  chunkMeta: PdfChunkMeta[],
  chunkTexts: string[],
): Array<Record<string, unknown>> {
  return chunkMeta.map((meta) => ({
    paperContext,
    chunkIndex: meta.chunkIndex,
    text: chunkTexts[meta.chunkIndex] ?? meta.text ?? "",
    sectionLabel: meta.sectionLabel,
    chunkKind: meta.chunkKind,
    score: 1,
    ...(meta.sourceFingerprint
      ? { sourceFingerprint: meta.sourceFingerprint }
      : {}),
    ...(meta.pageStart !== undefined ? { pageStart: meta.pageStart } : {}),
    ...(meta.pageEnd !== undefined ? { pageEnd: meta.pageEnd } : {}),
    citationLabel: formatPaperCitationLabel(paperContext),
    sourceLabel: formatPaperSourceLabel(paperContext),
  }));
}

/**
 * Deterministic section read: match requested section names against the
 * chunk section labels (raw headings on the MinerU path), return the full
 * text of the matched chunks, and report unmatched names with near-miss
 * suggestions instead of failing silently.
 */
export async function executeSectionsRead(params: {
  targets: NonNullable<PdfTarget["paperContext"]>[];
  sectionNames: string[];
  pdfService: PdfService;
}): Promise<Record<string, unknown>> {
  const quoteCitations: QuoteCitation[] = [];
  const results: Array<Record<string, unknown>> = [];
  const unmatched: UnmatchedSectionPaper[] = [];

  for (const paperContext of params.targets) {
    const pdfContext = await params.pdfService.ensurePaperContext(paperContext);
    const chunkMeta = pdfContext?.chunkMeta ?? [];
    const chunkTexts = pdfContext?.chunks ?? [];
    const { labels, kindAliases } = collectSectionCandidates(chunkMeta);
    const candidates = [...labels, ...kindAliases];

    const matchedLabels = new Set<string>();
    const matchedKinds = new Set<string>();
    const unmatchedForPaper: string[] = [];
    const suggestionsForPaper: string[] = [];

    for (const requested of params.sectionNames) {
      const match = matchSectionName(requested, candidates);
      if (!match) {
        unmatchedForPaper.push(requested);
        for (const suggestion of suggestSections(requested, candidates)) {
          if (!suggestionsForPaper.includes(suggestion)) {
            suggestionsForPaper.push(suggestion);
          }
        }
        continue;
      }
      if (labels.includes(match.candidate)) {
        matchedLabels.add(match.candidate);
      } else {
        matchedKinds.add(match.candidate);
      }
    }

    if (matchedLabels.size || matchedKinds.size) {
      const selected = selectSectionChunks(
        chunkMeta,
        matchedLabels,
        matchedKinds,
      );
      results.push(...toResultRows(paperContext, selected, chunkTexts));
    }
    if (unmatchedForPaper.length) {
      unmatched.push({
        paperContext,
        status: "no_matching_sections",
        requested: unmatchedForPaper,
        suggestions: suggestionsForPaper,
        availableSections: labels.slice(0, MAX_AVAILABLE_SECTION_NAMES),
      });
    }
  }

  if (!results.length) {
    return {
      mode: "sections",
      status: "no_matching_sections",
      papers: unmatched.map((entry) => ({
        ...entry,
        paperContext: entry.paperContext,
      })),
      guidance:
        "No requested section matched this paper. Try a suggested name, use paper_query({query}) to find the passage by content, or paper_read({pages}) for known pages.",
    };
  }

  return {
    mode: "sections",
    status: unmatched.length ? "partial" : "matched",
    results,
    papers: buildTargetedPaperGroups(params.targets, results, quoteCitations),
    ...(unmatched.length ? { unmatched } : {}),
    quoteCitations: mergeQuoteCitations(quoteCitations),
  };
}
