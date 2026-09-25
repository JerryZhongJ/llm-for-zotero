import { assert } from "chai";
import {
  PDF_RESOLVERS,
  attachPdfBytesToItem,
  extractIeeeArnumber,
  fetchPublisherPdfBytes,
  fetchAndAttachPublisherPdf,
  readItemDoi,
  resetPdfResolverThrottlesForTests,
  setPdfResolverThrottleIntervalForTests,
  setPublisherSessionWarmerForTests,
  type PdfResolverContext,
} from "../src/agent/services/publisherPdfResolver";
import {
  isBrowserSessionAvailable,
  warmPublisherSession,
} from "../src/agent/services/publisherSession";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]); // "%PDF-..."
const HTML_BYTES = new TextEncoder().encode("<html>challenge</html>");
const pdfResponse = () => ({ status: 200, response: PDF_BYTES.slice().buffer });

type RequestStub = (
  method: string,
  url: string,
  options?: Record<string, unknown>,
) => Promise<{
  status: number;
  responseText?: string;
  response?: ArrayBuffer;
  responseURL?: string;
}>;

describe("publisher PDF resolver", function () {
  const originalZotero = (globalThis as Record<string, unknown>).Zotero;
  const originalIOUtils = (globalThis as Record<string, unknown>).IOUtils;

  let importCalls: Array<Record<string, unknown>> = [];
  let writtenFiles: string[] = [];
  let removedFiles: string[] = [];
  let requestLog: string[] = [];
  let requestOptionsLog: Array<Record<string, unknown>> = [];

  function install(request: RequestStub) {
    importCalls = [];
    writtenFiles = [];
    removedFiles = [];
    requestLog = [];
    requestOptionsLog = [];
    (globalThis as Record<string, unknown>).Zotero = {
      debug: () => undefined,
      HTTP: {
        request: async (method: string, url: string, options?: Record<string, unknown>) => {
          requestLog.push(url);
          if (options) requestOptionsLog.push(options);
          return request(method, url, options ?? {});
        },
      },
      File: { pathToFile: (path: string) => ({ path }) },
      getTempDirectory: () => ({ path: "/tmp" }),
      Attachments: {
        importFromFile: async (options: Record<string, unknown>) => {
          importCalls.push(options);
          return { id: 900 };
        },
      },
    };
    (globalThis as Record<string, unknown>).IOUtils = {
      write: async (path: string) => {
        writtenFiles.push(path);
      },
      remove: async (path: string) => {
        removedFiles.push(path);
      },
    };
  }

  beforeEach(function () {
    resetPdfResolverThrottlesForTests();
  });

  afterEach(function () {
    (globalThis as Record<string, unknown>).Zotero = originalZotero;
    (globalThis as Record<string, unknown>).IOUtils = originalIOUtils;
    resetPdfResolverThrottlesForTests();
    setPublisherSessionWarmerForTests(null);
  });

  const noFetch: PdfResolverContext = {
    fetchText: () => {
      throw new Error("unexpected fetch");
    },
  };

  function makeItem(doi: string | null) {
    return {
      id: 11,
      libraryID: 1,
      getField: (name: string) => (name === "DOI" && doi ? doi : ""),
    } as unknown as Zotero.Item;
  }

  describe("resolver registry", function () {
    it("has unique ids in ascending order", function () {
      const ids = PDF_RESOLVERS.map((resolver) => resolver.id);
      assert.equal(new Set(ids).size, ids.length, "ids must be unique");
      for (let i = 1; i < PDF_RESOLVERS.length; i++) {
        assert.isAbove(
          PDF_RESOLVERS[i].order,
          PDF_RESOLVERS[i - 1].order,
          "order must be strictly ascending",
        );
      }
    });

    it("dispatches a 10.1145 DOI to ACM first, Unpaywall as fallback", function () {
      const handlers = PDF_RESOLVERS.filter((r) =>
        r.canHandle("10.1145/3442188.3445922"),
      ).map((r) => r.id);
      assert.deepEqual(handlers, ["acm", "unpaywall"]);
    });

    it("dispatches a 10.1109 DOI to IEEE and Unpaywall", function () {
      const handlers = PDF_RESOLVERS.filter((r) =>
        r.canHandle("10.1109/ICSE.2019.00012"),
      ).map((r) => r.id);
      assert.deepEqual(handlers, ["ieee", "unpaywall"]);
    });

    it("leaves foreign DOIs to the Unpaywall fallback", function () {
      const handlers = PDF_RESOLVERS.filter((r) =>
        r.canHandle("10.1038/nature12373"),
      ).map((r) => r.id);
      assert.deepEqual(handlers, ["unpaywall"]);
    });
  });

  describe("ACM resolver", function () {
    it("builds the dl.acm.org PDF URL with browser headers and no network", async function () {
      const acm = PDF_RESOLVERS.find((r) => r.id === "acm")!;
      const candidates = await acm.resolvePdfUrl(
        "10.1145/3442188.3445922",
        noFetch,
      );
      assert.lengthOf(candidates, 1);
      assert.equal(
        candidates[0].url,
        "https://dl.acm.org/doi/pdf/10.1145/3442188.3445922?download=true",
      );
      assert.include(candidates[0].headers?.Referer || "", "dl.acm.org/doi/");
    });
  });

  describe("IEEE arnumber extraction", function () {
    it("takes a pure-numeric DOI suffix as the arnumber without fetching", async function () {
      const arnumber = await extractIeeeArnumber("10.1109/8730313", {
        fetchText: () => {
          throw new Error("should not fetch");
        },
      });
      assert.equal(arnumber, "8730313");
    });

    it("falls back to the Crossref record URL", async function () {
      const arnumber = await extractIeeeArnumber("10.1109/ICSE.2019.00012", {
        fetchText: async () =>
          JSON.stringify({
            message: { URL: "https://ieeexplore.ieee.org/document/8730313" },
          }),
      });
      assert.equal(arnumber, "8730313");
    });

    it("falls back to the doi.org redirect target", async function () {
      install(async () => ({
        status: 302,
        responseText: "",
        responseURL: "https://ieeexplore.ieee.org/document/8730313",
      }));
      const arnumber = await extractIeeeArnumber("10.1109/ICSE.2019.00012", {
        fetchText: () => Promise.reject(new Error("HTTP 404")),
      });
      assert.equal(arnumber, "8730313");
    });

    it("gives up when no source yields an arnumber", async function () {
      install(async () => {
        throw new Error("HTTP 404");
      });
      const arnumber = await extractIeeeArnumber("10.1109/ICSE.2019.00012", {
        fetchText: () => Promise.reject(new Error("HTTP 404")),
      });
      assert.isNull(arnumber);
    });
  });

  describe("IEEE resolver", function () {
    const ieee = () => PDF_RESOLVERS.find((r) => r.id === "ieee")!;

    it("extracts the frame PDF link from stamp.jsp with the navigation gateway first", async function () {
      const candidates = await ieee().resolvePdfUrl("10.1109/8730313", {
        fetchText: async () =>
          '<iframe src="/ielx7/6287639/8600701/08730313.pdf?tp=&arnumber=8730313&isnumber=8600701&ref=" frameborder=0>',
      });
      assert.lengthOf(candidates, 3);
      assert.include(candidates[0].url, "stamp.jsp?tp=&arnumber=8730313");
      assert.isTrue(candidates[0].navigationOnly);
      assert.equal(
        candidates[1].url,
        "https://ieeexplore.ieee.org/ielx7/6287639/8600701/08730313.pdf?tp=&arnumber=8730313&isnumber=8600701&ref=",
      );
      assert.include(candidates[2].url, "getPDF.jsp?tp=&arnumber=8730313");
    });

    it("still returns the fallback candidate when stamp.jsp answers a challenge page", async function () {
      const candidates = await ieee().resolvePdfUrl("10.1109/8730313", {
        fetchText: async () => "<html>verification required</html>",
      });
      assert.lengthOf(candidates, 2);
      assert.isTrue(candidates[0].navigationOnly);
      assert.include(candidates[1].url, "getPDF.jsp");
    });
  });

  describe("Unpaywall resolver", function () {
    const unpaywall = () => PDF_RESOLVERS.find((r) => r.id === "unpaywall")!;

    it("returns up to three url_for_pdf locations", async function () {
      const candidates = await unpaywall().resolvePdfUrl("10.1038/x", {
        fetchText: async () =>
          JSON.stringify({
            oa_locations: [
              { url_for_pdf: "https://a.example/1.pdf" },
              { url_for_landing_page: "https://repo.example/no-pdf" },
              { url_for_pdf: "https://b.example/2.pdf" },
              { url_for_pdf: null as unknown as string },
              { url_for_pdf: "https://c.example/3.pdf" },
              { url_for_pdf: "https://d.example/4.pdf" },
            ],
          }),
      });
      assert.deepEqual(
        candidates.map((c) => c.url),
        ["https://a.example/1.pdf", "https://b.example/2.pdf", "https://c.example/3.pdf"],
      );
    });

    it("treats a 404 as no candidates", async function () {
      const candidates = await unpaywall().resolvePdfUrl("10.1039/unknown", {
        fetchText: () => Promise.reject(new Error("HTTP 404")),
      });
      assert.deepEqual(candidates, []);
    });
  });

  describe("download and magic-byte validation", function () {
    it("accepts a response starting with %PDF-", async function () {
      install(async (_method, url) => {
        assert.include(url, "dl.acm.org/doi/pdf/");
        return pdfResponse();
      });
      const fetched = await fetchPublisherPdfBytes("10.1145/3442188.3445922");
      assert.isOk(fetched);
      assert.equal(fetched!.resolverId, "acm");
    });

    it("rejects an HTML challenge page and moves on to the next resolver", async function () {
      install(async (_method, url) => {
        if (url.includes("dl.acm.org")) {
          return { status: 403, response: HTML_BYTES.slice().buffer };
        }
        if (url.includes("api.unpaywall.org")) {
          return {
            status: 200,
            responseText: JSON.stringify({
              oa_locations: [{ url_for_pdf: "https://oa.example/paper.pdf" }],
            }),
          };
        }
        return pdfResponse();
      });
      const fetched = await fetchPublisherPdfBytes("10.1145/3442188.3445922");
      assert.isOk(fetched);
      assert.equal(fetched!.resolverId, "unpaywall");
    });

    it("returns null when every candidate fails", async function () {
      install(async () => ({ status: 200, response: HTML_BYTES.slice().buffer }));
      const fetched = await fetchPublisherPdfBytes("10.1145/3442188.3445922");
      assert.isNull(fetched);
    });
  });

  describe("attachPdfBytesToItem", function () {
    it("imports under the item as application/pdf and removes the temp file", async function () {
      install(async () => pdfResponse());
      const item = makeItem("10.1145/3442188.3445922");
      const attachment = await attachPdfBytesToItem(item, PDF_BYTES);
      assert.isOk(attachment);
      assert.lengthOf(importCalls, 1);
      assert.equal(importCalls[0].parentItemID, 11);
      assert.equal(importCalls[0].contentType, "application/pdf");
      assert.lengthOf(writtenFiles, 1);
      assert.deepEqual(removedFiles, writtenFiles, "temp file must be removed");
    });

    it("still removes the temp file when the import throws", async function () {
      install(async () => pdfResponse());
      (
        (globalThis as Record<string, unknown>).Zotero as {
          Attachments: { importFromFile: () => Promise<never> };
        }
      ).Attachments.importFromFile = async () => {
        throw new Error("import failed");
      };
      const attachment = await attachPdfBytesToItem(
        makeItem("10.1145/x"),
        PDF_BYTES,
      );
      assert.isNull(attachment);
      assert.deepEqual(removedFiles, writtenFiles);
    });
  });

  describe("fetchAndAttachPublisherPdf", function () {
    it("skips items without a DOI without touching the network", async function () {
      install(() => {
        throw new Error("no network expected");
      });
      const attached = await fetchAndAttachPublisherPdf(makeItem(null));
      assert.isFalse(attached);
      assert.deepEqual(requestLog, []);
    });

    it("attaches a validated download to the item", async function () {
      install(async (_method, url) => {
        if (url.includes("dl.acm.org")) return pdfResponse();
        return { status: 404 };
      });
      const attached = await fetchAndAttachPublisherPdf(
        makeItem("10.1145/3442188.3445922"),
      );
      assert.isTrue(attached);
      assert.lengthOf(importCalls, 1);
    });
  });

  describe("per-resolver throttling", function () {
    it("spaces same-resolver requests by the configured interval", async function () {
      setPdfResolverThrottleIntervalForTests("acm", 40);
      const times: number[] = [];
      install(async () => {
        times.push(Date.now());
        return pdfResponse();
      });
      await fetchPublisherPdfBytes("10.1145/3442188.3445922");
      await fetchPublisherPdfBytes("10.1145/3442189.3445923");
      assert.lengthOf(times, 2);
      assert.isAtLeast(times[1] - times[0], 30);
    });
  });

  describe("readItemDoi", function () {
    it("normalizes a doi.org URL down to the bare DOI", function () {
      assert.equal(
        readItemDoi(makeItem("https://doi.org/10.1145/3442188.3445922")),
        "10.1145/3442188.3445922",
      );
    });

    it("returns null for a DOI-less item", function () {
      assert.isNull(readItemDoi(makeItem(null)));
    });
  });

  describe("browser session degradation", function () {
    it("reports the browser path unavailable without ChromeUtils", function () {
      assert.isFalse(isBrowserSessionAvailable());
    });

    it("warms to null without throwing in a bare environment", async function () {
      assert.isNull(await warmPublisherSession("https://dl.acm.org/doi/x"));
    });
  });

  describe("landing pages", function () {
    it("builds the ACM landing URL without fetching", async function () {
      const acm = PDF_RESOLVERS.find((r) => r.id === "acm")!;
      const landing = await acm.landingUrl!("10.1145/3442188.3445922", noFetch);
      assert.equal(landing, "https://dl.acm.org/doi/10.1145/3442188.3445922");
    });

    it("builds the IEEE landing URL from the arnumber", async function () {
      const landing = await PDF_RESOLVERS.find((r) => r.id === "ieee")!
        .landingUrl!("10.1109/8730313", noFetch);
      assert.equal(
        landing,
        "https://ieeexplore.ieee.org/document/8730313",
      );
    });
  });

  describe("warmed-session retry", function () {
    it("retries the chain inside the warmed session and disposes it", async function () {
      // Plain pass blocked (403 challenge); the warmed pass carries
      // cookieSandbox=4242 and succeeds.
      install(async (_method, _url, options) => {
        if (options?.cookieSandbox === 4242) return pdfResponse();
        return { status: 403, response: HTML_BYTES.slice().buffer };
      });
      let disposed = 0;
      setPublisherSessionWarmerForTests(async (landingUrl) => {
        assert.include(landingUrl, "https://dl.acm.org/doi/");
        return {
          userContextId: 4242,
          userAgent: "UnitTestUA/1.0",
          dispose: () => {
            disposed += 1;
          },
        };
      });

      const attached = await fetchAndAttachPublisherPdf(
        makeItem("10.1145/3849478"),
      );

      assert.isTrue(attached, "warmed retry must attach the PDF");
      const sessionRequests = requestOptionsLog.filter(
        (options) => options.cookieSandbox === 4242,
      );
      assert.isAtLeast(
        sessionRequests.length,
        1,
        "retry requests must carry the session",
      );
      assert.include(
        String(sessionRequests[0].headers?.["User-Agent"]),
        "UnitTestUA",
        "session UA must override the default browser UA",
      );
      assert.equal(disposed, 1, "session must be disposed after the retry");
    });

    it("stays failed when the warmed retry is still blocked", async function () {
      install(async () => ({ status: 403, response: HTML_BYTES.slice().buffer }));
      setPublisherSessionWarmerForTests(async () => ({
        userContextId: 4242,
        userAgent: "UnitTestUA/1.0",
        dispose: () => undefined,
      }));
      const attached = await fetchAndAttachPublisherPdf(
        makeItem("10.1145/3849478"),
      );
      assert.isFalse(attached);
    });
  });
});
