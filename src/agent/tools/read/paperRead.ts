import type { AgentToolContext, AgentToolDefinition } from "../../types";
import type { QuoteCitation } from "../../../shared/types";
import type { PdfService } from "../../services/pdfService";
import type { PdfPageService } from "../../services/pdfPageService";
import { parsePageSelectionValue } from "../../services/pdfPageService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../../modules/contextPanel/paperAttribution";
import { mergeQuoteCitations } from "../../../modules/contextPanel/quoteCitations";
import { fail, ok, PAPER_CONTEXT_REF_SCHEMA, validateObject } from "../shared";
import {
  normalizeExplicitTargetSyntax,
  describeNoDefaultPaperTarget,
  resolveDefaultTargets,
} from "./pdfToolUtils";
import type { PdfTarget } from "./pdfToolUtils";
import { createViewPdfPagesTool } from "./viewPdfPages";
import {
  readDocumentsExhaustively,
  type ExhaustiveBatchAnalyzer,
} from "../../../shared/exhaustiveDocumentReader";
import { resolveFullReadPaperTargets } from "../../../shared/fullReadTargetResolver";
import { getTurnPapersWithRoles } from "../../context/requestTurnPaperScope";
import { createCodexAppServerExhaustiveReaderSession } from "../../../codexAppServer/exhaustiveReader";
import { createZoteroMetadataResolver } from "../../../services/zoteroMetadata/resolver";
import type {
  PaperReadFigureExtractionService,
  PaperReadFullResult,
  PaperReadInput,
} from "./paperReadTypes";

export type {
  PaperReadFigureExtractionResult,
  PaperReadFigureExtractionService,
  PaperReadFullResult,
} from "./paperReadTypes";
import { executeSectionsRead } from "./paperReadSections";
import {
  buildTargetedPaperGroups,
  countGroupedPassages,
  dedupePaperContexts,
  formatSourcePhrase,
  getUniqueSourceLabels,
  hydrateFigureTargetsWithMineruMetadata,
  normalizeString,
  normalizeStringArray,
} from "./paperReadShared";

const MAX_TARGETS = 10;
const MAX_FULL_TARGETS = Number.MAX_SAFE_INTEGER;
const LEGACY_MODE_MESSAGE =
  "paper_read no longer takes 'mode'. Coordinates select the path instead: sections:[...] for section text, pages:[...] for exact pages (add images:true for rendered pages), labels:[...] with images:true for figure crops, readFullReason for an exhaustive whole-document read. For relevance-ranked evidence use paper_query({query}).";

function normalizePages(value: unknown): number[] | undefined {
  // Some models serialize the array as a JSON string ("[2, 3, 4]"). The
  // intent is still exact pages, so unwrap it before the shared parser;
  // anything that is not a JSON array (or parses to junk) falls through
  // and fails loudly in validate.
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value.trim());
      if (Array.isArray(parsed)) value = parsed;
    } catch {
      // Not valid JSON — leave the string to the shared parser.
    }
  }
  // Bare page syntax ("16-18") is documented in the schema; the shared
  // parser only understands the "p16-18" form, so prefix bare digits.
  const normalized =
    typeof value === "string" && /^\s*\d/.test(value)
      ? `p${value.trim()}`
      : value;
  return parsePageSelectionValue(normalized)?.pageIndexes;
}

function hasArg(args: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, name);
}

function resolveFullReadTargets(params: {
  input: PaperReadInput;
  context: AgentToolContext;
  zoteroGateway: ZoteroGateway;
}): NonNullable<PdfTarget["paperContext"]>[] {
  // Full reads are gated on an explicit, auditable reason (readFullReason,
  // validated in validate()) instead of implicit analysis of the user's
  // phrasing.
  const explicitTargets =
    params.input.target || params.input.targets?.length
      ? resolveDefaultTargets(
          params.input.target,
          params.input.targets,
          params.context,
          params.zoteroGateway,
          MAX_FULL_TARGETS,
        )
      : [];
  if (explicitTargets.length) return explicitTargets;
  const requestText = (params.context.request.userText || "").trim();
  const selected = dedupePaperContexts([
    ...getTurnPapersWithRoles(params.context.request, ["selected", "ambient"]),
  ]);
  const activePaper = getTurnPapersWithRoles(params.context.request, [
    "active",
  ])[0];
  const available = dedupePaperContexts([
    ...params.zoteroGateway.listPaperContexts(params.context.request),
    ...(activePaper ? [activePaper] : []),
    ...selected,
  ]);
  return resolveFullReadPaperTargets({
    question: requestText,
    availablePapers: available,
    selectedPapers: selected,
    activePaper,
  }).papers;
}

