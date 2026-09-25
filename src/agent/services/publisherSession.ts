/**
 * HiddenBrowser-backed session warming for the publisher PDF resolver.
 *
 * ACM (Cloudflare) and IEEE (F5 TSPD) reject fingerprint-less HTTP clients:
 * their challenge pages only hand out cookies (`cf_clearance`, TSPD) to a real
 * browser that executes the challenge JavaScript. Zotero ships exactly that —
 * a hidden, windowless Gecko browser (`HiddenBrowser.mjs`) it uses for
 * snapshots and translation. We load the paper's landing page in one, tied to
 * an isolated cookie jar (`Zotero.HTTP.newCookieContext()`), let the challenge
 * JS run, then throw the browser away — the cookies stay in the jar and later
 * requests with the same userContextId inherit them. This is the same
 * mechanism as Zotero's own `BrowserRequest` (ScienceDirect/WorldCat
 * Turnstile), just driven by the plugin.
 *
 * Real-machine evidence (2026-09-25): warmed cookies let the challenge
 * through, but the final PDF hop must still be a *document navigation* —
 * those sites answer XHRs with an HTML challenge page even with cookies.
 * Hence `downloadPdfViaBrowserNavigation`, which reuses BrowserRequest's
 * `_loadAndSettle` to intercept the PDF bytes at the channel layer inside
 * the warmed session.
 *
 * Everything here degrades to null when the APIs are missing (unit tests,
 * Zotero < 9.0.3): the resolver chain then simply stays on plain HTTP.
 */

type CookieContext = {
  id: number;
  dispose(): void;
};

interface HiddenBrowserLike {
  _createdPromise?: Promise<unknown>;
  load(source: string, options?: Record<string, unknown>): Promise<boolean>;
  waitForDocument(options?: {
    allowInteractiveAfter?: number;
  }): Promise<void>;
  destroy(): void;
}

type HiddenBrowserConstructor = new (options: {
  userContextId?: number;
  customUserAgent?: string;
  docShell?: Record<string, unknown>;
}) => HiddenBrowserLike;

export interface PublisherSession {
  userContextId: number;
  /** Plain Firefox UA the browser context used — requests must match it. */
  userAgent?: string;
  dispose(): void;
}

const WARM_OVERALL_TIMEOUT_MS = 30_000;
/** How long the document may take to reach 'interactive' after 'complete'. */
const WARM_INTERACTIVE_GRACE_MS = 10_000;

let cachedBrowserClass: HiddenBrowserConstructor | null | undefined;

function getHiddenBrowserClass(): HiddenBrowserConstructor | null {
  if (cachedBrowserClass !== undefined) return cachedBrowserClass;
  cachedBrowserClass = null;
  try {
    const chromeUtils = (
      globalThis as unknown as {
        ChromeUtils?: {
          importESModule?: (url: string) => { HiddenBrowser?: unknown };
        };
      }
    ).ChromeUtils;
    const fromEsm = chromeUtils?.importESModule?.(
      "chrome://zotero/content/HiddenBrowser.mjs",
    );
    if (
      fromEsm &&
      typeof (fromEsm as { HiddenBrowser?: unknown }).HiddenBrowser ===
        "function"
    ) {
      cachedBrowserClass = (fromEsm as {
        HiddenBrowser: HiddenBrowserConstructor;
      }).HiddenBrowser;
    }
  } catch {
    /* stay null */
  }
  return cachedBrowserClass;
}

function newCookieContext(): CookieContext | null {
  try {
    const httpApi = (
      Zotero as unknown as {
        HTTP?: { newCookieContext?: () => CookieContext };
      }
    ).HTTP;
    const context = httpApi?.newCookieContext?.();
    return context && typeof context.id === "number" ? context : null;
  } catch {
    return null;
  }
}

