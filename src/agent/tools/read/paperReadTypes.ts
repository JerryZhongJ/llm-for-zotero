import type { AgentToolContext, AgentToolArtifact } from "../../types";
import type {
  FullReadCoverageReceipt,
  FullReadPaperResult,
} from "../../../shared/exhaustiveDocumentReader";
import type { PdfTarget } from "./pdfToolUtils";

/**
 * paper_read takes structured coordinates instead of a mode enum: the
 * presence of sections/pages/labels/readFullReason selects the path, and a
 * call with no locator at all is rejected.
 */
export type PaperReadInput = {
  target?: PdfTarget;
  targets?: PdfTarget[];
  sections?: string[];
  pages?: number[];
  labels?: string[];
  images: boolean;
  readFullReason?: string;
  visualInput?: unknown;
};

export type PaperReadFigureExtractionResult = {
  mode: "figures";
  status: "ok" | "mineru_required" | "no_figures" | "error";
  query?: string;
  guidance?: string;
  expectedFigures?: Array<Record<string, unknown>>;
  missingFigures?: Array<Record<string, unknown>>;
  figures?: Array<Record<string, unknown>>;
  artifacts?: AgentToolArtifact[];
  warnings?: string[];
};

export type PaperReadFullResult = {
  mode: "full";
  status: "complete" | "partial" | "unreadable";
  papers: FullReadPaperResult[];
  coverageReceipt: FullReadCoverageReceipt;
  synthesisContext: string;
  warnings: string[];
};

export type PaperReadFigureExtractionService = {
  extractFigures: (params: {
    input: { query?: string; pages?: number[]; target?: PdfTarget };
    context: AgentToolContext;
    paperContexts: NonNullable<PdfTarget["paperContext"]>[];
  }) => Promise<PaperReadFigureExtractionResult>;
};
