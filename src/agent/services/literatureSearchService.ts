import { config } from "../../../package.json";
import type { PaperContextRef } from "../../shared/types";
import { createRequestThrottle } from "../../utils/requestThrottle";
import type { AgentToolContext } from "../types";
import type { EditableArticleMetadataPatch } from "./zoteroGateway";
import type { ZoteroGateway } from "./zoteroGateway";

type SearchMode =
  | "recommendations"
  | "references"
  | "citations"
  | "search"
  | "metadata";

/** Stable source ids used in tool schemas. */
export type SearchSourceId =
  | "openalex"
  | "arxiv"
  | "europepmc"
  | "dblp"
  | "semanticscholar";

type SearchInput = {
  itemId?: number;
  paperContext?: PaperContextRef;
  doi?: string;
  title?: string;
  arxivId?: string;
  query?: string;
  author?: string;
  mode: SearchMode;
  source?: SearchSourceId;
  limit?: number;
  libraryID?: number;
};

type OnlinePaperResult = {
  title: string;
  authors: string[];
  year?: number;
  abstract?: string;
  doi?: string;
  citationCount?: number;
  openAccessUrl?: string;
  sourceUrl?: string;
};

type ExternalMetadataResult = {
  source: string;
  /** Ready-to-apply Zotero metadata patch — built at the source, not downstream. */
  patch: import("./zoteroGateway").EditableArticleMetadataPatch;
  /** How the result was matched: 'doi' (identifier match), 'title' (title search). */
  matchConfidence?: "doi" | "title";
  /** Supplementary data not in Zotero fields. */
  citationCount?: number;
  /** Display-only fields for review cards. */
  displayTitle?: string;
  displaySubtitle?: string;
};

type LiteratureSearchResult =
  | {
      results: OnlinePaperResult[];
      total?: number;
      source?: string;
      query?: string;
      doi?: string;
      openAlexId?: string | null;
      openAlexUrl?: string;
      warnings?: string[];
      message?: string;
    }
  | {
      results: ExternalMetadataResult[];
      warnings?: string[];
      message?: string;
    };

type FetchJsonResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  /** Optional so hand-rolled test fetch stubs stay valid without it. */
  headers?: { get(name: string): string | null };
};

type FetchTextResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchJsonResponse>;

type FetchTextLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<FetchTextResponse>;

interface XmlElement {
  querySelector(selector: string): XmlElement | null;
  querySelectorAll(selector: string): XmlElement[];
  getAttribute(name: string): string | null;
  textContent: string | null;
}

interface XmlDocument extends XmlElement {
  querySelectorAll(selector: string): XmlElement[];
}

interface XmlDomParser {
  parseFromString(text: string, mimeType: string): XmlDocument;
}

const OA_SELECT =
  "id,doi,display_name,authorships,publication_year,abstract_inverted_index,cited_by_count,open_access";
const OA_MAILTO = "mailto=llm-for-zotero@github.com";
const OA_BASE = "https://api.openalex.org";
const S2_GRAPH_BASE = "https://api.semanticscholar.org/graph/v1";
const S2_RECOMMENDATIONS_BASE =
  "https://api.semanticscholar.org/recommendations/v1";
const S2_PAPER_FIELDS =
  "title,authors,year,abstract,externalIds,citationCount,venue,openAccessPdf";
const USER_AGENT =
  "llm-for-zotero/1.0 (https://github.com/yilewang/llm-for-zotero)";

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Non-2xx fetch outcome. The message keeps the `HTTP <status>` format that
 * existing message-regex checks (e.g. isNotFoundError) rely on; `status` and
 * `retryAfterMs` let callers react to rate limiting instead of re-fetching
 * blindly.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(status: number, retryAfterMs?: number) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse `Retry-After` as delay in ms; seconds form only (S2 sends seconds). */
function parseRetryAfterMs(headers?: { get(name: string): string | null }) {
  const raw = headers?.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.ceil(seconds * 1000);
}

function stripHtmlTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(
  url: string,
  headers?: Record<string, string>,
): Promise<unknown> {
  const response = await (
    globalThis as typeof globalThis & { fetch?: FetchLike }
  ).fetch!(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...headers,
    },
  });
  if (!response.ok) {
    throw new HttpError(response.status, parseRetryAfterMs(response.headers));
  }
  return response.json();
}

/**
 * Use Zotero's privileged HTTP API which bypasses CORS restrictions.
 * This is necessary for external APIs like arXiv and Europe PMC that
 * do not send Access-Control-Allow-Origin headers.
 */
async function zoteroFetchText(url: string): Promise<string> {
  Zotero.debug(`[llm-for-zotero] zoteroFetchText: ${url.slice(0, 120)}...`);
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      headers: { "User-Agent": USER_AGENT },
      responseType: "text",
      timeout: 15000,
    });
    const text = xhr.responseText ?? "";
    Zotero.debug(
      `[llm-for-zotero] zoteroFetchText: status=${xhr.status}, responseLength=${text.length}`,
    );
    return text;
  } catch (error) {
    Zotero.debug(
      `[llm-for-zotero] zoteroFetchText FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

async function zoteroFetchJson(url: string): Promise<unknown> {
  const text = await zoteroFetchText(url);
  try {
    return JSON.parse(text);
  } catch (error) {
    Zotero.debug(
      `[llm-for-zotero] zoteroFetchJson: JSON parse failed, text preview: ${text.slice(0, 200)}`,
    );
    throw new Error(
      `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function oaFetch(url: string): Promise<unknown> {
  const separator = url.includes("?") ? "&" : "?";
  return fetchJson(`${url}${separator}${OA_MAILTO}`);
}

/**
 * Read the optional Semantic Scholar API key at request time so preference
 * changes apply without a restart. Without a key, requests run unauthenticated
 * against S2's shared public rate pool.
 */
export function getSemanticScholarApiKey(): string {
  try {
    return String(
      Zotero.Prefs.get(`${config.prefsPrefix}.semanticScholarApiKey`, true) ||
        "",
    ).trim();
  } catch {
    return "";
  }
}

export function setSemanticScholarApiKey(value: string): void {
  Zotero.Prefs.set(
    `${config.prefsPrefix}.semanticScholarApiKey`,
    value.trim(),
    true,
  );
}

/**
 * S2 throttles at ~1 req/s for both the shared public pool and free-tier
 * keys, and the agent can fan out several searches (e.g. discover-related
 * fires three graph calls at once). Serialize every S2 request through one
 * queue paced above 1 req/s, and back off on 429 instead of failing fast.
 */
const S2_MIN_REQUEST_INTERVAL_MS = 1100;
const S2_RETRY_DELAYS_MS = [1000, 3000];
/** Retry-After can ask for very long waits; give up beyond this. */
const S2_MAX_BACKOFF_MS = 30_000;

const s2Throttle = createRequestThrottle(S2_MIN_REQUEST_INTERVAL_MS);
let s2RetryDelaysForTests: readonly number[] | null = null;

/** Test seam: drop pacing and pending backoff state so tests don't wait. */
export function resetS2ThrottleForTests(): void {
  s2Throttle.setInterval(0);
  s2Throttle.reset();
  s2RetryDelaysForTests = null;
}

/** Test seam: observe real pacing with a small interval before resetting. */
export function setS2ThrottleIntervalForTests(ms: number): void {
  s2Throttle.setInterval(ms);
}

/** Test seam: inject backoff delays (null restores production values). */
export function setS2RetryDelaysForTests(delays: readonly number[] | null) {
  s2RetryDelaysForTests = delays;
}

function s2BackoffDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, S2_MAX_BACKOFF_MS);
  }
  const delays = s2RetryDelaysForTests ?? S2_RETRY_DELAYS_MS;
  return delays[Math.min(attempt, delays.length - 1)] ?? S2_RETRY_DELAYS_MS[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function s2FetchJson(url: string): Promise<unknown> {
  const apiKey = getSemanticScholarApiKey();
  const headers = apiKey ? { "x-api-key": apiKey } : undefined;
  const maxAttempts = (s2RetryDelaysForTests ?? S2_RETRY_DELAYS_MS).length + 1;
  return s2Throttle.run(async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetchJson(url, headers);
      } catch (error) {
        if (
          error instanceof HttpError &&
          error.status === 429 &&
          attempt < maxAttempts
        ) {
          await sleep(s2BackoffDelayMs(attempt - 1, error.retryAfterMs));
          continue;
        }
        throw error;
      }
    }
  });
}

