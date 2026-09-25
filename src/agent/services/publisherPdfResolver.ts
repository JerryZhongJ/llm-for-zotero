/**
 * Publisher-specific PDF resolvers for the post-import background fetch.
 *
 * Zotero's built-in `Attachments.addAvailableFile` (Unpaywall mirror, library
 * proxies) gives up behind paywalls. This module adds a small registry of
 * DOI→PDF resolvers (ACM, IEEE, Unpaywall direct) tried in order after the
 * built-in lookup comes up empty. Both ACM (Cloudflare managed challenge) and
 * IEEE (F5 TSPD fingerprinting) reject fingerprint-less HTTP clients, so every
 * download is validated against the `%PDF-` magic bytes and a failure just
 * moves on to the next candidate — best-effort, debug-logged, never thrown.
 *
 * Adding a site = appending one descriptor to `PDF_RESOLVERS` (OCP); locating
 * URLs lives in resolvers, downloading + magic validation + attachment import
 * live in the framework layer below (SRP).
 */

import { joinLocalPath } from "../../utils/localPath";
import { createRequestThrottle } from "../../utils/requestThrottle";
import {
  pathToNsIFile,
  removePath,
  writeFileBytes,
} from "../../modules/contextPanel/mineruSync";
import {
  downloadPdfViaBrowserNavigation,
  isBrowserSessionAvailable,
  warmPublisherSession,
  type PublisherSession,
} from "./publisherSession";

/** A desktop UA is required — ACM/IEEE answer bot-looking clients with HTML. */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/** Unpaywall requires a contact email; mirrors the OpenAlex OA_MAILTO value. */
const UNPAYWALL_EMAIL = "llm-for-zotero@github.com";
const PDF_DOWNLOAD_TIMEOUT_MS = 60_000;
/** `%PDF-` — 0x25 0x50 0x44 0x46 0x2D. */
const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

/** Candidates per resolver tried before giving up (Unpaywall oa_locations). */
const MAX_CANDIDATES_PER_RESOLVER = 3;
/** Navigation downloads per warm pass — each spins a hidden browser. */
const MAX_NAVIGATION_CANDIDATES = 2;

interface AttachmentImportApi {
  importFromFile?: (options: {
    file: nsIFile | string;
    libraryID?: number;
    parentItemID?: number;
    title?: string;
    fileBaseName?: string;
    contentType?: string;
  }) => Promise<Zotero.Item>;
}

/**
 * Network access handed to resolvers: a throttled text GET via Zotero's
 * privileged HTTP (bypasses CORS). Non-2xx throws — resolvers catch and treat
 * as "no candidates" (e.g. Unpaywall 404 for a non-OA DOI).
 */
export interface PdfResolverContext {
  fetchText(
    url: string,
    headers?: Record<string, string>,
  ): Promise<string>;
}

/** One direct-download attempt; the framework downloads and validates it. */
export interface PdfCandidate {
  url: string;
  headers?: Record<string, string>;
  /**
   * Only usable as a document navigation (the URL serves an HTML gateway
   * page whose iframe loads the PDF) — skipped by the XHR download path,
   * tried by the warmed-browser navigation path.
   */
  navigationOnly?: boolean;
}

export interface PdfResolverDescriptor {
  id: string;
  label: string;
  /** Lower is tried first. */
  order: number;
  canHandle(doi: string): boolean;
  /** Locate candidate URLs; network fetches only happen through `ctx`. */
  resolvePdfUrl(
    doi: string,
    ctx: PdfResolverContext,
  ): Promise<PdfCandidate[]>;
  /**
   * Anti-bot sites need a warmed browser session (see publisherSession);
   * this is the landing page to load for that. Omitted when the site's
   * plain-HTTP path is the only option (Unpaywall needs no warming).
   */
  landingUrl?(
    doi: string,
    ctx: PdfResolverContext,
  ): Promise<string | null>;
}

// ── per-resolver throttling (same pattern as the S2 throttle) ────────────────

const DEFAULT_THROTTLE_INTERVALS_MS: Record<string, number> = {
  acm: 2000,
  ieee: 2000,
  unpaywall: 600,
};
const DEFAULT_INTERVAL_FALLBACK_MS = 1000;

let defaultThrottleIntervalMsForTests: number | null = null;
const resolverThrottles = new Map<
  string,
  ReturnType<typeof createRequestThrottle>
>();

function getResolverThrottle(id: string): ReturnType<
  typeof createRequestThrottle
