import type { PaperContextRef } from "../../../shared/types";
import type {
  AgentRuntimeRequest,
  AgentToolDefinition,
  AgentTraceDetail,
} from "../../types";
import {
  DEFAULT_SEARCH_SOURCE_ID,
  LiteratureSearchService,
  SEARCH_SOURCES,
  SEARCH_SOURCE_IDS,
  type SearchSourceId,
} from "../../services/literatureSearchService";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import {
  fail,
  normalizePositiveInt,
  normalizeToolPaperContext,
  ok,
  PAPER_CONTEXT_REF_SCHEMA,
  validateObject,
} from "../shared";

type SearchLiteratureOnlineMode =
  | "recommendations"
  | "references"
  | "citations"
  | "search"
  | "metadata";

type SearchLiteratureOnlineInput = {
  mode: SearchLiteratureOnlineMode;
  source?: SearchSourceId;
  itemId?: number;
  paperContext?: PaperContextRef;
  doi?: string;
  title?: string;
  arxivId?: string;
  query?: string;
  author?: string;
  limit?: number;
  libraryID?: number;
};

const LITERATURE_SEARCH_FALLBACK_PATTERN =
  /\b(?:(?:related|similar)\s+(?:papers?|studies|articles?)|(?:find|discover|recommend|search|look up)(?:\s+\S+){0,8}\s+(?:papers?|studies|scholarly articles?|academic literature|research literature)|(?:search|review)\s+(?:the\s+)?literature|literature search|scholarly search|citations?|references?|papers?\s+(?:by|from)|publications?\s+(?:by|from)|doi|arxiv)\b/i;

export function matchesLiteratureSearchGuidance(
  request: Pick<AgentRuntimeRequest, "userText" | "classifiedIntent">,
): boolean {
  const intent = request.classifiedIntent?.externalSearchIntent;
  if (intent !== undefined) {
    return intent === "literature" || intent === "both";
  }
  return LITERATURE_SEARCH_FALLBACK_PATTERN.test(request.userText || "");
}

const GRAPH_CAPABLE_SOURCE_IDS = SEARCH_SOURCE_IDS.filter(
  (id) => SEARCH_SOURCES[id].supportsGraphModes,
);

const SEARCH_ONLY_SOURCE_IDS = SEARCH_SOURCE_IDS.filter(
  (id) => !SEARCH_SOURCES[id].supportsGraphModes,
);

function describeSourceIds(ids: SearchSourceId[]): string {
  return ids
    .map((id) => `source:'${id}' (${SEARCH_SOURCES[id].guidance})`)
    .join(", ");
}

/**
 * Source-selection guidance derived from the SEARCH_SOURCES registry, so the
 * tool spec and the system prompt stay in sync when a source is added.
 */
export const LITERATURE_SOURCE_SELECTION_GUIDANCE =
  "Source selection:" +
  `\n• recommendations, references, citations modes → use ${describeSourceIds(GRAPH_CAPABLE_SOURCE_IDS)}. Other sources only support search.` +
  `\n• search mode → ${describeSourceIds(SEARCH_SOURCE_IDS)}.`;

function readTraceString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildLiteratureTraceUrl(
  result: Record<string, unknown>,
): string | undefined {
  const directUrl =
    readTraceString(result.openAccessUrl) || readTraceString(result.sourceUrl);
  if (directUrl) return directUrl;
  const doi = readTraceString(result.doi)?.replace(
    /^https?:\/\/(?:dx\.)?doi\.org\//i,
    "",
  );
  return doi ? `https://doi.org/${doi}` : undefined;
}

function buildLiteratureTraceCreator(
  paper: Record<string, unknown>,
  patch: Record<string, unknown>,
): string {
  const authors = Array.isArray(paper.authors)
    ? paper.authors.map(readTraceString).filter(Boolean)
    : [];
  if (authors.length) {
    return `${authors[0]}${authors.length > 1 ? " et al." : ""}`;
  }

  const creators = Array.isArray(patch.creators) ? patch.creators : [];
  for (const entry of creators) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const creator = entry as Record<string, unknown>;
    const name =
      readTraceString(creator.name) ||
      [readTraceString(creator.firstName), readTraceString(creator.lastName)]
        .filter(Boolean)
        .join(" ");
    if (name) return name;
  }
  return "Unknown creator";
}