/** fetchJson throws `HTTP <status>`; S2 signals unknown identifiers with 404. */
function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && /\bHTTP 404\b/.test(error.message);
}

function reconstructAbstract(invertedIndex: unknown): string {
  if (
    !invertedIndex ||
    typeof invertedIndex !== "object" ||
    Array.isArray(invertedIndex)
  ) {
    return "";
  }
  const entries: Array<[string, number]> = [];
  for (const [word, positions] of Object.entries(
    invertedIndex as Record<string, unknown>,
  )) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (typeof position === "number") {
        entries.push([word, position]);
      }
    }
  }
  entries.sort((left, right) => left[1] - right[1]);
  return entries
    .map(([word]) => word)
    .join(" ")
    .trim();
}

function normalizeOpenAlexWork(raw: unknown): OnlinePaperResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const work = raw as Record<string, unknown>;
  const title = normalizeString(work.display_name);
  if (!title) {
    return null;
  }

  const authorships = Array.isArray(work.authorships) ? work.authorships : [];
  const authors = authorships
    .map((entry) => {
      const author = (entry as Record<string, unknown>)?.author;
      return normalizeString((author as Record<string, unknown>)?.display_name);
    })
    .filter(Boolean);

  const year =
    typeof work.publication_year === "number" && work.publication_year > 0
      ? work.publication_year
      : undefined;
  const abstractText = reconstructAbstract(work.abstract_inverted_index);
  const abstract = abstractText
    ? `${abstractText.slice(0, 400)}${abstractText.length > 400 ? "..." : ""}`
    : undefined;
  const doiUrl = normalizeString(work.doi);
  const doi = doiUrl.startsWith("https://doi.org/")
    ? doiUrl.slice("https://doi.org/".length)
    : doiUrl || undefined;
  const citationCount =
    typeof work.cited_by_count === "number" ? work.cited_by_count : undefined;
  const openAccess = work.open_access as
    | Record<string, unknown>
    | null
    | undefined;
  const openAccessUrl = normalizeString(openAccess?.oa_url) || undefined;
  const openAlexId = normalizeString(work.id) || undefined;

  return {
    title,
    authors,
    year,
    abstract,
    doi,
    citationCount,
    openAccessUrl,
    sourceUrl: openAlexId,
  };
}

function extractOpenAlexId(url: string): string | null {
  const match = /\/(W\d+)$/.exec(url.trim());
  return match?.[1] ?? null;
}

async function resolveOpenAlexWork(
  doi: string,
): Promise<Record<string, unknown> | null> {
  try {
    const encodedDoi = encodeURIComponent(`https://doi.org/${doi}`);
    const raw = (await oaFetch(
      `${OA_BASE}/works/${encodedDoi}?select=${OA_SELECT},related_works,referenced_works`,
    )) as Record<string, unknown>;
    return raw ?? null;
  } catch (err) {
    ztoolkit.log("LLM: OpenAlex DOI fetch failed", err);
    return null;
  }
}

async function batchFetchWorks(
  ids: string[],
  limit: number,
): Promise<OnlinePaperResult[]> {
  const slice = ids.slice(0, limit);
  if (!slice.length) {
    return [];
  }
  const filter = `openalex:${slice.join("|")}`;
  const raw = (await oaFetch(
    `${OA_BASE}/works?filter=${encodeURIComponent(filter)}&select=${OA_SELECT}&per-page=${slice.length}`,
  )) as { results?: unknown[] };
  return (raw.results ?? [])
    .map(normalizeOpenAlexWork)
    .filter((paper): paper is OnlinePaperResult => Boolean(paper));
}

async function fetchRelated(
  work: Record<string, unknown>,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const relatedUrls = Array.isArray(work.related_works)
    ? (work.related_works as string[])
    : [];
  const ids = relatedUrls
    .map(extractOpenAlexId)
    .filter((id): id is string => Boolean(id));
  return batchFetchWorks(ids, limit);
}

async function fetchReferences(
  work: Record<string, unknown>,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const referenceUrls = Array.isArray(work.referenced_works)
    ? (work.referenced_works as string[])
    : [];
  const ids = referenceUrls
    .map(extractOpenAlexId)
    .filter((id): id is string => Boolean(id));
  return batchFetchWorks(ids, limit);
}

async function fetchCitations(
  openAlexId: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const raw = (await oaFetch(
    `${OA_BASE}/works?filter=cites:${encodeURIComponent(openAlexId)}&sort=cited_by_count:desc&select=${OA_SELECT}&per-page=${limit}`,
  )) as { results?: unknown[] };
  return (raw.results ?? [])
    .map(normalizeOpenAlexWork)
    .filter((paper): paper is OnlinePaperResult => Boolean(paper));
}

