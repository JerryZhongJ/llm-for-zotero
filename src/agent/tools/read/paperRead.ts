import type {
  AgentToolContext,
  AgentToolDefinition,
  AgentToolResult,
} from "../../types";
import type { QuoteCitation } from "../../../shared/types";
import type { PdfService } from "../../services/pdfService";
import type { PdfPageService } from "../../services/pdfPageService";
import { parsePageSelectionValue } from "../../services/pdfPageService";
import type { RetrievalService } from "../../services/retrievalService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../../modules/contextPanel/paperAttribution";
import { mergeQuoteCitations } from "../../../modules/contextPanel/quoteCitations";
import {
  fail,
  normalizePositiveInt,
  ok,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
} from "../shared";
import {
  buildCaptureFollowupMessage,
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
  PaperReadMode,
} from "./paperReadTypes";

export type {
  PaperReadFigureExtractionResult,
  PaperReadFigureExtractionService,
  PaperReadFullResult,
} from "./paperReadTypes";
export { resolveMetadataOverviewTitleForTests } from "./paperReadOverview";
import {
  buildMetadataOverview,
  tryReadMineruOverview,
} from "./paperReadOverview";
import {
  buildOverviewQuoteCitationPack,
  buildTargetedPaperGroups,
  combineWarnings,
  countGroupedPassages,
  dedupePaperContexts,
  extractWarningText,
  formatSourcePhrase,
  getUniqueSourceLabels,
  hydrateFigureTargetsWithMineruMetadata,
  normalizeString,
  normalizeStringArray,
} from "./paperReadShared";

const MAX_OVERVIEW_TARGETS = 5;
const MAX_TARGETED_TARGETS = 10;
const MAX_FULL_TARGETS = Number.MAX_SAFE_INTEGER;

function normalizeMode(value: unknown): PaperReadMode {
  return value === "targeted" ||
    value === "full" ||
    value === "figures" ||
    value === "visual" ||
    value === "capture" ||
    value === "overview"
    ? value
    : "overview";
}

function normalizePages(value: unknown): number[] | undefined {
  return parsePageSelectionValue(value)?.pageIndexes;
}