> {
  let throttle = resolverThrottles.get(id);
  if (!throttle) {
    throttle = createRequestThrottle(
      defaultThrottleIntervalMsForTests ??
        DEFAULT_THROTTLE_INTERVALS_MS[id] ??
        DEFAULT_INTERVAL_FALLBACK_MS,
    );
    resolverThrottles.set(id, throttle);
  }
  return throttle;
}

/** Test seam: drop pacing so tests don't wait between same-site requests. */
export function resetPdfResolverThrottlesForTests(): void {
  defaultThrottleIntervalMsForTests = 0;
  resolverThrottles.clear();
}

/** Test seam: observe real pacing with a small interval. */
export function setPdfResolverThrottleIntervalForTests(
  id: string,
  ms: number,
): void {
  const throttle = getResolverThrottle(id);
  throttle.setInterval(ms);
  throttle.reset();
}

// ── resolvers ────────────────────────────────────────────────────────────────

const acmResolver: PdfResolverDescriptor = {
  id: "acm",
  label: "ACM Digital Library",
  order: 10,
  canHandle(doi) {
    return /^10\.1145\//i.test(doi);
  },
  async resolvePdfUrl(doi) {
    // Pure URL construction, no network — same rule as Zotero's ACM translator.
    return [
      {
        url: `https://dl.acm.org/doi/pdf/${doi}?download=true`,
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          Referer: `https://dl.acm.org/doi/${doi}`,
        },
      },
    ];
  },
  async landingUrl(doi) {
    return `https://dl.acm.org/doi/${doi}`;
  },
};

const IEEE_ARNUMBER_IN_URL = /ieeexplore\.ieee\.org\/document\/(\d+)/i;

function parseIeeeArnumberFromDoi(doi: string): string | null {
  const suffix = doi.replace(/^10\.1109\//i, "");
  // Most IEEE DOIs end in the numeric article number (10.1109/1234567).
  return /^\d+$/.test(suffix) ? suffix : null;
}

function parseArnumberFromUrl(url: string): string | null {
  const match = IEEE_ARNUMBER_IN_URL.exec(url);
  return match ? match[1] : null;
}

/**
 * IEEE needs the numeric arnumber, which not every 10.1109 DOI carries.
 * Chain: numeric DOI suffix → Crossref `message.URL` → doi.org redirect.
 * Exported for tests.
 */
export async function extractIeeeArnumber(
  doi: string,
  ctx: PdfResolverContext,
): Promise<string | null> {
  const fromDoi = parseIeeeArnumberFromDoi(doi);
  if (fromDoi) return fromDoi;

  try {
    const text = await ctx.fetchText(
      `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    );
    const parsed = JSON.parse(text) as {
      message?: { URL?: unknown };
    };
    if (typeof parsed.message?.URL === "string") {
      const fromCrossref = parseArnumberFromUrl(parsed.message.URL);
      if (fromCrossref) return fromCrossref;
    }
  } catch {
    /* Crossref miss → try the redirect fallback */
  }

  try {
    // doi.org resolves to the document landing page; the XHR exposes the
    // final URL after redirects.
    const xhr = await Zotero.HTTP.request("GET", `https://doi.org/${doi}`, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
      responseType: "text",
      successCodes: false,
      timeout: 15_000,
    });
    return parseArnumberFromUrl(String(xhr.responseURL ?? ""));
  } catch {
    return null;
  }
}

const ieeeResolver: PdfResolverDescriptor = {
  id: "ieee",
  label: "IEEE Xplore",
  order: 20,
  canHandle(doi) {
    return /^10\.1109\//i.test(doi);
  },
  async resolvePdfUrl(doi, ctx) {
    const arnumber = await extractIeeeArnumber(doi, ctx);
    if (!arnumber) return [];

    const headers = {
      "User-Agent": BROWSER_USER_AGENT,
      Referer: `https://ieeexplore.ieee.org/document/${arnumber}`,
    };
    const candidates: PdfCandidate[] = [
      // Navigating to stamp.jsp in the hidden browser loads its PDF iframe,
      // which the channel-level interceptor captures — the exact path a real
      // user's browser takes. Useless over XHR, hence navigationOnly.
      {
        url: `https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=${arnumber}`,
        headers,
        navigationOnly: true,
      },
    ];

    // stamp.jsp is a thin wrapper page whose only iframe points at the real
    // PDF (regex from Zotero's own IEEE Xplore translator). A challenge page
    // simply fails the regex and we fall through to the getPDF.jsp endpoint.
    try {
      const html = await ctx.fetchText(
        `https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=${arnumber}`,
        headers,
      );
      const match =
        /<i?frame\s+src="([^"]+\.pdf\b[^"]*|[^"]+\/getPDF\.jsp\b[^"]*)"/i.exec(
          html,
        );
      if (match) {
        let url = match[1].replace(/&amp;/g, "&");
        if (url.startsWith("/")) {
          url = `https://ieeexplore.ieee.org${url}`;
        }
        candidates.push({ url, headers });
      }
    } catch {
      /* network error or challenge → fallback candidate only */
    }

    candidates.push({
      url: `https://ieeexplore.ieee.org/stamp/stampPDF/getPDF.jsp?tp=&arnumber=${arnumber}&ref=`,
      headers,
    });
    return candidates;
  },
  async landingUrl(doi, ctx) {
    const arnumber = await extractIeeeArnumber(doi, ctx);
    return arnumber ? `https://ieeexplore.ieee.org/document/${arnumber}` : null;
  },
};