function buildLiteratureTraceYear(
  paper: Record<string, unknown>,
  patch: Record<string, unknown>,
): string {
  if (typeof paper.year === "number" && Number.isFinite(paper.year)) {
    return String(Math.trunc(paper.year));
  }
  const explicitYear = readTraceString(paper.year);
  if (explicitYear && /^\d{4}$/.test(explicitYear)) return explicitYear;
  const date = readTraceString(patch.date);
  return date?.match(/\b\d{4}\b/)?.[0] || "n.d.";
}

function buildLiteratureTraceDetails(
  args: unknown,
  content: unknown,
): AgentTraceDetail[] {
  const input =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const result =
    content && typeof content === "object" && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : {};
  const details: AgentTraceDetail[] = [];
  const query =
    readTraceString(input.query) ||
    readTraceString(input.title) ||
    readTraceString(input.author);
  if (query) details.push({ label: "Query", value: query });

  const results = Array.isArray(result.results) ? result.results : [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const paper = entry as Record<string, unknown>;
    const patch =
      paper.patch &&
      typeof paper.patch === "object" &&
      !Array.isArray(paper.patch)
        ? (paper.patch as Record<string, unknown>)
        : {};
    const title =
      readTraceString(paper.title) ||
      readTraceString(paper.displayTitle) ||
      readTraceString(patch.title);
    if (!title) continue;
    const creator = buildLiteratureTraceCreator(paper, patch);
    const year = buildLiteratureTraceYear(paper, patch);
    const value = `${creator}, ${year}, ${title}`;
    const href = buildLiteratureTraceUrl({ ...patch, ...paper });
    details.push({
      label: "Paper",
      value,
      timeline: { icon: "paper", ...(href ? { href } : {}) },
    });
  }
  return details;
}

