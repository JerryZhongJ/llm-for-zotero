import { assert } from "chai";
import {
  resetS2ThrottleForTests,
  setS2RetryDelaysForTests,
  setS2ThrottleIntervalForTests,
} from "../src/agent/services/literatureSearchService";
import { createSearchLiteratureOnlineTool } from "../src/agent/tools/read/searchLiteratureOnline";
import type { AgentToolContext } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

describe("Semantic Scholar rate limiting", function () {
  const baseContext: AgentToolContext = {
    request: resolvedAgentRequest({
      conversationKey: 11,
      mode: "agent",
      userText: "Find related papers",
      libraryID: 1,
    }),
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.4",
  };

  const originalFetch = (
    globalThis as typeof globalThis & { fetch?: typeof fetch }
  ).fetch;
  const originalZotero = (globalThis as Record<string, unknown>).Zotero;

  const makeTool = () =>
    createSearchLiteratureOnlineTool({
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
      fetchMetadataByIdentifier: async () => null,
    } as never);

  const runSearch = async (source: string) => {
    const tool = makeTool();
    const validated = tool.validate({
      mode: "search",
      query: "attention is all you need",
      source,
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) throw new Error("validation failed");
    return (await tool.execute(validated.value, baseContext)) as {
      results: unknown[];
      message?: string;
    };
  };

  beforeEach(function () {
    (globalThis as Record<string, unknown>).Zotero = {
      debug: () => undefined,
    };
    resetS2ThrottleForTests();
  });

  afterEach(function () {
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      originalFetch;
    (globalThis as Record<string, unknown>).Zotero = originalZotero;
    resetS2ThrottleForTests();
  });

  it("serializes concurrent S2 requests with pacing between them", async function () {
    setS2ThrottleIntervalForTests(40);
    const s2CallTimes: number[] = [];
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        assert.include(href, "api.semanticscholar.org");
        s2CallTimes.push(Date.now());
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                title: "Attention Is All You Need",
                authors: [{ name: "Vaswani" }],
                year: 2017,
              },
            ],
          }),
        } as Response;
      }) as typeof fetch;

    const results = await Promise.all([
      runSearch("semanticscholar"),
      runSearch("semanticscholar"),
      runSearch("semanticscholar"),
    ]);

    assert.lengthOf(s2CallTimes, 3);
    for (const each of results) assert.lengthOf(each.results, 1);
    // Concurrency is collapsed into a serialized queue: consecutive requests
    // leave at least ~the configured interval between them.
    assert.isAtLeast(s2CallTimes[1] - s2CallTimes[0], 30);
    assert.isAtLeast(s2CallTimes[2] - s2CallTimes[1], 30);
  });

  it("retries a 429 honoring Retry-After and succeeds", async function () {
    setS2RetryDelaysForTests([1]);
    let s2Calls = 0;
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        assert.include(href, "api.semanticscholar.org");
        s2Calls += 1;
        if (s2Calls === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: () => "0" },
            json: async () => ({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              {
                title: "Attention Is All You Need",
                authors: [{ name: "Vaswani" }],
                year: 2017,
              },
            ],
          }),
        } as Response;
      }) as typeof fetch;

    const result = await runSearch("semanticscholar");
    assert.equal(s2Calls, 2);
    assert.lengthOf(result.results, 1);
  });

  it("suggests switching sources when 429s outlast the retries", async function () {
    setS2RetryDelaysForTests([1, 1]);
    let s2Calls = 0;
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        assert.include(String(url), "api.semanticscholar.org");
        s2Calls += 1;
        return {
          ok: false,
          status: 429,
          headers: { get: () => "0" },
          json: async () => ({}),
        } as unknown as Response;
      }) as typeof fetch;

    const result = await runSearch("semanticscholar");
    // 1 initial attempt + 2 backoff retries.
    assert.equal(s2Calls, 3);
    assert.lengthOf(result.results, 0);
    assert.include(result.message ?? "", "openalex");
  });

  it("does not throttle OpenAlex requests behind the S2 queue", async function () {
    setS2ThrottleIntervalForTests(5000);
    try {
      const callTimes: Array<{ host: string; at: number }> = [];
      (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
        (async (url: string | URL | Request) => {
          const href = String(url);
          const host = href.includes("api.openalex.org")
            ? "openalex"
            : "semanticscholar";
          callTimes.push({ host, at: Date.now() });
          if (host === "openalex") {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                results: [
                  {
                    id: "https://openalex.org/W1",
                    display_name: "Attention Is All You Need",
                    publication_year: 2017,
                    authorships: [],
                  },
                ],
              }),
            } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [] }),
          } as Response;
        }) as typeof fetch;

      const s2Start = Date.now();
      const s2Promise = runSearch("semanticscholar");
      // While the S2 request is queued/running, OpenAlex must go straight
      // through — it shares no throttle with S2.
      const oaResult = await runSearch("openalex");
      await s2Promise;

      assert.lengthOf(oaResult.results, 1);
      const oaCall = callTimes.find((c) => c.host === "openalex");
      assert.isDefined(oaCall);
      assert.isBelow(oaCall!.at - s2Start, 2500);
    } finally {
      setS2ThrottleIntervalForTests(0);
      resetS2ThrottleForTests();
    }
  });
});