const unpaywallResolver: PdfResolverDescriptor = {
  id: "unpaywall",
  label: "Unpaywall",
  order: 30,
  canHandle() {
    return true; // catch-all fallback
  },
  async resolvePdfUrl(doi, ctx) {
    try {
      const text = await ctx.fetchText(
        `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${UNPAYWALL_EMAIL}`,
      );
      const parsed = JSON.parse(text) as {
        oa_locations?: unknown;
      };
      const locations = Array.isArray(parsed.oa_locations)
        ? parsed.oa_locations
        : [];
      const urls: string[] = [];
      for (const location of locations) {
        const raw = (location as { url_for_pdf?: unknown })?.url_for_pdf;
        // url_for_landing_page needs a browser — not directly downloadable.
        if (typeof raw === "string" && raw.trim()) {
          urls.push(raw.trim());
        }
        if (urls.length >= MAX_CANDIDATES_PER_RESOLVER) break;
      }
      return urls.map((url) => ({ url }));
    } catch {
      // 404 = DOI unknown to Unpaywall or not OA — no candidates.
      return [];
    }
  },
};

/** Ordered resolver chain; extend by appending a descriptor (OCP). */
export const PDF_RESOLVERS: readonly PdfResolverDescriptor[] = [
  acmResolver,
  ieeeResolver,
  unpaywallResolver,
].sort((a, b) => a.order - b.order);

// ── framework layer: download, validate, attach ──────────────────────────────

function debugLog(message: string): void {
  try {
    Zotero.debug(`[llm-for-zotero] ${message}`);
  } catch {
    /* no Zotero in unit tests */
  }
}

/** Read and normalize an item's DOI (trim, strip doi.org prefix); null if none. */
export function readItemDoi(item: Zotero.Item): string | null {
  try {
    const raw = item.getField?.("DOI");
    const doi = (typeof raw === "string" ? raw : "").trim();
    if (!doi) return null;
    return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  } catch {
    return null;
  }
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= PDF_MAGIC_BYTES.length &&
    PDF_MAGIC_BYTES.every((byte, index) => bytes[index] === byte)
  );
}

function responseToBytes(response: unknown): Uint8Array | null {
  if (response instanceof ArrayBuffer) return new Uint8Array(response);
  if (ArrayBuffer.isView(response)) {
    return new Uint8Array(
      response.buffer as ArrayBuffer,
      response.byteOffset,
      response.byteLength,
    );
  }
  return null;
}

