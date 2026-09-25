import type { PdfTarget } from "./pdfToolUtils";
import type { PdfService } from "../../services/pdfService";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../../modules/contextPanel/paperAttribution";
import { postprocessSectionSlice } from "../../../modules/contextPanel/pdfContext";
import type { PaperSectionIndexEntry } from "../../../modules/contextPanel/types";
import type { QuoteCitation } from "../../../shared/types";
import { mergeQuoteCitations } from "../../../modules/contextPanel/quoteCitations";
import { buildTargetedPaperGroups } from "./paperReadShared";
import { matchSectionName, suggestSections } from "./sectionMatcher";

const MAX_AVAILABLE_SECTION_NAMES = 20;

type UnmatchedSectionPaper = {
  paperContext: NonNullable<PdfTarget["paperContext"]>;
  status: "no_matching_sections" | "no_section_index";
  requested?: string[];
  suggestions?: string[];
  availableSections?: string[];
};

/**
 * Structural section read: match requested names against the paper's real
 * section index (MinerU manifest headings or a reader-outline index for plain
 * PDFs) and return each section's whole contiguous text sliced from the
 * source. There is deliberately no chunk-label fallback — a paper without a
 * section index reports no_section_index instead of silently returning
 * chunk-sized fragments.
 */
function readSectionsFromIndex(params: {
  paperContext: NonNullable<PdfTarget["paperContext"]>;
  sectionIndex: PaperSectionIndexEntry[];
  sourceText: string;
  sectionNames: string[];
  results: Array<Record<string, unknown>>;
  unmatched: UnmatchedSectionPaper[];
}): void {
  const { paperContext, sectionIndex, sourceText, sectionNames } = params;
  const headings = sectionIndex.map((section) => section.heading);
  const matchedSections = new Set<PaperSectionIndexEntry>();
  const unmatchedForPaper: string[] = [];
  const suggestionsForPaper: string[] = [];

  for (const requested of sectionNames) {
    const match = matchSectionName(requested, headings);
    if (!match) {
      unmatchedForPaper.push(requested);
      for (const suggestion of suggestSections(requested, headings)) {
        if (!suggestionsForPaper.includes(suggestion)) {
          suggestionsForPaper.push(suggestion);
        }
      }
      continue;
    }
    const entry = sectionIndex.find(
      (section) => section.heading === match.candidate,
    );
    if (entry) matchedSections.add(entry);
  }

  for (const entry of matchedSections) {
    params.results.push({
      paperContext,
      sectionLabel: entry.heading,
      text: postprocessSectionSlice(
        sourceText.slice(entry.charStart, entry.charEnd),
      ),
      score: 1,
      ...(entry.page !== undefined ? { pageStart: entry.page } : {}),
      citationLabel: formatPaperCitationLabel(paperContext),
      sourceLabel: formatPaperSourceLabel(paperContext),
    });
  }
  if (unmatchedForPaper.length) {
    params.unmatched.push({
      paperContext,
      status: "no_matching_sections",
      requested: unmatchedForPaper,
      suggestions: suggestionsForPaper,
      availableSections: headings.slice(0, MAX_AVAILABLE_SECTION_NAMES),
    });
  }
}

/**
 * Deterministic section read: the paper's real section index is the only
 * source of structural sections. Names that do not match are reported with
 * near-miss suggestions; papers without an index report no_section_index —
 * both instead of failing silently.
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
    if (pdfContext?.sectionIndex?.length && pdfContext.sourceText) {
      readSectionsFromIndex({
        paperContext,
        sectionIndex: pdfContext.sectionIndex,
        sourceText: pdfContext.sourceText,
        sectionNames: params.sectionNames,
        results,
        unmatched,
      });
      continue;
    }
    unmatched.push({
      paperContext,
      status: "no_section_index",
    });
  }

  if (!results.length) {
    const missingIndex = unmatched.filter(
      (entry) => entry.status === "no_section_index",
    );
    return {
      mode: "sections",
      status: missingIndex.length ? "no_section_index" : "no_matching_sections",
      papers: unmatched,
      ...(missingIndex.length
        ? {
            guidance:
              "This paper has no section index to read sections from. Open it in a Zotero reader tab (its PDF outline becomes the section index) or parse it with MinerU, then retry; or use paper_query({query}) to find passages by content, paper_read({pages}) for known pages.",
          }
        : {
            guidance:
              "No requested section matched this paper. Try a suggested name, use paper_query({query}) to find the passage by content, or paper_read({pages}) for known pages.",
          }),
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
