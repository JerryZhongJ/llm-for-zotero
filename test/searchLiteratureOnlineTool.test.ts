import { assert } from "chai";
import { createSearchLiteratureOnlineTool } from "../src/agent/tools/read/searchLiteratureOnline";
import type { AgentToolContext } from "../src/agent/types";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

describe("search_literature_online tool", function () {
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

  afterEach(function () {
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      originalFetch;
  });

  it("supports metadata lookups through the unified online tool", async function () {
    const crossRefItem = {
      DOI: "10.1000/example",
      title: ["Example Title"],
      author: [{ given: "Alice", family: "Example" }],
      "container-title": ["Journal"],
      URL: "https://doi.org/10.1000/example",
    };
    const s2Item = {
      title: "Example Title",
      authors: [{ name: "Alice Example" }],
      year: 2024,
      abstract: "Abstract",
      venue: "Journal",
      citationCount: 12,
      externalIds: { DOI: "10.1000/example" },
    };
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        // Title search (used by resolveIdentifier)
        if (href.includes("api.crossref.org/works?query.bibliographic")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ message: { items: [crossRefItem] } }),
          } as Response;
        }
        // DOI lookup (used by supplement phase)
        if (href.includes("api.crossref.org/works/10.1000")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ message: crossRefItem }),
          } as Response;
        }
        // Semantic Scholar DOI or title search
        if (href.includes("api.semanticscholar.org")) {
          return {
            ok: true,
            status: 200,
            json: async () =>
              href.includes("/search") ? { data: [s2Item] } : s2Item,
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    const tool = createSearchLiteratureOnlineTool({
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
      fetchMetadataByIdentifier: async () => null,
    } as never);
    const validated = tool.validate({
      mode: "metadata",
      title: "Example Title",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    assert.equal((result as { mode: string }).mode, "metadata");
    assert.lengthOf((result as { results: unknown[] }).results, 2);
  });

  it("resolves metadata lookups from the current Zotero item when only item context is provided", async function () {
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("api.crossref.org/works/10.1000%2Fexample")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              message: {
                DOI: "10.1000/example",
                title: ["Example Title"],
                author: [{ given: "Alice", family: "Example" }],
                "container-title": ["Journal"],
                URL: "https://doi.org/10.1000/example",
              },
            }),
          } as Response;
        }
        if (
          href.includes(
            "api.semanticscholar.org/graph/v1/paper/DOI:10.1000%2Fexample",
          )
        ) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              title: "Example Title",
              authors: [{ name: "Alice Example" }],
              year: 2024,
              abstract: "Abstract",
              venue: "Journal",
              citationCount: 12,
              externalIds: { DOI: "10.1000/example" },
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    const item = { id: 7 } as any;
    const tool = createSearchLiteratureOnlineTool({
      resolveMetadataItem: () => item,
      getEditableArticleMetadata: () =>
        ({
          title: "Existing Title",
          fields: { DOI: "10.1000/example" },
        }) as any,
      fetchMetadataByIdentifier: async () => null,
    } as never);
    const validated = tool.validate({
      mode: "metadata",
      itemId: 7,
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    assert.equal((result as { mode: string }).mode, "metadata");
    assert.lengthOf((result as { results: unknown[] }).results, 2);
  });

  it("supports live search mode through the unified online tool", async function () {
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("api.openalex.org/works?search=")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              results: [
                {
                  id: "https://openalex.org/W123",
                  display_name: "Related Paper",
                  authorships: [
                    { author: { display_name: "Bob Example" } },
                    { author: { display_name: "Riley Example" } },
                  ],
                  publication_year: 2025,
                  cited_by_count: 4,
                  doi: "https://doi.org/10.1000/related",
                  open_access: { oa_url: "https://example.com/paper.pdf" },
                },
              ],
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    const tool = createSearchLiteratureOnlineTool({
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
    } as never);
    const validated = tool.validate({
      mode: "search",
      source: "openalex",
      query: "neural networks",
    });
    assert.isTrue(validated.ok);
    if (!validated.ok) return;

    const result = await tool.execute(validated.value, baseContext);
    const results = (result as { results: Array<Record<string, unknown>> })
      .results;
    assert.lengthOf(results, 1);
    assert.equal(results[0].title, "Related Paper");
    assert.equal(results[0].doi, "10.1000/related");
    assert.equal(tool.presentation?.traceIcon, "library");
    assert.deepEqual(
      tool.presentation?.buildTraceDetails?.({
        args: validated.value,
        content: result,
      }),
      [
        { label: "Query", value: "neural networks" },
        {
          label: "Paper",
          value: "Bob Example et al., 2025, Related Paper",
          timeline: {
            icon: "paper",
            href: "https://example.com/paper.pdf",
          },
        },
      ],
    );
  });

  it("searches DBLP for computer science literature", async function () {
    const dblpHit = (info: Record<string, unknown>) => ({ info });
    (globalThis as Record<string, unknown>).Zotero = {
      debug: () => undefined,
      HTTP: {
        request: async () => ({
          status: 200,
          responseText: JSON.stringify({
            result: {
              hits: {
                "@total": "2",
                hit: [
                  dblpHit({
                    title: "Attention Is All You Need",
                    authors: {
                      author: [
                        { text: "Ashish Vaswani" },
                        { text: "Noam Shazeer" },
                      ],
                    },
                    venue: "NeurIPS",
                    year: "2017",
                    doi: "https://doi.org/10.5555/3295222.3295349",
                    ee: [
                      "https://arxiv.org/abs/1706.03762",
                      "https://doi.org/10.5555/3295222.3295349",
                    ],
                    url: "https://dblp.org/rec/conf/nips/VaswaniSPUJGKP17",
                  }),
                  dblpHit({
                    title:
                      "Semi-Supervised Classification with Graph Convolutional Networks",
                    authors: { author: { text: "Thomas N. Kipf" } },
                    venue: ["ICLR", "OpenReview.net"],
                    year: "2017",
                    ee: "https://arxiv.org/abs/1609.02907",
                    url: "https://dblp.org/rec/conf/iclr/KipfW17",
                  }),
                ],
              },
            },
          }),
        }),
      },
    };

    try {
      const tool = createSearchLiteratureOnlineTool({
        resolveMetadataItem: () => null,
        getEditableArticleMetadata: () => null,
      } as never);
      const validated = tool.validate({
        mode: "search",
        source: "dblp",
        query: "graph neural networks",
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;

      const result = await tool.execute(validated.value, baseContext);
      const results = (result as { results: Array<Record<string, unknown>> })
        .results;
      assert.equal((result as { source: string }).source, "DBLP");
      assert.lengthOf(results, 2);
      assert.equal(results[0].title, "Attention Is All You Need");
      assert.deepEqual(results[0].authors, ["Ashish Vaswani", "Noam Shazeer"]);
      assert.equal(results[0].doi, "10.5555/3295222.3295349");
      assert.equal(results[0].year, 2017);
      assert.equal(
        results[0].openAccessUrl,
        "https://arxiv.org/abs/1706.03762",
      );
      // Single-author hits serialize the author as a bare object, not an array.
      assert.deepEqual(results[1].authors, ["Thomas N. Kipf"]);
      assert.equal(
        results[1].openAccessUrl,
        "https://arxiv.org/abs/1609.02907",
      );
    } finally {
      delete (globalThis as Record<string, unknown>).Zotero;
    }
  });

  it("searches Semantic Scholar for CS/ML literature", async function () {
    (globalThis as Record<string, unknown>).Zotero = {
      debug: () => undefined,
    };
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        if (
          href.includes("api.semanticscholar.org/graph/v1/paper/search?query=")
        ) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  title: "Attention Is All You Need",
                  authors: [
                    { name: "Ashish Vaswani" },
                    { name: "Noam Shazeer" },
                  ],
                  year: 2017,
                  abstract: "The dominant sequence transduction models...",
                  externalIds: { DOI: "10.5555/3295222.3295349" },
                  citationCount: 100000,
                  openAccessPdf: { url: "https://arxiv.org/pdf/1706.03762" },
                },
              ],
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    try {
      const tool = createSearchLiteratureOnlineTool({
        resolveMetadataItem: () => null,
        getEditableArticleMetadata: () => null,
      } as never);
      const validated = tool.validate({
        mode: "search",
        source: "semanticscholar",
        query: "transformer attention",
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;

      const result = await tool.execute(validated.value, baseContext);
      assert.equal((result as { source: string }).source, "Semantic Scholar");
      const results = (result as { results: Array<Record<string, unknown>> })
        .results;
      assert.lengthOf(results, 1);
      assert.equal(results[0].title, "Attention Is All You Need");
      assert.deepEqual(results[0].authors, ["Ashish Vaswani", "Noam Shazeer"]);
      assert.equal(results[0].doi, "10.5555/3295222.3295349");
      assert.equal(results[0].citationCount, 100000);
      assert.equal(
        results[0].openAccessUrl,
        "https://arxiv.org/pdf/1706.03762",
      );
    } finally {
      delete (globalThis as Record<string, unknown>).Zotero;
    }
  });

  it("fetches citations from the Semantic Scholar graph by DOI", async function () {
    (globalThis as Record<string, unknown>).Zotero = {
      debug: () => undefined,
    };
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        if (
          href.includes(
            "api.semanticscholar.org/graph/v1/paper/DOI%3A10.1000%2Fexample/citations",
          )
        ) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  citingPaper: {
                    title: "Citing Paper",
                    authors: [{ name: "Riley Example" }],
                    year: 2025,
                    externalIds: { DOI: "10.1000/citing" },
                    citationCount: 3,
                  },
                },
              ],
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    try {
      const tool = createSearchLiteratureOnlineTool({
        resolveMetadataItem: () => null,
        getEditableArticleMetadata: () => null,
      } as never);
      const validated = tool.validate({
        mode: "citations",
        source: "semanticscholar",
        doi: "10.1000/example",
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;
      // Graph modes accept openalex and semanticscholar as-is.
      assert.equal(validated.value.source, "semanticscholar");

      const result = await tool.execute(validated.value, baseContext);
      assert.equal((result as { source: string }).source, "Semantic Scholar");
      assert.equal((result as { doi: string }).doi, "10.1000/example");
      const results = (result as { results: Array<Record<string, unknown>> })
        .results;
      assert.lengthOf(results, 1);
      assert.equal(results[0].title, "Citing Paper");
      assert.equal(results[0].doi, "10.1000/citing");
    } finally {
      delete (globalThis as Record<string, unknown>).Zotero;
    }
  });

  it("retries via title match when Semantic Scholar does not index the DOI", async function () {
    const s2PaperId = "204e3073870fae3d05bcbc2f6a8e263d9b72e776";
    (globalThis as Record<string, unknown>).Zotero = {
      debug: () => undefined,
    };
    (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch =
      (async (url: string | URL | Request) => {
        const href = String(url);
        // Proceedings-only DOI that S2 does not index → 404.
        if (
          href.includes(
            `api.semanticscholar.org/graph/v1/paper/DOI%3A10.5555%2F3295222.3295349/citations`,
          )
        ) {
          return {
            ok: false,
            status: 404,
            json: async () => ({}),
          } as Response;
        }
        if (
          href.includes("api.semanticscholar.org/graph/v1/paper/search/match")
        ) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                { paperId: s2PaperId, title: "Attention is All you Need" },
              ],
            }),
          } as Response;
        }
        if (
          href.includes(
            `api.semanticscholar.org/graph/v1/paper/${s2PaperId}/citations`,
          )
        ) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  citingPaper: {
                    title:
                      "BERT: Pre-training of Deep Bidirectional Transformers",
                    authors: [{ name: "Jacob Devlin" }],
                    year: 2019,
                    externalIds: { DOI: "10.18653/v1/N19-1423" },
                  },
                },
              ],
            }),
          } as Response;
        }
        throw new Error(`Unexpected URL: ${href}`);
      }) as typeof fetch;

    try {
      const tool = createSearchLiteratureOnlineTool({
        resolveMetadataItem: () => null,
        getEditableArticleMetadata: () => null,
      } as never);
      const validated = tool.validate({
        mode: "citations",
        source: "semanticscholar",
        doi: "10.5555/3295222.3295349",
        title: "Attention is all you need",
      });
      assert.isTrue(validated.ok);
      if (!validated.ok) return;

      const result = await tool.execute(validated.value, baseContext);
      assert.equal((result as { source: string }).source, "Semantic Scholar");
      const results = (result as { results: Array<Record<string, unknown>> })
        .results;
      assert.lengthOf(results, 1);
      assert.equal(
        results[0].title,
        "BERT: Pre-training of Deep Bidirectional Transformers",
      );
    } finally {
      delete (globalThis as Record<string, unknown>).Zotero;
    }
  });

  it("auto-corrects graph modes away from search-only sources", function () {
    const tool = createSearchLiteratureOnlineTool({
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
    } as never);

    const corrected = tool.validate({
      mode: "references",
      source: "arxiv",
      doi: "10.1000/example",
    });
    assert.isTrue(corrected.ok);
    if (corrected.ok) {
      assert.equal(corrected.value.source, "semanticscholar");
    }

    const preserved = tool.validate({
      mode: "recommendations",
      source: "semanticscholar",
      doi: "10.1000/example",
    });
    assert.isTrue(preserved.ok);
    if (preserved.ok) {
      assert.equal(preserved.value.source, "semanticscholar");
    }
  });

  it("adds guidance for live paper discovery requests", function () {
    const tool = createSearchLiteratureOnlineTool({
      resolveMetadataItem: () => null,
      getEditableArticleMetadata: () => null,
    } as never);
    assert.isTrue(
      tool.guidance?.matches({
        conversationKey: 11,
        mode: "agent",
        userText: "can you find related papers from internet to me",
      }) || false,
    );
    assert.include(
      tool.guidance?.instruction || "",
      "library_import, library_update (kind:'metadata'), or note_write directly",
    );
    assert.isFalse(
      tool.guidance?.matches({
        conversationKey: 12,
        mode: "agent",
        userText: "search the web for the latest Zotero release notes",
      }) || false,
    );
    assert.isTrue(
      tool.guidance?.matches({
        conversationKey: 13,
        mode: "agent",
        userText: "查找论文并核对当前官方文档",
        classifiedIntent: {
          retrievalIntent: "none",
          externalSearchIntent: "both",
          wantedSections: [],
          actionIntents: [],
        },
      }) || false,
    );
  });
});
