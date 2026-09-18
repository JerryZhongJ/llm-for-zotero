import type {
  AgentToolContext,
  AgentToolArtifact,
} from "../../types";
import type {
  FullReadCoverageReceipt,
  FullReadPaperResult,
} from "../../../shared/exhaustiveDocumentReader";
import type { PdfTarget } from "./pdfToolUtils";

export type PaperReadMode =
  | "overview"
  | "targeted"
  | "full"
  | "figures"
  | "visual"
  | "capture";

export type PaperReadInput = {
  mode: PaperReadMode;
  target?: PdfTarget;
  targets?: PdfTarget[];
  query?: string;
  queryVariants?: string[];
  sections?: string[];
  pages?: number[];
  neighborPages?: number;
  maxChars?: number;
  topK?: number;
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
    input: PaperReadInput;
    context: AgentToolContext;
    paperContexts: NonNullable<PdfTarget["paperContext"]>[];
  }) => Promise<PaperReadFigureExtractionResult>;
};