function resolveFullReadTargets(params: {
  input: PaperReadInput;
  context: AgentToolContext;
  zoteroGateway: ZoteroGateway;
}): NonNullable<PdfTarget["paperContext"]>[] {
  // Full reads are no longer gated on implicit analysis of the user's
  // phrasing. The model must state why the complete document is needed via
  // the required readFullReason argument (validated in validate()), which
  // makes the decision explicit and auditable instead of inferred.
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
  const requestText =
    (params.context.request.userText || "").trim() || params.input.query || "";
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

function targetForPageTool(input: PaperReadInput): Record<string, unknown> {
  const target = input.target || input.targets?.[0];
  return {
    ...(target ? { target } : {}),
    ...(input.query ? { question: input.query } : {}),
    ...(input.pages?.length
      ? { pages: input.pages.map((pageIndex) => pageIndex + 1) }
      : {}),
    ...(input.neighborPages ? { neighborPages: input.neighborPages } : {}),
    ...(input.mode === "capture" ? { capture: true } : {}),
  };
}

function isExplicitPdfVisualRequest(
  input: PaperReadInput,
  requestText: string | undefined,
): boolean {
  if (input.pages?.length) return true;
  const text = [input.query || "", requestText || ""]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!text) return false;
  return (
    /\b(?:raw|rendered?)\s+pdf\b/.test(text) ||
    /\bpdf\s+(?:page|pages|render|renders|screenshot|screenshots|layout)\b/.test(
      text,
    ) ||
    /\b(?:render|renders|rendered|screenshot|screenshots|capture|captures|captured)\s+(?:the\s+)?(?:pdf\s+)?pages?\b/.test(
      text,
    ) ||
    /\b(?:current|visible)\s+(?:reader\s+)?pages?\b/.test(text) ||
    /\bpage\s+(?:image|images|layout|screenshot|screenshots|render|renders|rendered)\b/.test(
      text,
    ) ||
    /\bexact\s+pages?\b/.test(text) ||
    /\bpages?\s+\d+(?:\s*(?:-|–|to|,|and)\s*\d+)?\b/.test(text) ||
    /\bp\.?\s*\d+\b/.test(text) ||
    /\bpaper_read\s*\(\s*\{\s*mode\s*:\s*['"]visual['"]/.test(text)
  );
}

function getCombinedQueryText(
  input: Pick<PaperReadInput, "query">,
  requestText: string | undefined,
): string {
  return [input.query || "", requestText || ""]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isTableOnlyInterpretationRequest(
  input: Pick<PaperReadInput, "query">,
  requestText: string | undefined,
): boolean {
  const text = getCombinedQueryText(input, requestText);
  if (!text) return false;
  const hasTable = /\btables?\s+(?:[sS]?\d+|[IVX]+)\b/i.test(text);
  if (!hasTable) return false;
  const hasFigure = /\b(?:fig(?:ure)?s?\.?|figs?\.?)\s*[sS]?\d+\b/i.test(text);
  return !hasFigure;
}

async function buildMineruVisualRedirect(params: {
  input: PaperReadInput;
  context: AgentToolContext;
  zoteroGateway: ZoteroGateway;
}): Promise<Record<string, unknown> | null> {
  if (
    isExplicitPdfVisualRequest(params.input, params.context.request.userText)
  ) {
    return null;
  }
  let targets: NonNullable<PdfTarget["paperContext"]>[] = [];
  try {
    targets = resolveDefaultTargets(
      params.input.target,
      params.input.targets?.slice(0, 1),
      params.context,
      params.zoteroGateway,
      1,
    );
  } catch {
    return null;
  }
  const paperContext = targets[0] || null;
  const mineruCacheDir = normalizeString(paperContext?.mineruCacheDir);
  if (!paperContext) return null;
  const query = params.input.query || params.context.request.userText || "";
  if (
    isTableOnlyInterpretationRequest(
      params.input,
      params.context.request.userText,
    )
  ) {
    if (!mineruCacheDir) return null;
    return {
      mode: "visual",
      status: "use_text_mode",
      backend: "mineru",
      query,
      paperContext,
      mineruCacheDir,
      guidance:
        "This is a table request for a MinerU-ready paper. Do not render PDF pages and do not use the figure-crop extractor. Call paper_read({ mode:'targeted', query:'<table label and surrounding discussion>' }) so the answer comes from MinerU table text, captions, and surrounding extracted text. Use direct file_io manifest/full.md inspection only for explicit filesystem/cache-inspection tasks.",
      nextSteps: [
        `paper_read({ mode:'targeted', query:'${query.replace(/'/g, "\\'")}' })`,
      ],
    };
  }
  return {
    mode: "visual",
    status: "use_figures_mode",
    backend: "pdf_figure_extraction",
    query,
    paperContext,
    ...(mineruCacheDir ? { mineruCacheDir } : {}),
    guidance:
      "This is a figure/image request for a Zotero library PDF. Do not read MinerU image paths and do not use paper_read mode:'visual' for figure interpretation. Call paper_read({ mode:'figures', query:'<figure/table label or all figures>' }) to get precise PDF crops plus captions/provenance. Use mode:'visual' only for explicit raw/rendered PDF page or layout inspection.",
    nextSteps: [
      `paper_read({ mode:'figures', query:'${query.replace(/'/g, "\\'")}' })`,
    ],
  };
}

async function readExplicitPageTargets(params: {
  input: PaperReadInput;
  targets: NonNullable<PdfTarget["paperContext"]>[];
  context: AgentToolContext;
  pdfPageService: PdfPageService;
}): Promise<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  const quoteCitations: QuoteCitation[] = [];
  for (const paperContext of params.targets) {
    const pageResult = await params.pdfPageService.readPageTexts({
      paperContext,
      request: params.context.request,
      pages: params.input.pages || [],
      neighborPages: params.input.neighborPages,
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
    mode: params.input.mode,
    results,
    papers: buildTargetedPaperGroups(params.targets, results, quoteCitations),
    quoteCitations: mergeQuoteCitations(quoteCitations),
  };
}

export function createPaperReadTool(
  pdfService: PdfService,
  retrievalService: RetrievalService,
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
        "Read content from the active or targeted paper through one semantic tool. Use mode:'overview' for bounded summaries, mode:'targeted' for relevance-ranked textual evidence, mode:'full' for exhaustive whole-document reading (requires readFullReason), mode:'figures' for precise extracted figures from Zotero library PDFs, mode:'visual' for rendered PDF pages/layout, and mode:'capture' for the currently visible Zotero reader page.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        allOf: [
          {
            not: {
              required: ["target", "targets"],
            },
          },
        ],
        properties: {
          mode: {
            type: "string",
            enum: [
              "overview",
              "targeted",
              "full",
              "figures",
              "visual",
              "capture",
            ],
            description:
              "overview = bounded summary/main message; targeted = relevance-ranked text evidence; full = exhaustive processing of every extractable text chunk (requires readFullReason); figures = precise extracted figures; visual = rendered pages/layout; capture = current reader page.",
          },
          readFullReason: {
            type: "string",
            description:
              "Required when mode is 'full': one short sentence explaining why the complete document must be read (e.g. 'verify every reference entry against its DOI'). Prefer mode:'targeted' with a specific query when a section or claim suffices.",
          },
          target: {
            type: "object",
            description:
              "Optional explicit paper or visual target. Omit this property to use the current turn's paper scope.",
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
          targets: {
            type: "array",
            minItems: 1,
            description:
              "Optional explicit paper targets. Omit this property to use the current turn's paper scope.",
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
          query: { type: "string" },
          queryVariants: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional search probes such as translations, acronyms, notation variants, or technical equivalents.",
          },
          sections: { type: "array", items: { type: "string" } },
          pages: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "array", items: { type: "number" } },
            ],
            description:
              "1-based page numbers (e.g. 17, [16,17,18], or '16-20'). When set, bypasses relevance ranking entirely and returns the raw text of exactly those pages — use it whenever the target location is known (a specific table/figure/section) instead of rephrasing the query. Mentioning page numbers inside 'query' has no effect on ranking.",
          },
          neighborPages: {
            type: "number",
            description:
              "With 'pages': also include this many adjacent pages before and after each requested page.",
          },
          maxChars: { type: "number" },
          topK: { type: "number" },
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
          const mode =
            args && typeof args === "object"
              ? String((args as Record<string, unknown>).mode || "overview")
              : "overview";
          if (mode === "visual")
            return "Preparing paper pages for visual review";
          if (mode === "figures")
            return "Extracting precise figures from the paper";
          if (mode === "capture") return "Capturing current paper page";
          if (mode === "targeted") return "Reading targeted paper content";
          if (mode === "full") {
            const reason = normalizeString(
              (args as Record<string, unknown> | undefined)?.readFullReason,
            );
            return reason
              ? `Reading the complete paper text — ${reason}`
              : "Reading the complete paper text";
          }
          return "Reading paper overview";
        },
        onPending: "Waiting for your approval before sending document content",
        onApproved: "Approval received - sending document content",
        onDenied: "Paper reading cancelled",
        onSuccess: ({ content }) => {
          const c = content as Record<string, unknown> | null;
          const mode = typeof c?.mode === "string" ? c.mode : undefined;
          const results = Array.isArray(c?.results) ? c.results : undefined;
          const papers = Array.isArray(c?.papers) ? c.papers : undefined;
          if (mode === "targeted") {
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
            return "Read paper content";
          }
          if (mode === "full") {
            const receipt = c?.coverageReceipt as
              | { processedChunks?: number; totalChunks?: number }
              | undefined;
            return `Read ${receipt?.processedChunks || 0}/${receipt?.totalChunks || 0} full-text chunks`;
          }
          if (mode === "overview" && results?.length) {
            const sourcePhrase = formatSourcePhrase(
              getUniqueSourceLabels(results),
            );
            if (sourcePhrase) {
              const overviewLabel =
                results.length === 1 ? "paper overview" : "paper overviews";
              return `Read ${overviewLabel} from ${sourcePhrase}`;
            }
          }
          if (mode === "visual" && c?.status === "use_figures_mode") {
            return "Use figure extraction for this figure request";
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
      const mode = normalizeMode(args.mode);
      const maxTargets =
        mode === "overview"
          ? MAX_OVERVIEW_TARGETS
          : mode === "full"
            ? MAX_FULL_TARGETS
            : MAX_TARGETED_TARGETS;
      const targetSyntax = normalizeExplicitTargetSyntax({
        targetProvided: Object.prototype.hasOwnProperty.call(args, "target"),
        target: args.target,
        targetsProvided: Object.prototype.hasOwnProperty.call(args, "targets"),
        targets: args.targets,
        mode: mode === "visual" || mode === "capture" ? "visual" : "paper",
        maxCount: maxTargets,
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
      const readFullReason = normalizeString(args.readFullReason);
      if (mode === "full" && !readFullReason) {
        return fail(
          "paper_read mode:'full' requires readFullReason: one short sentence explaining why the complete document must be read. Use mode:'targeted' with a specific query when a section or claim suffices.",
        );
      }
      const input: PaperReadInput = {
        mode,
        target: explicitTarget,
        targets:
          targetSyntax.kind === "paper_selectors"
            ? [...targetSyntax.selectors]
            : undefined,
        query: normalizeString(args.query),
        queryVariants: normalizeStringArray(args.queryVariants),
        sections: normalizeStringArray(args.sections),
        pages: normalizePages(args.pages),
        neighborPages: normalizePositiveInt(args.neighborPages),
        maxChars: normalizePositiveInt(args.maxChars),
        topK: normalizePositiveInt(args.topK),
        readFullReason,
      };
      if (mode === "visual" || mode === "capture") {
        const visualValidation = visualTool.validate(targetForPageTool(input));
        if (!visualValidation.ok) return fail(visualValidation.error);
        input.visualInput = visualValidation.value;
      }
      return ok(input);
    },
    async shouldRequireConfirmation(input, context) {
      if (input.mode !== "visual" && input.mode !== "capture") return false;
      return Boolean(
        await visualTool.shouldRequireConfirmation?.(
          input.visualInput as never,
          context,
        ),
      );
    },
    async createPendingAction(input, context) {
      if (input.mode !== "visual" && input.mode !== "capture") {
        throw new Error("Only visual and capture paper_read modes need review");
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
      if (input.mode !== "visual" && input.mode !== "capture") return ok(input);
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
      if (input.mode === "visual" || input.mode === "capture") {
        if (input.mode === "visual") {
          const mineruRedirect = await buildMineruVisualRedirect({
            input,
            context,
            zoteroGateway,
          });
          if (mineruRedirect) return mineruRedirect;
        }
        return visualTool.execute(input.visualInput as never, context);
      }
      const targets =
        input.mode === "full"
          ? resolveFullReadTargets({ input, context, zoteroGateway })
          : resolveDefaultTargets(
              input.target,
              input.targets,
              context,
              zoteroGateway,
              input.mode === "overview"
                ? MAX_OVERVIEW_TARGETS
                : MAX_TARGETED_TARGETS,
            );
      if (!targets.length) {
        throw new Error(describeNoDefaultPaperTarget(context.request));
      }
      if (input.mode === "figures") {
        if (isTableOnlyInterpretationRequest(input, context.request.userText)) {
          return {
            mode: "figures",
            status: "no_figures",
            query: input.query || context.request.userText || "",
            guidance:
              "Tables are handled through extracted MinerU text/table content, not the figure-crop extractor. Use paper_read mode:'targeted' with the table label and surrounding discussion.",
          };
        }
        const figureTargets = await hydrateFigureTargetsWithMineruMetadata(
          targets,
          zoteroGateway,
        );
        if (!figureExtractionService) {
          return {
            mode: "figures",
            status: "error",
            query: input.query || context.request.userText || "",
            warning: "Precise figure extraction service is not available.",
          };
        }
        const figureResult = await figureExtractionService.extractFigures({
          input,
          context,
          paperContexts: figureTargets,
        });
        const { artifacts, ...content } = figureResult;
        return artifacts?.length ? { content, artifacts } : content;
      }
      if (input.mode === "full") {
        if (
          !fullReadAnalyzer &&
          context.request.exhaustiveReadBackend === "unavailable"
        ) {
          throw new Error(
            "Exhaustive paper reading cannot run because a tool-free full-read backend is unavailable for this MCP scope. Use mode:'targeted', or start the request from a provider-backed chat that supports exhaustive reading.",
          );
        }
        const nativeFullReadModel = `${context.request.model || ""}`.trim();
        if (
          !fullReadAnalyzer &&
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
            pdfContext: await pdfService.ensurePaperContext(paperContext),
          });
        }
        const inputTokenCap = Math.max(
          2048,
          Math.floor(Number(context.request.advanced?.inputTokenCap || 12000)),
        );
        const nativeReaderSession =
          !fullReadAnalyzer && context.request.authMode === "codex_app_server"
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
              question:
                input.query ||
                context.request.userText ||
                "Read the full text.",
              batchTokenBudget: Math.max(1024, Math.floor(inputTokenCap * 0.5)),
              finalTokenBudget: Math.max(
                1024,
                Math.floor(inputTokenCap * 0.45),
              ),
              analyzeBatch:
                fullReadAnalyzer || nativeReaderSession?.analyzeBatch,
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
      if (input.mode === "overview") {
        const maxChars = input.maxChars || 6000;
        const results = [];
        const metadataResolver = createZoteroMetadataResolver({
          getItem: (itemId) => zoteroGateway.getItem(itemId),
        });
        for (const paperContext of targets) {
          const mineru = await tryReadMineruOverview(paperContext, maxChars);
          if (mineru && (mineru as { ok?: boolean }).ok !== false) {
            results.push(mineru);
            continue;
          }
          try {
            results.push(
              await pdfService.getOverviewExcerpt({ paperContext, maxChars }),
            );
          } catch (error) {
            const warning = combineWarnings(
              extractWarningText(mineru),
              error instanceof Error ? error.message : String(error),
            );
            const metadataOverview = buildMetadataOverview({
              paperContext,
              metadataResolver,
              warning,
            });
            if (metadataOverview) {
              results.push(metadataOverview);
            } else if (mineru) {
              results.push(mineru);
            } else {
              throw error;
            }
          }
        }
        const overviewQuotePack = buildOverviewQuoteCitationPack(
          results as Array<Record<string, unknown>>,
        );
        return {
          mode: input.mode,
          results: overviewQuotePack.results,
          quoteCitations: overviewQuotePack.quoteCitations,
        };
      }

      if (input.pages?.length) {
        return readExplicitPageTargets({
          input,
          targets,
          context,
          pdfPageService,
        });
      }

      const question = [
        input.query || context.request.userText,
        input.sections?.length
          ? `Relevant sections: ${input.sections.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      for (const paper of targets) {
        await pdfService.ensurePaperContext(paper);
      }
      const results = await retrievalService.retrieveEvidence({
        papers: targets,
        question,
        queryVariants: input.queryVariants,
        model: context.request.model,
        apiBase: context.request.apiBase,
        apiKey: context.request.apiKey,
        authMode: context.request.authMode,
        providerProtocol: context.request.providerProtocol,
        profileOverride: context.request.advanced?.profileOverride,
        topK: input.topK,
        perPaperTopK: input.topK,
      });
      const quoteCitations: QuoteCitation[] = [];
      return {
        mode: input.mode,
        results,
        papers: buildTargetedPaperGroups(
          targets,
          results as Array<Record<string, unknown>>,
          quoteCitations,
        ),
        quoteCitations: mergeQuoteCitations(quoteCitations),
      };
    },
    async buildFollowupMessage(result: AgentToolResult) {
      const content =
        result.content && typeof result.content === "object"
          ? (result.content as { capturedPageIndex?: unknown })
          : null;
      if (content?.capturedPageIndex !== undefined) {
        return buildCaptureFollowupMessage(result);
      }
      return null;
    },
  };
}