export function createSearchLiteratureOnlineTool(
  zoteroGateway: ZoteroGateway,
): AgentToolDefinition<SearchLiteratureOnlineInput, unknown> {
  const service = new LiteratureSearchService(zoteroGateway);
  return {
    spec: {
      name: "search_literature_online",
      description:
        "Search live scholarly sources or fetch canonical external metadata. Results (including ready-to-apply metadata patches from mode:'metadata') return directly; chain library_import, library_update, or note_write yourself to write them into Zotero.",
      inputSchema: {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: {
          mode: {
            type: "string",
            enum: [
              "recommendations",
              "references",
              "citations",
              "search",
              "metadata",
            ],
          },
          source: {
            type: "string",
            enum: SEARCH_SOURCE_IDS,
            description: `Search source. ${GRAPH_CAPABLE_SOURCE_IDS.join(", ")} support all modes; ${SEARCH_ONLY_SOURCE_IDS.join(", ")} only support search mode.`,
          },
          itemId: { type: "number" },
          paperContext: PAPER_CONTEXT_REF_SCHEMA,
          doi: { type: "string" },
          title: { type: "string" },
          arxivId: { type: "string" },
          query: { type: "string" },
          author: {
            type: "string",
            description:
              "Author name to filter results by. When provided alone (without query), returns the author's papers sorted by citation count. When combined with query, narrows keyword results to this author.",
          },
          limit: { type: "number" },
          libraryID: { type: "number" },
        },
      },
      mutability: "read",
      requiresConfirmation: false,
    },
    guidance: {
      matches: matchesLiteratureSearchGuidance,
      instruction:
        "When the request needs external scholarly evidence, use search_literature_online so the model can answer from scholarly results and cite sources. A mixed request may also use web_search for distinct general-web evidence. This tool is read-only: to import papers, apply fetched metadata, or save results to a note, call library_import, library_update (kind:'metadata'), or note_write directly — each shows its own confirmation card. Do not use this tool for questions about the content of papers already in context (e.g. counting references, summarizing, explaining). Preserve the user's language by default." +
        `\n\n${LITERATURE_SOURCE_SELECTION_GUIDANCE}` +
        "\n\nAuthor search:" +
        "\n• When the user wants papers by a specific author, use the 'author' parameter (e.g. author:'Adrien Peyrache')." +
        "\n• You can combine 'author' with 'query' to find an author's papers on a specific topic." +
        "\n• Do NOT put author names in the 'query' parameter — use 'author' instead.",
    },
    presentation: {
      label: "Search Literature Online",
      traceIcon: "library",
      buildTraceDetails: ({ args, content }) =>
        buildLiteratureTraceDetails(args, content),
      summaries: {
        onCall: ({ args }) => {
          const a =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const mode = String(a.mode || "search");
          const author = typeof a.author === "string" ? a.author : undefined;
          const query = typeof a.query === "string" ? a.query : undefined;
          const detail =
            author && query ? `${query} by ${author}` : author || query || mode;
          return `Searching live literature (${detail})`;
        },
        onSuccess: ({ content }) => {
          const results =
            content &&
            typeof content === "object" &&
            Array.isArray((content as { results?: unknown[] }).results)
              ? (content as { results: unknown[] }).results
              : [];
          return results.length > 0
            ? `Found ${results.length} online result${results.length === 1 ? "" : "s"}`
            : "No online results found";
        },
      },
    },
    validate: (args) => {
      if (!validateObject<Record<string, unknown>>(args)) {
        return fail("Expected an object");
      }
      const itemId = normalizePositiveInt(args.itemId);
      const mode =
        args.mode === "recommendations" ||
        args.mode === "references" ||
        args.mode === "citations" ||
        args.mode === "search" ||
        args.mode === "metadata"
          ? (args.mode as SearchLiteratureOnlineMode)
          : null;
      if (!mode) {
        return fail("mode is required");
      }
      const paperContext = validateObject<Record<string, unknown>>(
        args.paperContext,
      )
        ? normalizeToolPaperContext(args.paperContext) || undefined
        : undefined;
      const query =
        typeof args.query === "string" && args.query.trim()
          ? args.query.trim()
          : undefined;
      const title =
        typeof args.title === "string" && args.title.trim()
          ? args.title.trim()
          : undefined;
      const doi =
        typeof args.doi === "string" && args.doi.trim()
          ? args.doi.trim()
          : undefined;
      const arxivId =
        typeof args.arxivId === "string" && args.arxivId.trim()
          ? args.arxivId.trim()
          : undefined;
      if (
        mode === "metadata" &&
        !doi &&
        !title &&
        !arxivId &&
        !query &&
        !itemId &&
        !paperContext
      ) {
        return fail(
          "metadata mode requires doi, title, arxivId, query, itemId, or paperContext",
        );
      }
      const author =
        typeof args.author === "string" && args.author.trim()
          ? args.author.trim()
          : undefined;
      if (mode === "search" && !query && !title && !author) {
        return fail("search mode requires query, title, or author");
      }
      // Graph modes (recommendations / references / citations) need a
      // graph-capable source. Auto-correct anything else to the default to
      // prevent silent degradation.
      const requiresGraphSource =
        mode === "recommendations" ||
        mode === "references" ||
        mode === "citations";
      const rawSource =
        typeof args.source === "string" && args.source in SEARCH_SOURCES
          ? (args.source as SearchSourceId)
          : undefined;
      const source =
        requiresGraphSource &&
        !(rawSource && SEARCH_SOURCES[rawSource].supportsGraphModes)
          ? DEFAULT_SEARCH_SOURCE_ID
          : rawSource;

      return ok<SearchLiteratureOnlineInput>({
        mode,
        source,
        itemId,
        paperContext,
        doi,
        title,
        arxivId,
        query,
        author,
        limit: normalizePositiveInt(args.limit),
        libraryID: normalizePositiveInt(args.libraryID),
      });
    },
    execute: async (input, context) => {
      const results = await service.execute(input, context);
      return {
        mode: input.mode,
        ...((results && typeof results === "object"
          ? results
          : { results }) as object),
      };
    },
  };
}