async function fetchKeywordSearch(
  query: string,
  limit: number,
  author?: string,
): Promise<OnlinePaperResult[]> {
  let url = `${OA_BASE}/works?search=${encodeURIComponent(query)}&select=${OA_SELECT}&per-page=${limit}`;
  if (author) {
    url += `&filter=raw_author_name.search:${encodeURIComponent(author)}`;
  }
  const raw = (await oaFetch(url)) as { results?: unknown[] };
  return (raw.results ?? [])
    .map(normalizeOpenAlexWork)
    .filter((paper): paper is OnlinePaperResult => Boolean(paper));
}

async function fetchAuthorSearch(
  author: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const raw = (await oaFetch(
    `${OA_BASE}/works?filter=raw_author_name.search:${encodeURIComponent(author)}&sort=cited_by_count:desc&select=${OA_SELECT}&per-page=${limit}`,
  )) as { results?: unknown[] };
  return (raw.results ?? [])
    .map(normalizeOpenAlexWork)
    .filter((paper): paper is OnlinePaperResult => Boolean(paper));
}

async function fetchArxivSearch(
  query: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const url =
    `https://export.arxiv.org/api/query` +
    `?search_query=all:${encodeURIComponent(query)}` +
    `&start=0&max_results=${limit}&sortBy=relevance&sortOrder=descending`;
  const xmlText = await zoteroFetchText(url);
  if (!(globalThis as Record<string, unknown>).DOMParser) {
    throw new Error("DOMParser is not available in this environment");
  }
  // Strip the default Atom namespace so querySelectorAll matches bare element
  // names. Gecko-based DOMParser (used by Zotero) treats namespaced elements
  // as unreachable via plain CSS selectors like querySelectorAll("entry").
  const cleanXml = xmlText.replace(/\s+xmlns="[^"]*"/g, "");
  const domParser = new (
    globalThis as typeof globalThis & { DOMParser: new () => XmlDomParser }
  ).DOMParser();
  let doc: XmlDocument;
  try {
    doc = domParser.parseFromString(
      cleanXml,
      "text/xml",
    ) as unknown as XmlDocument;
  } catch (parseError) {
    throw new Error(
      `Failed to parse arXiv XML response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
    );
  }
  const entries = doc.querySelectorAll("entry");
  if (!entries.length && xmlText.length > 200) {
    // The XML had content but no entries were parsed — likely a parsing issue.
    throw new Error(
      `arXiv returned XML (${xmlText.length} chars) but no entries could be parsed`,
    );
  }
  const results: OnlinePaperResult[] = [];

  for (const entry of entries) {
    const title = entry
      .querySelector("title")
      ?.textContent?.trim()
      .replace(/\s+/g, " ");
    if (!title) {
      continue;
    }
    const abstractText = entry
      .querySelector("summary")
      ?.textContent?.trim()
      .replace(/\s+/g, " ");
    const abstract = abstractText
      ? `${abstractText.slice(0, 400)}${abstractText.length > 400 ? "..." : ""}`
      : undefined;
    const publishedValue =
      entry.querySelector("published")?.textContent?.trim() ?? "";
    const year = publishedValue
      ? parseInt(publishedValue.slice(0, 4), 10) || undefined
      : undefined;
    const authors: string[] = [];
    for (const author of entry.querySelectorAll("author")) {
      const name = author.querySelector("name")?.textContent?.trim();
      if (name) {
        authors.push(name);
      }
    }
    const sourceUrl =
      entry.querySelector("id")?.textContent?.trim() ?? undefined;
    const linkNodes = entry.querySelectorAll("link");
    let pdfLink: string | undefined;
    for (const node of linkNodes) {
      if (node.getAttribute("type") === "application/pdf") {
        pdfLink = node.getAttribute("href") ?? undefined;
        break;
      }
    }
    const doi = entry.querySelector("doi")?.textContent?.trim() || undefined;
    results.push({
      title,
      authors,
      year,
      abstract,
      doi,
      sourceUrl,
      openAccessUrl: pdfLink || sourceUrl,
    });
  }

  return results;
}

async function fetchEuropePmcSearch(
  query: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const url =
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search` +
    `?query=${encodeURIComponent(query)}` +
    `&format=json&pageSize=${limit}&resultType=core`;
  let raw: unknown;
  try {
    raw = await zoteroFetchJson(url);
  } catch (error) {
    throw new Error(
      `Europe PMC API request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = raw as {
    resultList?: { result?: Array<Record<string, unknown>> };
  };
  const items = body.resultList?.result ?? [];
  if (!items.length && raw && typeof raw === "object") {
    // Check if we got an error response or unexpected structure
    const keys = Object.keys(raw as Record<string, unknown>);
    if (!keys.includes("resultList")) {
      throw new Error(
        `Europe PMC returned unexpected response structure (keys: ${keys.slice(0, 5).join(", ")})`,
      );
    }
  }
  return items
    .map((item): OnlinePaperResult | null => {
      const title = typeof item.title === "string" ? item.title.trim() : "";
      if (!title) {
        return null;
      }

      const authorString =
        typeof item.authorString === "string" ? item.authorString.trim() : "";
      const authors = authorString
        ? authorString
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [];
      const yearRaw = item.pubYear ?? item.firstPublicationDate;
      const year =
        typeof yearRaw === "string"
          ? parseInt(yearRaw.slice(0, 4), 10) || undefined
          : typeof yearRaw === "number"
            ? yearRaw
            : undefined;
      const abstractText =
        typeof item.abstractText === "string" ? item.abstractText.trim() : "";
      const abstract = abstractText
        ? `${abstractText.slice(0, 400)}${abstractText.length > 400 ? "..." : ""}`
        : undefined;
      const doi =
        typeof item.doi === "string" && item.doi.trim()
          ? item.doi.trim()
          : undefined;
      const citationCount =
        typeof item.citedByCount === "number" ? item.citedByCount : undefined;
      const paperId = typeof item.id === "string" ? item.id.trim() : undefined;
      const sourceUrl = paperId
        ? `https://europepmc.org/article/${item.source ?? "MED"}/${paperId}`
        : doi
          ? `https://doi.org/${doi}`
          : undefined;
      const urlList =
        (
          item.fullTextUrlList as
            | { fullTextUrl?: Array<{ url: string }> }
            | undefined
        )?.fullTextUrl ?? [];
      const openAccessUrl =
        urlList[0]?.url || (doi ? `https://doi.org/${doi}` : undefined);
      return {
        title,
        authors,
        year,
        abstract,
        doi,
        citationCount,
        sourceUrl,
        openAccessUrl,
      };
    })
    .filter((paper): paper is OnlinePaperResult => Boolean(paper));
}

/**
 * Normalize one DBLP hit's `info.authors.author`, which is a string, a single
 * `{ "@pid", "text" }` object, or an array mixing both — depending on author
 * count and DBLP's serialization mood.
 */
function normalizeDblpAuthors(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw
    .map((entry) =>
      typeof entry === "string"
        ? entry.trim()
        : normalizeString((entry as Record<string, unknown>)?.text),
    )
    .filter(Boolean);
}

async function fetchDblpSearch(
  query: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const url =
    `https://dblp.org/search/publ/api` +
    `?q=${encodeURIComponent(query)}&format=json&h=${limit}`;
  let raw: unknown;
  try {
    raw = await zoteroFetchJson(url);
  } catch (error) {
    throw new Error(
      `DBLP API request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = raw as {
    result?: { hits?: { hit?: unknown } };
  };
  const hit = body.result?.hits?.hit;
  const entries = (Array.isArray(hit) ? hit : hit ? [hit] : []) as Array<{
    info?: Record<string, unknown>;
  }>;
  return entries
    .map((entry): OnlinePaperResult | null => {
      const info = entry.info;
      const title = normalizeString(info?.title);
      if (!title) {
        return null;
      }
      const authors = normalizeDblpAuthors(
        (info?.authors as Record<string, unknown> | undefined)?.author,
      );
      const yearRaw = normalizeString(info?.year);
      const year = yearRaw
        ? parseInt(yearRaw.slice(0, 4), 10) || undefined
        : undefined;
      const doiUrl = normalizeString(info?.doi);
      const doi = doiUrl.startsWith("https://doi.org/")
        ? doiUrl.slice("https://doi.org/".length)
        : doiUrl || undefined;
      const ee = info?.ee;
      const eeList = Array.isArray(ee) ? ee : ee ? [ee] : [];
      const openAccessUrl = normalizeString(eeList[0]) || undefined;
      const sourceUrl = normalizeString(info?.url) || openAccessUrl;
      return {
        title,
        authors,
        year,
        doi,
        sourceUrl,
        openAccessUrl,
      };
    })
    .filter((paper): paper is OnlinePaperResult => Boolean(paper));
}

function normalizeSemanticScholarPaper(raw: unknown): OnlinePaperResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const paper = raw as Record<string, unknown>;
  const title = normalizeString(paper.title);
  if (!title) {
    return null;
  }
  const authorList = Array.isArray(paper.authors)
    ? (paper.authors as Array<{ name?: string }>)
    : [];
  const authors = authorList
    .map((author) => normalizeString(author.name))
    .filter(Boolean);
  const year = typeof paper.year === "number" ? paper.year : undefined;
  const abstractText = normalizeString(paper.abstract);
  const abstract = abstractText
    ? `${abstractText.slice(0, 400)}${abstractText.length > 400 ? "..." : ""}`
    : undefined;
  const externalIds = (paper.externalIds || {}) as Record<string, string>;
  const doi = externalIds.DOI || externalIds.doi || undefined;
  const citationCount =
    typeof paper.citationCount === "number" ? paper.citationCount : undefined;
  const openAccessPdf = paper.openAccessPdf as
    | { url?: string }
    | null
    | undefined;
  const openAccessUrl = normalizeString(openAccessPdf?.url) || undefined;
  const sourceUrl = doi
    ? `https://doi.org/${doi}`
    : normalizeString(paper.paperId)
      ? `https://www.semanticscholar.org/paper/${normalizeString(paper.paperId)}`
      : undefined;
  return {
    title,
    authors,
    year,
    abstract,
    doi,
    citationCount,
    openAccessUrl,
    sourceUrl,
  };
}

/**
 * Resolve a Semantic Scholar paper ID for graph queries (references /
 * citations / recommendations). DOI and arXiv IDs map directly; a bare title
 * goes through S2's match endpoint, which returns the single best match.
 */
async function resolveSemanticScholarPaperId(params: {
  doi?: string;
  arxivId?: string;
  title?: string;
}): Promise<string | null> {
  if (params.doi) {
    return `DOI:${params.doi.replace(/^https?:\/\/doi\.org\//i, "")}`;
  }
  if (params.arxivId) {
    return `ARXIV:${params.arxivId.replace(/^arxiv:/i, "")}`;
  }
  if (!params.title) {
    return null;
  }
  try {
    const raw = (await s2FetchJson(
      `${S2_GRAPH_BASE}/paper/search/match?query=${encodeURIComponent(params.title)}&fields=paperId`,
    )) as { data?: Array<{ paperId?: string }> };
    const paperId = normalizeString(raw.data?.[0]?.paperId);
    return paperId || null;
  } catch (err) {
    ztoolkit.log("LLM: Semantic Scholar title match failed", err);
    return null;
  }
}

async function fetchSemanticScholarSearch(
  query: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const raw = (await s2FetchJson(
    `${S2_GRAPH_BASE}/paper/search?query=${encodeURIComponent(query)}&fields=${S2_PAPER_FIELDS}&limit=${limit}`,
  )) as { data?: unknown[] };
  return (raw.data ?? [])
    .map(normalizeSemanticScholarPaper)
    .filter((paper): paper is OnlinePaperResult => Boolean(paper));
}

async function fetchSemanticScholarGraph(
  kind: "references" | "citations",
  paperId: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const raw = (await s2FetchJson(
    `${S2_GRAPH_BASE}/paper/${encodeURIComponent(paperId)}/${kind}?fields=${S2_PAPER_FIELDS}&limit=${limit}`,
  )) as { data?: Array<Record<string, unknown>> };
  const key = kind === "references" ? "citedPaper" : "citingPaper";
  return (raw.data ?? [])
    .map((entry) => normalizeSemanticScholarPaper(entry[key]))
    .filter((paper): paper is OnlinePaperResult => Boolean(paper));
}

async function fetchSemanticScholarRecommendations(
  paperId: string,
  limit: number,
): Promise<OnlinePaperResult[]> {
  const raw = (await s2FetchJson(
    `${S2_RECOMMENDATIONS_BASE}/papers/forpaper/${encodeURIComponent(paperId)}?fields=${S2_PAPER_FIELDS}&limit=${limit}`,
  )) as { recommendedPapers?: unknown[] };
  return (raw.recommendedPapers ?? [])
    .map(normalizeSemanticScholarPaper)
    .filter((paper): paper is OnlinePaperResult => Boolean(paper));
}

function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isActivePaper(
  activeDoi: string | undefined,
  activeTitleKey: string | undefined,
  result: OnlinePaperResult,
): boolean {
  if (activeDoi && result.doi) {
    if (activeDoi.trim().toLowerCase() === result.doi.trim().toLowerCase()) {
      return true;
    }
  }
  if (activeTitleKey && activeTitleKey.length > 20) {
    const resultKey = normalizeTitleKey(result.title);
    if (resultKey === activeTitleKey) {
      return true;
    }
    if (
      resultKey.startsWith(activeTitleKey) ||
      activeTitleKey.startsWith(resultKey)
    ) {
      return true;
    }
  }
  return false;
}

async function lookupCrossRefByDoi(
  doi: string,
): Promise<ExternalMetadataResult | null> {
  try {
    const encodedDoi = encodeURIComponent(doi);
    const data = (await fetchJson(
      `https://api.crossref.org/works/${encodedDoi}`,
    )) as { message?: Record<string, unknown> };
    const message = data?.message;
    if (!message) {
      return null;
    }
    const titleList = Array.isArray(message.title)
      ? (message.title as string[])
      : [];
    const authorList = Array.isArray(message.author)
      ? (message.author as Array<{
          given?: string;
          family?: string;
          name?: string;
        }>)
      : [];
    const authors = authorList
      .map((author) =>
        author.name
          ? author.name
          : [author.given, author.family].filter(Boolean).join(" "),
      )
      .filter(Boolean);
    const published = (message["published-print"] ||
      message["published-online"] ||
      message.published ||
      message.issued ||
      message.created) as { "date-parts"?: number[][] } | undefined;
    const year = published?.["date-parts"]?.[0]?.[0];
    const containerTitle = Array.isArray(message["container-title"])
      ? (message["container-title"] as string[])
      : [];
    const abstractText = normalizeString(message.abstract);
    const title = titleList[0] ? stripHtmlTags(titleList[0]) : undefined;
    const abstract = abstractText
      ? stripHtmlTags(abstractText).slice(0, 600)
      : undefined;
    const venue = containerTitle[0]
      ? stripHtmlTags(containerTitle[0])
      : undefined;
    const resolvedDoi = normalizeString(message.DOI) || doi;
    const url = normalizeString(message.URL) || undefined;
    const patch: EditableArticleMetadataPatch = {};
    if (title) patch.title = title;
    if (resolvedDoi) patch.DOI = resolvedDoi;
    if (abstract) patch.abstractNote = abstract;
    if (year) patch.date = String(year);
    if (venue) patch.publicationTitle = venue;
    if (url) patch.url = url;
    if (authors.length) {
      patch.creators = authors.map((name) => ({
        creatorType: "author",
        name,
        fieldMode: 1 as 0 | 1,
      }));
    }
    const yearStr = year ? String(year) : undefined;
    const authorLabel =
      authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : "");
    return {
      source: "CrossRef",
      patch,
      displayTitle: title,
      displaySubtitle:
        [yearStr, authorLabel, venue].filter(Boolean).join(" · ") || undefined,
    };
  } catch (err) {
    ztoolkit.log("LLM: CrossRef metadata fetch failed", err);
    return null;
  }
}

async function searchCrossRef(
  query: string,
): Promise<ExternalMetadataResult[]> {
  try {
    const encoded = encodeURIComponent(query);
    const data = (await fetchJson(
      `https://api.crossref.org/works?query.bibliographic=${encoded}&rows=3&select=DOI,title,author,published-print,published-online,abstract,container-title,type,URL`,
    )) as { message?: { items?: unknown[] } };
    const items = data?.message?.items;
    if (!Array.isArray(items)) {
      return [];
    }
    return items
      .map((item) => {
        const message = item as Record<string, unknown>;
        const titleList = Array.isArray(message.title)
          ? (message.title as string[])
          : [];
        const authorList = Array.isArray(message.author)
          ? (message.author as Array<{
              given?: string;
              family?: string;
              name?: string;
            }>)
          : [];
        const authors = authorList
          .map((author) =>
            author.name
              ? author.name
              : [author.given, author.family].filter(Boolean).join(" "),
          )
          .filter(Boolean);
        const published = (message["published-print"] ||
          message["published-online"] ||
          message.published ||
          message.issued ||
          message.created) as { "date-parts"?: number[][] } | undefined;
        const year = published?.["date-parts"]?.[0]?.[0];
        const containerTitle = Array.isArray(message["container-title"])
          ? (message["container-title"] as string[])
          : [];
        const abstractText = normalizeString(message.abstract);
        const doi = normalizeString(message.DOI);
        const title = titleList[0] ? stripHtmlTags(titleList[0]) : undefined;
        const abstract = abstractText
          ? stripHtmlTags(abstractText).slice(0, 600)
          : undefined;
        const venue = containerTitle[0]
          ? stripHtmlTags(containerTitle[0])
          : undefined;
        const url = normalizeString(message.URL) || undefined;
        const patch: EditableArticleMetadataPatch = {};
        if (title) patch.title = title;
        if (doi) patch.DOI = doi;
        if (abstract) patch.abstractNote = abstract;
        if (year) patch.date = String(year);
        if (venue) patch.publicationTitle = venue;
        if (url) patch.url = url;
        if (authors.length) {
          patch.creators = authors.map((name) => ({
            creatorType: "author",
            name,
            fieldMode: 1 as 0 | 1,
          }));
        }
        const yearStr = year ? String(year) : undefined;
        const authorLabel =
          authors.slice(0, 3).join(", ") +
          (authors.length > 3 ? " et al." : "");
        return {
          source: "CrossRef",
          patch,
          displayTitle: title,
          displaySubtitle:
            [yearStr, authorLabel, venue].filter(Boolean).join(" · ") ||
            undefined,
        } satisfies ExternalMetadataResult;
      })
      .filter((result) => result.displayTitle || result.patch.DOI);
  } catch {
    return [];
  }
}

async function lookupSemanticScholar(params: {
  doi?: string;
  title?: string;
  arxivId?: string;
}): Promise<ExternalMetadataResult | null> {
  try {
    const fields =
      "title,authors,year,abstract,externalIds,citationCount,venue,publicationTypes,openAccessPdf";
    let url: string;
    if (params.doi) {
      url = `${S2_GRAPH_BASE}/paper/DOI:${encodeURIComponent(params.doi)}?fields=${fields}`;
    } else if (params.arxivId) {
      const cleaned = params.arxivId.replace(/^arxiv:/i, "");
      url = `${S2_GRAPH_BASE}/paper/ARXIV:${encodeURIComponent(cleaned)}?fields=${fields}`;
    } else if (params.title) {
      const encoded = encodeURIComponent(params.title);
      url = `${S2_GRAPH_BASE}/paper/search?query=${encoded}&fields=${fields}&limit=1`;
    } else {
      return null;
    }

    const raw = (await s2FetchJson(url)) as Record<string, unknown>;
    const paper =
      params.doi || params.arxivId
        ? raw
        : (raw as { data?: unknown[] }).data?.[0];
    if (!paper || typeof paper !== "object") {
      return null;
    }

    const result = paper as Record<string, unknown>;
    const authorList = Array.isArray(result.authors)
      ? (result.authors as Array<{ name?: string }>)
      : [];
    const authors = authorList
      .map((author) => normalizeString(author.name))
      .filter(Boolean);
    const externalIds = (result.externalIds || {}) as Record<string, string>;
    const publicationTypes = Array.isArray(result.publicationTypes)
      ? (result.publicationTypes as string[]).join(", ")
      : undefined;

    const title = normalizeString(result.title) || undefined;
    const doi = externalIds.DOI || externalIds.doi || params.doi || undefined;
    const year = typeof result.year === "number" ? result.year : undefined;
    const abstract =
      normalizeString(result.abstract).slice(0, 600) || undefined;
    const venue = normalizeString(result.venue) || undefined;
    const patch: EditableArticleMetadataPatch = {};
    if (title) patch.title = title;
    if (doi) patch.DOI = doi;
    if (abstract) patch.abstractNote = abstract;
    if (year) patch.date = String(year);
    if (venue) patch.publicationTitle = venue;
    if (authors.length) {
      patch.creators = authors.map((name) => ({
        creatorType: "author",
        name,
        fieldMode: 1 as 0 | 1,
      }));
    }
    const yearStr = year ? String(year) : undefined;
    const authorLabel =
      authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : "");
    return {
      source: "Semantic Scholar",
      patch,
      citationCount:
        typeof result.citationCount === "number"
          ? result.citationCount
          : undefined,
      displayTitle: title,
      displaySubtitle:
        [yearStr, authorLabel, venue].filter(Boolean).join(" · ") || undefined,
    };
  } catch {
    return null;
  }
}

/** Everything a source needs to execute one search, resolved by the service. */
export type SearchSourceRunContext = {
  mode: Exclude<SearchMode, "metadata">;
  /** User query, or the seed paper's title as fallback. */
  query?: string;
  title?: string;
  author?: string;
  arxivId?: string;
  doi?: string;
  titleFallback?: string;
  limit: number;
  /** Drops the seed paper itself from result sets. */
  dedupe: (results: OnlinePaperResult[]) => OnlinePaperResult[];
};

export type SearchSourceDefinition = {
  id: SearchSourceId;
  /** Human-facing label in results and logs. */
  label: string;
  /** Short guidance fragment describing the source's scope. */
  guidance: string;
  /** Whether the source supports recommendations/references/citations modes. */
  supportsGraphModes: boolean;
  run: (ctx: SearchSourceRunContext) => Promise<LiteratureSearchResult>;
};

/**
 * Factory for search-only sources (keyword in, paper list out) — arXiv,
 * Europe PMC, DBLP all share this shape, so their branches collapse into
 * one descriptor each.
 */
function createSearchOnlySource(config: {
  id: SearchSourceId;
  label: string;
  guidance: string;
  fetchPapers: (query: string, limit: number) => Promise<OnlinePaperResult[]>;
}): SearchSourceDefinition {
  const { id, label, guidance, fetchPapers } = config;
  return {
    id,
    label,
    guidance,
    supportsGraphModes: false,
    async run({ query, limit, dedupe }) {
      if (!query) {
        return {
          results: [],
          message: `No search query available for ${label}.`,
        };
      }
      try {
        Zotero.debug(
          `[llm-for-zotero] ${label} search: query="${query}", limit=${limit}`,
        );
        const results = dedupe(await fetchPapers(query, limit));
        Zotero.debug(
          `[llm-for-zotero] ${label} search returned ${results.length} results`,
        );
        return { results, total: results.length, source: label, query };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        Zotero.debug(`[llm-for-zotero] ${label} search failed: ${msg}`);
        return {
          results: [],
          source: label,
          query,
          message: `${label} search failed: ${msg}`,
        };
      }
    },
  };
}

const openAlexSource: SearchSourceDefinition = {
  id: "openalex",
  label: "OpenAlex",
  guidance: "broadest cross-domain coverage",
  supportsGraphModes: true,
  async run({ mode, query, author, doi, titleFallback, limit, dedupe }) {
    if (mode === "search") {
      if (!query && !author) {
        return { results: [], message: "No search query available." };
      }
      try {
        let results: OnlinePaperResult[];
        if (query) {
          results = dedupe(await fetchKeywordSearch(query, limit, author));
        } else {
          results = dedupe(await fetchAuthorSearch(author!, limit));
        }
        return {
          results,
          total: results.length,
          source: "OpenAlex",
          query: query || `author:${author}`,
        };
      } catch (error) {
        return {
          results: [],
          source: "OpenAlex",
          query: query || `author:${author}`,
          message: `OpenAlex search failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    if (!doi) {
      if (titleFallback) {
        const results = dedupe(await fetchKeywordSearch(titleFallback, limit));
        return {
          results,
          total: results.length,
          source: "OpenAlex",
          query: titleFallback,
          warnings: [
            "DOI unavailable; returned keyword search results instead.",
          ],
        };
      }
      throw new Error(
        "No DOI found for the active paper. Provide a doi or query explicitly.",
      );
    }

    const work = await resolveOpenAlexWork(doi);
    if (!work) {
      if (titleFallback) {
        const results = dedupe(await fetchKeywordSearch(titleFallback, limit));
        return {
          results,
          total: results.length,
          source: "OpenAlex",
          query: titleFallback,
          warnings: [
            "Paper not found on OpenAlex by DOI; returned keyword search results instead.",
          ],
        };
      }
      throw new Error(`Paper with DOI "${doi}" was not found on OpenAlex.`);
    }

    const openAlexId = normalizeString(work.id) || null;
    let results: OnlinePaperResult[] = [];
    const warnings: string[] = [];

    if (mode === "recommendations") {
      results = dedupe(await fetchRelated(work, limit));
      if (results.length === 0 && titleFallback) {
        results = dedupe(await fetchKeywordSearch(titleFallback, limit));
        warnings.push(
          "OpenAlex had no related works yet; returned keyword search results instead.",
        );
        return {
          results,
          total: results.length,
          source: "OpenAlex",
          query: titleFallback,
          doi,
          openAlexId,
          warnings,
        };
      }
    } else if (mode === "references") {
      results = dedupe(await fetchReferences(work, limit));
    } else {
      if (!openAlexId) {
        throw new Error("Could not determine OpenAlex ID to query citations.");
      }
      results = dedupe(await fetchCitations(openAlexId, limit));
    }

    return {
      results,
      total: results.length,
      source: "OpenAlex",
      doi,
      openAlexId,
      openAlexUrl: openAlexId || undefined,
      ...(warnings.length ? { warnings } : {}),
    };
  },
};

const semanticScholarSource: SearchSourceDefinition = {
  id: "semanticscholar",
  label: "Semantic Scholar",
  guidance:
    "default; best citation graph for CS/ML, includes arXiv preprints and their citing works",
  supportsGraphModes: true,
  async run({ mode, query, title, arxivId, doi, limit, dedupe }) {
    try {
      Zotero.debug(
        `[llm-for-zotero] Semantic Scholar search: mode=${mode}, limit=${limit}`,
      );
      if (mode === "search") {
        if (!query) {
          return {
            results: [],
            message: "No search query available for Semantic Scholar.",
          };
        }
        const results = dedupe(await fetchSemanticScholarSearch(query, limit));
        return {
          results,
          total: results.length,
          source: "Semantic Scholar",
          query,
        };
      }

      // Graph modes (references / citations / recommendations) need a seed
      // paper, resolved from DOI, arXiv ID, or title match.
      const keywordFallback = async (
        warning: string,
      ): Promise<LiteratureSearchResult> => {
        const results = dedupe(await fetchSemanticScholarSearch(query!, limit));
        return {
          results,
          total: results.length,
          source: "Semantic Scholar",
          query,
          warnings: [warning],
        };
      };

      const fetchGraph = (id: string): Promise<OnlinePaperResult[]> =>
        mode === "recommendations"
          ? fetchSemanticScholarRecommendations(id, limit)
          : fetchSemanticScholarGraph(
              mode === "references" ? "references" : "citations",
              id,
              limit,
            );

      const paperId = await resolveSemanticScholarPaperId({
        doi,
        arxivId,
        title: title || query,
      });
      if (!paperId) {
        if (query) {
          return keywordFallback(
            "Could not resolve the paper on Semantic Scholar; returned keyword search results instead.",
          );
        }
        throw new Error(
          "No DOI, arXiv ID, or title available to resolve the paper on Semantic Scholar.",
        );
      }

      let results: OnlinePaperResult[];
      try {
        results = dedupe(await fetchGraph(paperId));
      } catch (error) {
        // S2 answers 404 for identifiers it does not index (e.g.
        // proceedings-only DOIs like 10.5555/...). Retry once via title
        // match before degrading to a keyword search.
        if (!isNotFoundError(error)) {
          throw error;
        }
        const matchedId = title
          ? await resolveSemanticScholarPaperId({ title })
          : null;
        if (!matchedId || matchedId === paperId) {
          if (query) {
            return keywordFallback(
              "Paper not found on Semantic Scholar; returned keyword search results instead.",
            );
          }
          throw error;
        }
        try {
          results = dedupe(await fetchGraph(matchedId));
        } catch (retryError) {
          if (isNotFoundError(retryError) && query) {
            return keywordFallback(
              "Paper not found on Semantic Scholar; returned keyword search results instead.",
            );
          }
          throw retryError;
        }
      }

      if (!results.length && mode === "recommendations" && query) {
        return keywordFallback(
          "Semantic Scholar had no recommendations for this paper; returned keyword search results instead.",
        );
      }

      return {
        results,
        total: results.length,
        source: "Semantic Scholar",
        ...(doi ? { doi } : {}),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      Zotero.debug(`[llm-for-zotero] Semantic Scholar search failed: ${msg}`);
      const rateLimited =
        error instanceof HttpError && error.status === 429;
      return {
        results: [],
        source: "Semantic Scholar",
        message: rateLimited
          ? 'Semantic Scholar is rate-limiting requests (HTTP 429) even after backing off. Wait a moment before retrying, or repeat this search with source "openalex".'
          : `Semantic Scholar search failed: ${msg}`,
      };
    }
  },
};

/**
 * Registry of every online source the literature search can dispatch to.
 * Adding a source = adding one entry here; tool schemas, validation, and
 * guidance all derive from this table (open/closed principle).
 */
export const SEARCH_SOURCES: Record<SearchSourceId, SearchSourceDefinition> = {
  openalex: openAlexSource,
  semanticscholar: semanticScholarSource,
  arxiv: createSearchOnlySource({
    id: "arxiv",
    label: "arXiv",
    guidance: "preprints, CS/ML/physics",
    fetchPapers: fetchArxivSearch,
  }),
  europepmc: createSearchOnlySource({
    id: "europepmc",
    label: "Europe PMC",
    guidance: "biomedical/life sciences",
    fetchPapers: fetchEuropePmcSearch,
  }),
  dblp: createSearchOnlySource({
    id: "dblp",
    label: "DBLP",
    guidance: "computer science bibliography",
    fetchPapers: fetchDblpSearch,
  }),
};

export const SEARCH_SOURCE_IDS = Object.keys(
  SEARCH_SOURCES,
) as SearchSourceId[];

/**
 * The source used when the model omits `source`, and the graph-capable
 * source that non-graph selections are auto-corrected to.
 */
export const DEFAULT_SEARCH_SOURCE_ID: SearchSourceId = "semanticscholar";

export class LiteratureSearchService {
  constructor(private readonly zoteroGateway: ZoteroGateway) {}

  private resolveLookupSeed(
    input: SearchInput,
    context: AgentToolContext,
  ): {
    doi?: string;
    title?: string;
    arxivId?: string;
  } {
    let doi = input.doi;
    let title = input.title || input.query;
    const arxivId = input.arxivId;
    if (doi || title || arxivId) {
      return { doi, title, arxivId };
    }
    const metadataItem = this.zoteroGateway.resolveMetadataItem({
      request: context.request,
      item: context.item,
      itemId: input.itemId ?? input.paperContext?.itemId,
      paperContext: input.paperContext,
    });
    if (!metadataItem) {
      return { doi, title, arxivId };
    }
    const snapshot =
      this.zoteroGateway.getEditableArticleMetadata(metadataItem);
    if (!doi && snapshot?.fields.DOI) {
      doi = snapshot.fields.DOI.trim();
    }
    if (!title && snapshot?.title) {
      title = snapshot.title.trim();
    }
    return { doi, title, arxivId };
  }

  async execute(
    input: SearchInput,
    context: AgentToolContext,
  ): Promise<LiteratureSearchResult> {
    if (input.mode === "metadata") {
      return this.lookupMetadata(this.resolveLookupSeed(input, context));
    }
    return this.search(input, context);
  }

  /**
   * Resolve a canonical identifier for a paper.
   * If we already have DOI/arXiv, return it immediately.
   * Otherwise, search CrossRef/Semantic Scholar by title to find one.
   */
  private async resolveIdentifier(params: {
    doi?: string;
    title?: string;
    arxivId?: string;
  }): Promise<{
    identifier?: string;
    confidence: "doi" | "title" | "none";
    resolvedDoi?: string;
  }> {
    if (params.doi) {
      const doi = params.doi.replace(/^https?:\/\/doi\.org\//i, "");
      return { identifier: doi, confidence: "doi", resolvedDoi: doi };
    }
    if (params.arxivId) {
      const id = params.arxivId.replace(/^arxiv:/i, "");
      return { identifier: `arxiv:${id}`, confidence: "doi" };
    }
    if (!params.title) {
      return { confidence: "none" };
    }
    // Search CrossRef by title to find a DOI
    const crossRefResults = await searchCrossRef(params.title);
    if (crossRefResults.length > 0 && crossRefResults[0].patch.DOI) {
      const candidateTitle = crossRefResults[0].displayTitle || "";
      const queryKey = normalizeTitleKey(params.title);
      const candidateKey = normalizeTitleKey(candidateTitle);
      if (
        queryKey &&
        candidateKey &&
        (queryKey === candidateKey ||
          queryKey.includes(candidateKey) ||
          candidateKey.includes(queryKey))
      ) {
        return {
          identifier: crossRefResults[0].patch.DOI,
          confidence: "title",
          resolvedDoi: crossRefResults[0].patch.DOI,
        };
      }
    }
    // Try Semantic Scholar by title
    const s2 = await lookupSemanticScholar({ title: params.title });
    if (s2?.patch.DOI) {
      return {
        identifier: s2.patch.DOI,
        confidence: "title",
        resolvedDoi: s2.patch.DOI,
      };
    }
    return { confidence: "none" };
  }

  private async lookupMetadata(params: {
    doi?: string;
    title?: string;
    arxivId?: string;
  }): Promise<LiteratureSearchResult> {
    // Phase 1: resolve identifier
    const resolved = await this.resolveIdentifier(params);

    // Phase 2: fetch via Zotero Translate.Search (primary source)
    let translatorResult: ExternalMetadataResult | null = null;
    if (resolved.identifier) {
      const patch = await this.zoteroGateway.fetchMetadataByIdentifier(
        resolved.identifier,
      );
      if (patch) {
        const authors =
          patch.creators
            ?.map((c) =>
              c.name
                ? c.name
                : [c.firstName, c.lastName].filter(Boolean).join(" "),
            )
            .filter(Boolean) || [];
        const yearStr = patch.date || undefined;
        const authorLabel =
          authors.slice(0, 3).join(", ") +
          (authors.length > 3 ? " et al." : "");
        const venue = patch.publicationTitle || patch.proceedingsTitle;
        translatorResult = {
          source: "Zotero Translator",
          patch,
          matchConfidence:
            resolved.confidence === "none" ? undefined : resolved.confidence,
          displayTitle: patch.title,
          displaySubtitle:
            [yearStr, authorLabel, venue].filter(Boolean).join(" · ") ||
            undefined,
        };
      }
    }

    // Phase 3: supplement with CrossRef/Semantic Scholar for additional data
    const results: ExternalMetadataResult[] = [];
    if (translatorResult) {
      results.push(translatorResult);
    }

    // Get supplementary data (citation count, etc.) from existing APIs
    const doi = resolved.resolvedDoi || params.doi;
    if (doi) {
      const crossRef = await lookupCrossRefByDoi(doi);
      if (crossRef) {
        if (!translatorResult) {
          results.push(crossRef);
        }
      }
    } else if (params.title && !translatorResult) {
      const crossRefResults = await searchCrossRef(params.title);
      results.push(...crossRefResults.slice(0, 2));
    }

    const s2 = await lookupSemanticScholar(
      doi ? { doi } : { title: params.title },
    );
    if (s2) {
      if (translatorResult && s2.citationCount !== undefined) {
        translatorResult.citationCount = s2.citationCount;
      }
      if (!translatorResult) {
        results.push(s2);
      }
    }

    if (!results.length) {
      return {
        results: [],
        message: "No metadata found for the given identifier.",
      };
    }
    return { results };
  }

  private async search(
    input: SearchInput,
    context: AgentToolContext,
  ): Promise<LiteratureSearchResult> {
    const mode = input.mode === "metadata" ? "search" : input.mode;
    const source = input.source ?? DEFAULT_SEARCH_SOURCE_ID;
    const limit = input.limit ?? 10;
    let doi = input.doi;
    let titleFallback = input.query || input.title;
    let activeTitleKey: string | undefined;

    if (!doi) {
      const metadataItem = this.zoteroGateway.resolveMetadataItem({
        request: context.request,
        item: context.item,
        itemId: input.itemId ?? input.paperContext?.itemId,
        paperContext: input.paperContext,
      });
      if (metadataItem) {
        const snapshot =
          this.zoteroGateway.getEditableArticleMetadata(metadataItem);
        if (snapshot?.fields.DOI) {
          doi = snapshot.fields.DOI.trim();
        }
        if (!titleFallback && snapshot?.title) {
          titleFallback = snapshot.title.trim();
        }
        if (snapshot?.title) {
          activeTitleKey = normalizeTitleKey(snapshot.title);
        }
      }
    }

    const dedupe = (results: OnlinePaperResult[]): OnlinePaperResult[] =>
      results.filter((result) => !isActivePaper(doi, activeTitleKey, result));

    return SEARCH_SOURCES[source].run({
      mode,
      query: input.query || titleFallback,
      title: input.title,
      author: input.author,
      arxivId: input.arxivId,
      doi,
      titleFallback,
      limit,
      dedupe,
    });
  }
}