async function readExplicitPageTargets(params: {
  targets: NonNullable<PdfTarget["paperContext"]>[];
  pages: number[];
  context: AgentToolContext;
  pdfPageService: PdfPageService;
}): Promise<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  const quoteCitations: QuoteCitation[] = [];
  for (const paperContext of params.targets) {
    const pageResult = await params.pdfPageService.readPageTexts({
      paperContext,
      request: params.context.request,
      pages: params.pages,
    });
    for (const page of pageResult.pages) {
      results.push({
        paperContext,
        text: page.text,
        sourceKind: "paper_page_text",
        chunkKind: "page",
        pageIndex: page.pageIndex,
        pageLabel: page.pageLabel,
        sectionLabel: `Page ${page.pageLabel}`,
        score: 1,
        citationLabel: formatPaperCitationLabel(paperContext),
        sourceLabel: formatPaperSourceLabel(paperContext),
      });
    }
  }
  return {
    mode: "pages",
    results,
    papers: buildTargetedPaperGroups(params.targets, results, quoteCitations),
    quoteCitations: mergeQuoteCitations(quoteCitations),
  };
}

export function createPaperReadTool(
  pdfService: PdfService,
  _retrievalService: unknown,
  pdfPageService: PdfPageService,
  zoteroGateway: ZoteroGateway,
  figureExtractionService?: PaperReadFigureExtractionService,
  fullReadAnalyzer?: ExhaustiveBatchAnalyzer,
): AgentToolDefinition<PaperReadInput, unknown> {
  const visualTool = createViewPdfPagesTool(pdfPageService, zoteroGateway);
  return {
    spec: {
      name: "paper_read",
      description:
        "Read content from the active or targeted papers by structured coordinate. sections:['Methods'] returns whole sections (combine ['Abstract','Introduction','Conclusion'] for a broad picture); pages:[16,17] ('16-20' also works) returns exact page text; labels:['Figure 3'] with images:true returns precise figure crops; images:true with pages returns rendered PDF pages; images:true alone returns all figures; readFullReason:'...' triggers an exhaustive whole-document read; a call without a locator is rejected. To find passages by what they say instead of where they are, use paper_query.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: {
            description:
              "Paper(s) to read — one selector or an array. Omit to use the current turn's paper scope. attachmentId/name selectors select an uploaded attachment (images reads only).",
            anyOf: [
              {
                type: "object",
                properties: {
                  contextItemId: { type: "number" },
                  itemId: { type: "number" },
                  paperContext: PAPER_CONTEXT_REF_SCHEMA,
                  attachmentId: { type: "string" },
                  name: { type: "string" },
                },
                additionalProperties: false,
                anyOf: [
                  { required: ["contextItemId"] },
                  { required: ["itemId"] },
                  { required: ["paperContext"] },
                  { required: ["attachmentId"] },
                  { required: ["name"] },
                ],
              },
              {
                type: "array",
                minItems: 1,
                maxItems: MAX_TARGETS,
                items: {
                  type: "object",
                  properties: {
                    contextItemId: { type: "number" },
                    itemId: { type: "number" },
                    paperContext: PAPER_CONTEXT_REF_SCHEMA,
                  },
                  additionalProperties: false,
                  anyOf: [
                    { required: ["contextItemId"] },
                    { required: ["itemId"] },
                    { required: ["paperContext"] },
                  ],
                },
              },
            ],
          },
          sections: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string", minLength: 1 },
            description:
              "Section names as they appear in the paper (e.g. 'Methods', '3.2 Ablation Study'). Returns the full text of those sections. Mutually exclusive with pages and labels.",
          },
          pages: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "array", items: { type: "number" } },
            ],
            description:
              "1-based page numbers (e.g. 17, [16,17,18], or '16-20'). Returns the raw text of exactly those pages; with images:true renders them instead. Mutually exclusive with sections and labels. Mentioning page numbers inside a query has no effect — this is the only page coordinate.",
          },
          labels: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: { type: "string", minLength: 1 },
            description:
              "Figure/table labels such as 'Figure 3', 'Fig 4a', 'Extended Data Figure 2', 'Table 1'. Requires images:true; returns precise extracted crops with captions. Mutually exclusive with sections and pages.",
          },
          images: {
            type: "boolean",
            description:
              "false (default) returns text. true with pages returns rendered PDF page images; true with labels returns figure crops; true alone returns all figures. Not valid with sections.",
          },
          readFullReason: {
            type: "string",
            description:
              "One short sentence explaining why the complete document must be read exhaustively (e.g. 'verify every reference entry against its DOI'). Triggers a whole-document read with a coverage receipt. Prefer sections, pages, or paper_query when a part or claim suffices.",
          },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
      exposure: "model",
      tier: "normal",
    },
    presentation: {
      label: "Read Paper",
      summaries: {
        onCall: ({ args }) => {
          const record = (args as Record<string, unknown>) || {};
          if (record.readFullReason) {
            return `Reading the complete paper text — ${record.readFullReason}`;
          }
          if (record.labels) {
            const labels = Array.isArray(record.labels)
              ? record.labels.join(", ")
              : "";
            return `Extracting figures: ${labels || "all figures"}`;
          }
          if (record.images && record.pages) {
            return "Preparing paper pages for visual review";
          }
          if (record.pages) {
            return `Reading pages: ${
              Array.isArray(record.pages)
                ? record.pages.join(", ")
                : String(record.pages)
            }`;
          }
          if (record.sections) {
            const sections = Array.isArray(record.sections)
              ? record.sections.join(", ")
              : "";
            return `Reading sections: ${sections}`;
          }
          return "Reading paper";
        },
        onPending: "Waiting for your approval before sending document content",
        onApproved: "Approval received - sending document content",
        onDenied: "Paper reading cancelled",
        onSuccess: ({ content }) => {
          const c = content as Record<string, unknown> | null;
          const mode = typeof c?.mode === "string" ? c.mode : undefined;
          const results = Array.isArray(c?.results) ? c.results : undefined;
          const papers = Array.isArray(c?.papers) ? c.papers : undefined;
          if (mode === "targeted" || mode === "sections" || mode === "pages") {
            const passageCount =
              results?.length ?? (papers ? countGroupedPassages(papers) : 0);
            if (passageCount > 0) {
              const passageLabel = passageCount === 1 ? "passage" : "passages";
              const sourcePhrase = formatSourcePhrase(
                getUniqueSourceLabels(papers || results || []),
                papers?.length,
              );
              return sourcePhrase
                ? `Read ${passageCount} ${passageLabel} from ${sourcePhrase}`
                : `Read ${passageCount} ${passageLabel}`;
            }
            if (mode === "sections") return "No matching sections";
            return "Read paper content";
          }
          if (mode === "full") {
            const receipt = c?.coverageReceipt as
              | { processedChunks?: number; totalChunks?: number }
              | undefined;
            return `Read ${receipt?.processedChunks || 0}/${receipt?.totalChunks || 0} full-text chunks`;
          }
          if (mode === "figures") {
            const figures = Array.isArray(c?.figures) ? c.figures : [];
            if (c?.status === "mineru_required") {
              return "Figure extraction requires MinerU cache";
            }
            return figures.length === 1
              ? "Extracted 1 figure"
              : `Extracted ${figures.length} figures`;
          }
          const resultCount = results?.length ?? 1;
          return resultCount > 1
            ? `Read ${resultCount} papers`
            : "Read paper content";
        },
      },
    },
    validate(args) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      // Legacy-argument migration errors first: a model that learned the old
      // surface gets one self-correcting hop instead of a generic rejection.
      if (hasArg(args, "mode")) {
        return fail(LEGACY_MODE_MESSAGE);
      }
      for (const legacyArg of [
        "query",
        "queryVariants",
        "topK",
        "neighborPages",
        "maxChars",
        "targets",
      ]) {
        if (hasArg(args, legacyArg)) {
          return fail(
            `paper_read no longer takes '${legacyArg}'. Semantic search moved to paper_query({query}); section text is sections:[...]; figure selection is labels:[...] with images:true; exact pages are pages:[...].`,
          );
        }
      }
      const images = args.images === true;
      const sections = normalizeStringArray(args.sections);
      const pages = normalizePages(args.pages);
      // An unparseable pages value must fail loudly: silently dropping it
      // would degrade the call to an overview read the model never asked for.
      if (hasArg(args, "pages") && !pages?.length) {
        return fail(
          "Could not parse pages. Pass exact PDF pages as numbers (17), an array ([16,17,18]), or a bare range string ('16-20').",
        );
      }
      const labels = normalizeStringArray(args.labels);
      const readFullReason = normalizeString(args.readFullReason);

      const locators = [
        sections ? "sections" : "",
        pages?.length ? "pages" : "",
        labels ? "labels" : "",
      ].filter(Boolean);
      if (locators.length > 1) {
        return fail(
          `Provide at most one of sections, pages, labels — they select text by different coordinates. Got both: ${locators[0]} and ${locators[1]}.`,
        );
      }
      if (images && sections) {
        return fail(
          "images:true renders PDF page images or figure crops and cannot select by sections. Use sections without images for section text, or pages with images:true for rendered pages.",
        );
      }
      if (labels && !images) {
        return fail(
          "labels select extracted figure/table crops, which are images. Add images:true, e.g. paper_read({labels:['Figure 3'], images:true}).",
        );
      }
      if (readFullReason && (locators.length || images)) {
        return fail(
          "readFullReason triggers an exhaustive whole-document read; sections/pages/labels/images are redundant with it. Drop the locators or drop readFullReason.",
        );
      }
      if (!sections && !pages?.length && !labels && !images && !readFullReason) {
        return fail(
          "paper_read requires a locator: sections (e.g. ['Abstract', 'Introduction', 'Conclusion'] for a broad picture), pages, labels with images:true, or readFullReason. For relevance-ranked passages use paper_query({query}).",
        );
      }

      const isTargetArray = Array.isArray(args.target);
      const targetSyntax = normalizeExplicitTargetSyntax({
        targetProvided: hasArg(args, "target") && !isTargetArray,
        target: isTargetArray ? undefined : args.target,
        targetsProvided: isTargetArray,
        targets: isTargetArray ? args.target : undefined,
        mode: images ? "visual" : "paper",
        maxCount: readFullReason
          ? MAX_FULL_TARGETS
          : images
            ? 1
            : MAX_TARGETS,
      });
      if (targetSyntax.kind === "invalid") {
        return fail(`${targetSyntax.code}: ${targetSyntax.message}`);
      }
      const explicitTarget =
        targetSyntax.kind === "visual_selector"
          ? {
              ...targetSyntax.selector.paperSelector,
              attachmentId: targetSyntax.selector.attachmentId,
              name: targetSyntax.selector.name,
            }
          : undefined;
      if (explicitTarget && !images) {
        return fail(
          "attachmentId and name selectors are supported only for image reads (images:true).",
        );
      }
      const selectors =
        targetSyntax.kind === "paper_selectors"
          ? [...targetSyntax.selectors]
          : undefined;
      if ((explicitTarget || selectors?.length) && images && pages?.length) {
        // Visual page render keeps the review-card flow: validate through the
        // embedded visual tool so confirmation hooks work unchanged.
        const visualValidation = visualTool.validate({
          ...(explicitTarget ? { target: explicitTarget } : {}),
          pages: pages.map((pageIndex) => pageIndex + 1),
        });
        if (!visualValidation.ok) return fail(visualValidation.error);
        return ok({
          target: explicitTarget,
          targets: selectors,
          sections,
          pages,
          labels,
          images,
          readFullReason: undefined,
          visualInput: visualValidation.value,
        });
      }
      return ok({
        target: explicitTarget,
        targets: selectors,
        sections,
        pages,
        labels,
        images,
        readFullReason,
      });
    },
    async shouldRequireConfirmation(input, context) {
      if (!input.visualInput) return false;
      return Boolean(
        await visualTool.shouldRequireConfirmation?.(
          input.visualInput as never,
          context,
        ),
      );
    },
    async createPendingAction(input, context) {
      if (!input.visualInput) {
        throw new Error("Only image page reads need review");
      }
      const action = await visualTool.createPendingAction!(
        input.visualInput as never,
        context,
      );
      return {
        ...action,
        toolName: "paper_read",
      };
    },
    applyConfirmation(input, resolutionData, context) {
      if (!input.visualInput) return ok(input);
      const resolved = visualTool.applyConfirmation?.(
        input.visualInput as never,
        resolutionData,
        context,
      );
      if (!resolved) return ok(input);
      if (!resolved.ok) return fail(resolved.error);
      return ok({
        ...input,
        visualInput: resolved.value,
      });
    },
    async execute(input, context) {
      if (input.visualInput) {
        return visualTool.execute(input.visualInput as never, context);
      }
      if (input.readFullReason) {
        return executeFullRead({
          input,
          context,
          pdfService,
          zoteroGateway,
          fullReadAnalyzer,
        });
      }
      if (input.images) {
        const targets = resolveDefaultTargets(
          input.target,
          input.targets,
          context,
          zoteroGateway,
          MAX_TARGETS,
        );
        if (!targets.length) {
          throw new Error(describeNoDefaultPaperTarget(context.request));
        }
        if (!figureExtractionService) {
          return {
            mode: "figures",
            status: "error",
            query: input.labels?.join("; "),
            warning: "Precise figure extraction service is not available.",
          };
        }
        const figureTargets = await hydrateFigureTargetsWithMineruMetadata(
          targets,
          zoteroGateway,
        );
        const figureResult = await figureExtractionService.extractFigures({
          input: {
            // labels ARE the query for the crop extractor's label parser; an
            // absent labels list means "all figures" (empty query).
            query: input.labels?.length ? input.labels.join("; ") : undefined,
            target: input.target,
          },
          context,
          paperContexts: figureTargets,
        });
        const { artifacts, ...content } = figureResult;
        return artifacts?.length ? { content, artifacts } : content;
      }
      if (input.sections?.length) {
        const targets = resolveDefaultTargets(
          input.target,
          input.targets,
          context,
          zoteroGateway,
          MAX_TARGETS,
        );
        if (!targets.length) {
          throw new Error(describeNoDefaultPaperTarget(context.request));
        }
        return executeSectionsRead({
          targets,
          sectionNames: input.sections,
          pdfService,
        });
      }
      if (input.pages?.length) {
        const targets = resolveDefaultTargets(
          input.target,
          input.targets,
          context,
          zoteroGateway,
          MAX_TARGETS,
        );
        if (!targets.length) {
          throw new Error(describeNoDefaultPaperTarget(context.request));
        }
        return readExplicitPageTargets({
          targets,
          pages: input.pages,
          context,
          pdfPageService,
        });
      }
      throw new Error(
        "paper_read requires a locator (sections, pages, labels with images:true, or readFullReason); validate should have rejected this call.",
      );
    },
  };
}