async function downloadCandidate(
  resolverId: string,
  candidate: PdfCandidate,
  session?: PdfFetchSessionOptions,
): Promise<Uint8Array | null> {
  if (candidate.navigationOnly) {
    // Gateway pages serve HTML over XHR; only a navigation gets the PDF.
    debugLog(
      `pdfResolver ${resolverId}: skipping navigation-only candidate ${candidate.url.slice(0, 120)}`,
    );
    return null;
  }
  try {
    const xhr = await Zotero.HTTP.request("GET", candidate.url, {
      // A warmed browser session must keep the UA it negotiated with and
      // the cookie jar it filled; http.js converts a numeric cookieSandbox
      // into the userContextId origin attribute.
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        ...candidate.headers,
        ...(session?.userAgent ? { "User-Agent": session.userAgent } : {}),
      },
      ...(session?.userContextId !== undefined
        ? {
            cookieSandbox: session.userContextId as unknown as Zotero.CookieSandbox,
          }
        : {}),
      responseType: "arraybuffer",
      successCodes: false,
      timeout: PDF_DOWNLOAD_TIMEOUT_MS,
    });
    if (xhr.status < 200 || xhr.status >= 300) {
      debugLog(
        `pdfResolver ${resolverId}: HTTP ${xhr.status} for ${candidate.url.slice(0, 120)}`,
      );
      return null;
    }
    const bytes = responseToBytes(xhr.response);
    if (!bytes || !hasPdfMagic(bytes)) {
      // An HTML login/challenge page came back instead of the PDF.
      debugLog(
        `pdfResolver ${resolverId}: response is not a PDF for ${candidate.url.slice(0, 120)}`,
      );
      return null;
    }
    return bytes;
  } catch (error) {
    debugLog(
      `pdfResolver ${resolverId}: download failed for ${candidate.url.slice(0, 120)} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return null;
  }
}

/**
 * Optional warmed-browser session for the second fetch attempt: cookies
 * acquired by a HiddenBrowser in an isolated jar (plus the UA it used).
 */
export interface PdfFetchSessionOptions {
  userContextId?: number;
  userAgent?: string;
}

/**
 * Build the throttled, session-aware fetch context for a resolver. All of a
 * resolver's network traffic funnels through its per-site throttle, so
 * same-site requests stay serialized.
 */
function buildResolverContext(
  resolver: PdfResolverDescriptor,
  session?: PdfFetchSessionOptions,
): PdfResolverContext {
  const throttle = getResolverThrottle(resolver.id);
  return {
    fetchText: (url, headers) =>
      throttle.run(() => {
        debugLog(`pdfResolver ${resolver.id}: fetching ${url.slice(0, 120)}`);
        return Zotero.HTTP.request("GET", url, {
          headers: {
            "User-Agent": BROWSER_USER_AGENT,
            ...headers,
            ...(session?.userAgent ? { "User-Agent": session.userAgent } : {}),
          },
          ...(session?.userContextId !== undefined
            ? {
                cookieSandbox:
                  session.userContextId as unknown as Zotero.CookieSandbox,
              }
            : {}),
          responseType: "text",
          timeout: 15_000,
        }).then((xhr) => xhr.responseText ?? "");
      }),
  };
}

/**
 * Walk the resolver chain for a bare DOI and return validated PDF bytes, or
 * null when every candidate failed (blocked, paywalled, not a PDF).
 */
export async function fetchPublisherPdfBytes(
  doi: string,
  session?: PdfFetchSessionOptions,
): Promise<{ bytes: Uint8Array; resolverId: string } | null> {
  for (const resolver of PDF_RESOLVERS) {
    if (!resolver.canHandle(doi)) continue;
    const throttle = getResolverThrottle(resolver.id);
    const ctx = buildResolverContext(resolver, session);

    try {
      const candidates = await resolver.resolvePdfUrl(doi, ctx);
      for (const candidate of candidates) {
        const bytes = await throttle.run(() =>
          downloadCandidate(resolver.id, candidate, session),
        );
        if (bytes) return { bytes, resolverId: resolver.id };
      }
    } catch (error) {
      debugLog(
        `pdfResolver ${resolver.id}: resolve failed (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }
  return null;
}

function getTempPdfPath(doi: string): string {
  const tempRoot =
    (
      Zotero as unknown as {
        getTempDirectory?: () => { path?: string } | null;
      }
    ).getTempDirectory?.()?.path || "";
  const safeDoi = doi.replace(/[^A-Za-z0-9._-]+/g, "-");
  return joinLocalPath(
    tempRoot || "",
    `llm-for-zotero-pdf-${safeDoi}-${Date.now()}.pdf`,
  );
}

/** Bytes → temp file → attachment under the item; temp file always removed. */
export async function attachPdfBytesToItem(
  item: Zotero.Item,
  bytes: Uint8Array,
): Promise<Zotero.Item | null> {
  const attachmentsApi = (
    Zotero as unknown as { Attachments?: AttachmentImportApi }
  ).Attachments;
  if (!attachmentsApi?.importFromFile) return null;

  const tempPath = getTempPdfPath(readItemDoi(item) ?? `item-${item.id}`);
  await writeFileBytes(tempPath, bytes);
  try {
    return await attachmentsApi.importFromFile({
      file: pathToNsIFile(tempPath),
      libraryID: item.libraryID,
      parentItemID: item.id,
      contentType: "application/pdf",
    });
  } catch (error) {
    debugLog(
      `pdfResolver: attachment import failed (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return null;
  } finally {
    void removePath(tempPath);
  }
}

/** Injectable seam so unit tests can simulate a warmed browser session. */
let warmSessionForTests:
  | ((landingUrl: string) => Promise<PublisherSession | null>)
  | null = null;

/** Test seam: replace/disable the HiddenBrowser warm step. */
export function setPublisherSessionWarmerForTests(
  warmer: ((landingUrl: string) => Promise<PublisherSession | null>) | null,
): void {
  warmSessionForTests = warmer;
}

/**
 * Combined entry point called by the gateway after the built-in
 * `addAvailableFile` lookup comes up empty. The caller guarantees the item has
 * no PDF attachment yet.
 *
 * Two tiers: the cheap plain-HTTP chain first (OA and unblocked cases), then
 * — when an anti-bot site blocked it — one HiddenBrowser warm-up on the
 * publisher landing page and a second chain pass inside that cookie session.
 */
export async function fetchAndAttachPublisherPdf(
  item: Zotero.Item,
): Promise<boolean> {
  const doi = readItemDoi(item);
  if (!doi) return false; // e.g. arXiv-only items: zero-cost skip

  let fetched = await fetchPublisherPdfBytes(doi);
  if (!fetched) {
    fetched = await fetchWithWarmedSession(doi);
  }
  if (!fetched) return false;
  const attachment = await attachPdfBytesToItem(item, fetched.bytes);
  if (!attachment) return false;
  debugLog(
    `pdfResolver ${fetched.resolverId}: attached PDF to item ${item.id} (${doi})`,
  );
  return true;
}

/**
 * Warm a HiddenBrowser session on the first eligible resolver's landing page,
 * then try candidate PDF URLs as document navigations (anti-bot sites serve
 * PDFs to navigations, not to XHRs — observed on ACM/IEEE) and finally fall
 * back to the plain XHR chain inside the session. Returns null when the
 * browser path is unavailable (unit tests, Zotero < 9.0.3) or everything
 * failed.
 */
async function fetchWithWarmedSession(
  doi: string,
): Promise<{ bytes: Uint8Array; resolverId: string } | null> {
  const warm = warmSessionForTests ?? warmPublisherSession;
  const browserPathUsable =
    warmSessionForTests !== null || isBrowserSessionAvailable();
  if (!browserPathUsable) return null;

  const resolver = PDF_RESOLVERS.find(
    (candidate) => candidate.canHandle(doi) && candidate.landingUrl,
  );
  if (!resolver?.landingUrl) return null;

  try {
    const landingUrl = await resolver.landingUrl(doi, plainFetchContext());
    if (!landingUrl) return null;
    debugLog(`pdfResolver ${resolver.id}: warming browser session for ${doi}`);
    const session = await warm(landingUrl);
    if (!session) return null;
    try {
      // Locate candidates inside the warm session — the stamp.jsp-style
      // gateway pages only reveal the real PDF link once challenged through.
      let candidates: PdfCandidate[] = [];
      try {
        candidates = await resolver.resolvePdfUrl(
          doi,
          buildResolverContext(resolver, session),
        );
      } catch {
        candidates = [];
      }
      for (const candidate of candidates.slice(0, MAX_NAVIGATION_CANDIDATES)) {
        debugLog(
          `pdfResolver ${resolver.id}: navigating for PDF ${candidate.url.slice(0, 120)}`,
        );
        const bytes = await downloadPdfViaBrowserNavigation(
          candidate.url,
          session,
        );
        if (bytes && hasPdfMagic(bytes)) {
          return { bytes, resolverId: resolver.id };
        }
      }
      debugLog(
        `pdfResolver ${resolver.id}: retrying chain in warmed session (userContextId=${session.userContextId})`,
      );
      return await fetchPublisherPdfBytes(doi, {
        userContextId: session.userContextId,
        userAgent: session.userAgent,
      });
    } finally {
      session.dispose();
    }
  } catch (error) {
    debugLog(
      `pdfResolver ${resolver.id}: warmed retry failed (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return null;
  }
}

/** A plain (cookie-less, default-UA) context for pre-warm URL resolution. */
function plainFetchContext(): PdfResolverContext {
  return {
    fetchText: (url, headers) =>
      Zotero.HTTP.request("GET", url, {
        headers: { "User-Agent": BROWSER_USER_AGENT, ...headers },
        responseType: "text",
        timeout: 15_000,
      }).then((xhr) => xhr.responseText ?? ""),
  };
}
