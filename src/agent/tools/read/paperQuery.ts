import type { AgentToolContext, AgentToolDefinition } from "../../types";
import type { QuoteCitation } from "../../../shared/types";
import type { PdfService } from "../../services/pdfService";
import type { RetrievalService } from "../../services/retrievalService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { mergeQuoteCitations } from "../../../modules/contextPanel/quoteCitations";
import { fail, ok, PAPER_CONTEXT_REF_SCHEMA, validateObject } from "../shared";
import {
  describeNoDefaultPaperTarget,
  normalizeExplicitTargetSyntax,
  resolveDefaultTargets,
} from "./pdfToolUtils";
import type { PdfTarget } from "./pdfToolUtils";
import {
  buildTargetedPaperGroups,
  countGroupedPassages,
  formatSourcePhrase,
  getUniqueSourceLabels,
  normalizeString,
} from "./paperReadShared";

type PaperQueryInput = {
  target?: PdfTarget;
  targets?: PdfTarget[];
  query: string;
};

const MAX_QUERY_TARGETS = 10;

export function createPaperQueryTool(
  pdfService: PdfService,
  retrievalService: RetrievalService,
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<PaperQueryInput, unknown> {
  return {
    spec: {
      name: "paper_query",
      description:
        "Find passages in papers by what they say: relevance-ranked textual evidence for a natural-language query. Retrieval planning (translations, acronyms, notation variants) happens internally. Use paper_read instead when the location is known (section name, page numbers) or for an overview.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description:
              "What to find, in natural language (e.g. 'how the type dependency graph is built').",
          },
          target: {
            description:
              "Paper(s) to search — one selector or an array. Omit to use the current turn's paper scope.",
            anyOf: [
              {
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
              {
                type: "array",
                minItems: 1,
                maxItems: MAX_QUERY_TARGETS,
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
        },
      },
      mutability: "read",
      requiresConfirmation: false,
      exposure: "model",
      tier: "normal",
    },
    presentation: {
      label: "Query Paper",
      summaries: {
        onCall: ({ args }) => {
          const query = normalizeString(
            (args as Record<string, unknown> | undefined)?.query,
          );
          return query ? `Searching papers for “${query}”` : "Searching papers";
        },
        onPending: "Waiting for your approval before sending document content",
        onApproved: "Approval received - sending document content",
        onDenied: "Paper search cancelled",
        onSuccess: ({ content }) => {
          const c = content as Record<string, unknown> | null;
          const results = Array.isArray(c?.results) ? c.results : undefined;
          const papers = Array.isArray(c?.papers) ? c.papers : undefined;
          const passageCount =
            results?.length ?? (papers ? countGroupedPassages(papers) : 0);
          if (passageCount > 0) {
            const passageLabel = passageCount === 1 ? "passage" : "passages";
            const sourcePhrase = formatSourcePhrase(
              getUniqueSourceLabels(papers || results || []),
              papers?.length,
            );
            return sourcePhrase
              ? `Found ${passageCount} ${passageLabel} in ${sourcePhrase}`
              : `Found ${passageCount} ${passageLabel}`;
          }
          return "No matching passages";
        },
      },
    },
    validate(args) {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      for (const legacyArg of ["mode", "queryVariants", "topK"]) {
        if (Object.prototype.hasOwnProperty.call(args, legacyArg)) {
          return fail(
            `paper_query no longer takes '${legacyArg}'. Provide only target and query; retrieval planning and result count are handled internally.`,
          );
        }
      }
      const query = normalizeString(args.query);
      if (!query) {
        return fail(
          "paper_query requires a query describing what to find in the paper(s).",
        );
      }
      const isTargetArray = Array.isArray(args.target);
      const targetSyntax = normalizeExplicitTargetSyntax({
        targetProvided:
          Object.prototype.hasOwnProperty.call(args, "target") &&
          !isTargetArray,
        target: isTargetArray ? undefined : args.target,
        targetsProvided: isTargetArray,
        targets: isTargetArray ? args.target : undefined,
        mode: "paper",
        maxCount: MAX_QUERY_TARGETS,
      });
      if (targetSyntax.kind === "invalid") {
        return fail(`${targetSyntax.code}: ${targetSyntax.message}`);
      }
      return ok({
        query,
        targets:
          targetSyntax.kind === "paper_selectors"
            ? [...targetSyntax.selectors]
            : undefined,
      } as PaperQueryInput);
    },
    async execute(input, context: AgentToolContext) {
      const targets = resolveDefaultTargets(
        undefined,
        input.targets,
        context,
        zoteroGateway,
        MAX_QUERY_TARGETS,
      );
      if (!targets.length) {
        throw new Error(describeNoDefaultPaperTarget(context.request));
      }
      for (const paper of targets) {
        await pdfService.ensurePaperContext(paper);
      }
      const results = await retrievalService.retrieveEvidence({
        papers: targets,
        question: input.query,
        model: context.request.model,
        apiBase: context.request.apiBase,
        apiKey: context.request.apiKey,
        authMode: context.request.authMode,
        providerProtocol: context.request.providerProtocol,
        profileOverride: context.request.advanced?.profileOverride,
        signal: context.signal,
      });
      const quoteCitations: QuoteCitation[] = [];
      return {
        // "targeted" keeps the result shape identical to the evidence rows
        // downstream ledgers already parse.
        mode: "targeted",
        tool: "paper_query",
        results,
        papers: buildTargetedPaperGroups(
          targets,
          results as Array<Record<string, unknown>>,
          quoteCitations,
        ),
        quoteCitations: mergeQuoteCitations(quoteCitations),
      };
    },
  };
}