async function executeFullRead(params: {
  input: PaperReadInput;
  context: AgentToolContext;
  pdfService: PdfService;
  zoteroGateway: ZoteroGateway;
  fullReadAnalyzer?: ExhaustiveBatchAnalyzer;
}): Promise<Record<string, unknown>> {
  const { input, context } = params;
  const targets = resolveFullReadTargets({
    input,
    context,
    zoteroGateway: params.zoteroGateway,
  });
  if (
    !params.fullReadAnalyzer &&
    context.request.exhaustiveReadBackend === "unavailable"
  ) {
    throw new Error(
      "Exhaustive paper reading cannot run because a tool-free full-read backend is unavailable for this MCP scope. Use sections, pages, or paper_query, or start the request from a provider-backed chat that supports exhaustive reading.",
    );
  }
  const nativeFullReadModel = `${context.request.model || ""}`.trim();
  if (
    !params.fullReadAnalyzer &&
    context.request.authMode === "codex_app_server" &&
    (!nativeFullReadModel || nativeFullReadModel === "codex-app-server")
  ) {
    throw new Error(
      "Exhaustive paper reading cannot run because the Codex tool-free full-read backend has no selected model.",
    );
  }
  const paperInputs = [];
  for (const paperContext of targets) {
    paperInputs.push({
      paperContext,
      pdfContext: await params.pdfService.ensurePaperContext(paperContext),
    });
  }
  const inputTokenCap = Math.max(
    2048,
    Math.floor(Number(context.request.advanced?.inputTokenCap || 12000)),
  );
  const nativeReaderSession =
    !params.fullReadAnalyzer && context.request.authMode === "codex_app_server"
      ? createCodexAppServerExhaustiveReaderSession({
          model: nativeFullReadModel,
          reasoning: context.request.reasoning,
          profileOverride: context.request.advanced?.profileOverride,
        })
      : null;
  const result = await (async () => {
    try {
      return await readDocumentsExhaustively({
        papers: paperInputs,
        question: context.request.userText || "Read the full text.",
        batchTokenBudget: Math.max(1024, Math.floor(inputTokenCap * 0.5)),
        finalTokenBudget: Math.max(1024, Math.floor(inputTokenCap * 0.45)),
        analyzeBatch:
          params.fullReadAnalyzer || nativeReaderSession?.analyzeBatch,
        signal: context.signal,
        llm: {
          model: context.request.model,
          apiBase: context.request.apiBase,
          apiKey: context.request.apiKey,
          authMode: context.request.authMode,
          providerProtocol: context.request.providerProtocol,
          reasoning: context.request.reasoning,
          profileOverride: context.request.advanced?.profileOverride,
        },
      });
    } finally {
      nativeReaderSession?.dispose();
    }
  })();
  const output: PaperReadFullResult = {
    mode: "full",
    status: result.status,
    papers: result.papers,
    coverageReceipt: result.receipt,
    synthesisContext: result.contextText,
    warnings: result.warnings,
  };
  return output;
}