function getPlainUserAgent(): string | undefined {
  try {
    const ua = (
      Zotero as unknown as {
        VersionHeader?: { getPlainFirefoxUA?: () => string };
      }
    ).VersionHeader?.getPlainFirefoxUA?.();
    return typeof ua === "string" && ua.trim() ? ua.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the browser-session path can run at all (Zotero 9.0.3+ —
 * `newCookieContext` and the ESM HiddenBrowser must both exist).
 */
export function isBrowserSessionAvailable(): boolean {
  return getHiddenBrowserClass() !== null && newCookieContext() !== null;
}

/** Test seam: forget the cached HiddenBrowser module lookup. */
export function resetHiddenBrowserClassCacheForTests(): void {
  cachedBrowserClass = undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

function debug(message: string): void {
  try {
    Zotero.debug(`[llm-for-zotero] ${message}`);
  } catch {
    /* no Zotero in unit tests */
  }
}

/**
 * Load `landingUrl` in a hidden browser tied to a fresh isolated cookie jar
 * and let its JavaScript (anti-bot challenges included) run to completion.
 * Returns the jar handle so subsequent requests can reuse the cookies.
 * Never throws; null means "browser path unavailable".
 */
export async function warmPublisherSession(
  landingUrl: string,
): Promise<PublisherSession | null> {
  const BrowserClass = getHiddenBrowserClass();
  const cookieContext = newCookieContext();
  if (!BrowserClass || !cookieContext) return null;

  const userAgent = getPlainUserAgent();
  let browser: HiddenBrowserLike | null = null;
  try {
    browser = new BrowserClass({
      userContextId: cookieContext.id,
      customUserAgent: userAgent,
      docShell: { allowMetaRedirects: true },
    });
    await browser._createdPromise;

    // `load` resolves false on failure without throwing; cookies from a
    // partial load can still be worth retrying with, so we keep going.
    const warmed = await withTimeout(
      (async () => {
        const loaded = await browser!.load(landingUrl);
        try {
          await browser!.waitForDocument({
            allowInteractiveAfter: WARM_INTERACTIVE_GRACE_MS,
          });
        } catch {
          /* challenge pages may never reach 'complete' — cookies still land */
        }
        return loaded;
      })(),
      WARM_OVERALL_TIMEOUT_MS,
    );
    debug(`pdfResolver warm: ${landingUrl.slice(0, 120)} loaded=${String(warmed)}`);
    return {
      userContextId: cookieContext.id,
      userAgent,
      dispose: () => cookieContext.dispose(),
    };
  } catch (error) {
    debug(
      `pdfResolver warm failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  } finally {
    try {
      browser?.destroy();
    } catch {
      /* destroy is best-effort (and idempotent upstream) */
    }
  }
}

/** How long a navigation may take to produce the PDF channel. */
const NAVIGATION_PDF_TIMEOUT_MS = 45_000;

/**
 * Download `pdfUrl` as a *document navigation* inside the session's cookie
 * jar, capturing the bytes via Zotero's MIME-type channel interception.
 *
 * Registers `Zotero.BrowserRequest`'s `application/pdf` interceptor around a
 * HiddenBrowser on the session's userContextId and waits the full window for
 * the PDF channel — deliberately NOT `_loadAndSettle`, whose 3s settle
 * window exits before anti-bot scripts (IEEE's F5 layer rewrites the
 * stamp.jsp iframe src with a signed `ref=` well after document complete)
 * trigger the actual PDF load. The handler registry is global; it is removed
 * in a finally block so a failure can never swallow the user's normal
 * save-as-PDF path. Null when unavailable/failed — never throws.
 */
export async function downloadPdfViaBrowserNavigation(
  pdfUrl: string,
  session: PublisherSession,
): Promise<Uint8Array | null> {
  const BrowserClass = getHiddenBrowserClass();
  if (!BrowserClass) return null;
  const browserRequest = (
    Zotero as unknown as {
      BrowserRequest?: {
        _makePDFMIMETypeHandler?: (
          browser: unknown,
          onPDFFound: (blob: Blob) => void,
        ) => unknown;
      };
      MIMETypeHandler?: {
        addHandlers?: (
          contentType: string,
          handler: unknown,
          ignoreContentDisposition?: boolean,
        ) => void;
        removeHandlers?: (contentType: string, handler: unknown) => void;
      };
    }
  );
  const makeHandler = browserRequest.BrowserRequest?._makePDFMIMETypeHandler;
  const mimeTypeHandler = browserRequest.MIMETypeHandler;
  if (
    !browserRequest.BrowserRequest ||
    typeof makeHandler !== "function" ||
    typeof mimeTypeHandler?.addHandlers !== "function" ||
    typeof mimeTypeHandler?.removeHandlers !== "function"
  ) {
    return null;
  }

  let browser: (HiddenBrowserLike & { _browser?: unknown }) | null = null;
  let handler: unknown = null;
  try {
    browser = new BrowserClass({
      userContextId: session.userContextId,
      customUserAgent: session.userAgent,
      docShell: { allowMetaRedirects: true },
    });
    await browser._createdPromise;

    let resolvePdf: ((bytes: Uint8Array) => void) | null = null;
    const pdfPromise = new Promise<Uint8Array>((resolve) => {
      resolvePdf = resolve;
    });
    handler = makeHandler.call(
      browserRequest.BrowserRequest,
      browser._browser ?? browser,
      (blob: Blob) => {
        blob
          .arrayBuffer()
          .then((buffer) => resolvePdf?.(new Uint8Array(buffer)));
      },
    );
    mimeTypeHandler.addHandlers("application/pdf", handler, true);

    // `load()` resolves false when the first location change takes >5s —
    // ACM's Cloudflare challenge redirect chain regularly does — so fire it
    // un-awaited (exactly like BrowserRequest._loadAndSettle) and let the
    // PDF window below decide success.
    void browser.load(pdfUrl);
    const bytes = await withTimeout(pdfPromise, NAVIGATION_PDF_TIMEOUT_MS);
    if (!bytes) {
      debug(`pdfResolver navigation: no PDF channel for ${pdfUrl.slice(0, 120)}`);
      return null;
    }
    return bytes;
  } catch (error) {
    debug(
      `pdfResolver navigation failed for ${pdfUrl.slice(0, 120)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  } finally {
    if (handler !== null) {
      try {
        mimeTypeHandler!.removeHandlers!("application/pdf", handler);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      browser?.destroy();
    } catch {
      /* destroy is best-effort (and idempotent upstream) */
    }
  }
}
