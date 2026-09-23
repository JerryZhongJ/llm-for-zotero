import { assert } from "chai";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import {
  BUILTIN_SKILL_FILES,
  getSkillContextEligibility,
  getMatchedSkillIds,
  parseSkill,
  setUserSkills,
} from "../src/agent/skills";
import { AgentToolRegistry } from "../src/agent/tools/registry";
import {
  createPaperReadTool as createResolvedPaperReadTool,
} from "../src/agent/tools/read/paperRead";
import {
  createPaperQueryTool as createResolvedPaperQueryTool,
} from "../src/agent/tools/read/paperQuery";
import type {
  AgentToolContext,
  AgentToolDefinition,
} from "../src/agent/types";
import { resolveAgentRuntimeRequest } from "../src/agent/context/resolvedAgentRequest";
import {
  PDF_FIGURE_CROP_ALGORITHM_VERSION,
  PDF_FIGURE_CROP_CACHE_VERSION,
  buildPdfFigureCropManifestHash,
  buildPdfFigureCropPdfFingerprint,
} from "../src/modules/contextPanel/pdfFigureCropCache";
import { CodexAppServerProcess } from "../src/utils/codexAppServerProcess";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

type ScopePaperContext = {
  itemId: number;
  contextItemId: number;
  title: string;
};

type ScopeGateway = {
  listPaperContexts?: (
    request: AgentToolContext["request"],
  ) => ScopePaperContext[];
};

/**
 * Binds a freshly created read tool to the raw→resolved request boundary the
 * agent dispatcher normally crosses, inferring the active paper from the
 * gateway's ambient list when the raw request carries no concrete scope.
 */
function withResolvedRequestScope<TInput, TResult>(
  tool: AgentToolDefinition<TInput, TResult>,
  gateway: ScopeGateway,
): AgentToolDefinition<TInput, TResult> {
  return {
    ...tool,
    execute: (input, context) => {
      const request = context.request as AgentToolContext["request"] & {
        selectedPaperContexts?: ScopePaperContext[];
      };
      const hasConcreteScope = Boolean(
        request.turnPaperScope?.papers.length ||
        request.selectedPaperContexts?.length ||
        (request as { fullTextPaperContexts?: unknown[] }).fullTextPaperContexts
          ?.length ||
        (request as { pdfPaperContexts?: unknown[] }).pdfPaperContexts?.length,
      );
      const selectedPaperContexts = hasConcreteScope
        ? request.selectedPaperContexts
        : gateway.listPaperContexts?.(request);
      const inferredActivePaper = selectedPaperContexts?.[0];
      return tool.execute(input, {
        ...context,
        request: resolvedAgentRequest({
          ...request,
          conversationKind:
            request.conversationKind ||
            (inferredActivePaper ? "paper" : "global"),
          activeItemId: request.activeItemId || inferredActivePaper?.itemId,
          ...(selectedPaperContexts?.length ? { selectedPaperContexts } : {}),
        }),
      });
    },
  };
}

function createPaperReadTool(
  ...args: Parameters<typeof createResolvedPaperReadTool>
): ReturnType<typeof createResolvedPaperReadTool> {
  return withResolvedRequestScope(
    createResolvedPaperReadTool(...args),
    args[3] as ScopeGateway,
  );
}

function createPaperQueryTool(
  pdfService: unknown,
  retrievalService: unknown,
  zoteroGateway: ScopeGateway,
): ReturnType<typeof createResolvedPaperQueryTool> {
  return withResolvedRequestScope(
    createResolvedPaperQueryTool(
      pdfService as never,
      retrievalService as never,
      zoteroGateway as never,
    ),
    zoteroGateway,
  );
}

describe("semantic tool surface", function () {
  const encoder = new TextEncoder();
  const globalScope = globalThis as typeof globalThis & {
    IOUtils?: unknown;
  };

  afterEach(function () {
    setUserSkills([]);
  });

  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 77,
      mode: "agent",
      userText: "summarize this paper",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.5",
  };

  function resolvedSkillRequest(
    fields: Partial<import("../src/agent/types").AgentRuntimeRequestInput>,
  ) {
    return resolveAgentRuntimeRequest({
      conversationKey: 1,
      mode: "agent",
      userText: "",
      libraryID: 1,
      ...fields,
    });
  }

  function createTestBuiltInRegistry() {
    return createBuiltInToolRegistry({
      zoteroGateway: {} as never,
      pdfService: {} as never,
      pdfPageService: {} as never,
      retrievalService: {} as never,
    });
  }

  function schemaProperties(toolName: string): Record<string, unknown> {
    const registry = createTestBuiltInRegistry();
    const tool = registry.getTool(toolName);
    assert.exists(tool, `${toolName} should be registered`);
    const schema = tool!.spec.inputSchema as {
      properties?: Record<string, unknown>;
    };
    return schema.properties || {};
  }

  it("keeps internal delegate tools out of model-visible listings", function () {
    const registry = new AgentToolRegistry();
    registry.register({
      spec: {
        name: "library_search",
        description: "Public search facade",
        inputSchema: { type: "object" },
        mutability: "read",
        requiresConfirmation: false,
        exposure: "model",
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({}),
    });
    registry.register({
      spec: {
        name: "query_library",
        description: "Internal legacy delegate",
        inputSchema: { type: "object" },
        mutability: "read",
        requiresConfirmation: false,
        exposure: "internal",
      },
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({}),
    });

    assert.deepEqual(
      registry.listTools().map((tool) => tool.name),
      ["library_search"],
    );
    assert.deepEqual(
      registry
        .listToolsForRequest(baseContext.request)
        .map((tool) => tool.name),
      ["library_search"],
    );
    assert.exists(registry.getTool("query_library"));
  });

  it("exposes the semantic built-in surface and hides legacy primitive names", function () {
    const registry = createTestBuiltInRegistry();
    const tools = registry.listToolsForRequest(baseContext.request);
    const names = tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      "annotate_pdf",
      "attachment_update",
      "collection_update",
      "file_io",
      "library_cite",
      "library_delete",
      "library_import",
      "library_read",
      "library_retrieve",
      "library_search",
      "library_settings",
      "library_update",
      "literature_search",
      "note_write",
      "paper_query",
      "paper_read",
      "revert_changes",
      "run_command",
      "saved_search_update",
      "tool_result_read",
      "undo_last_action",
      "zotero_script",
    ]);
    const literatureSearch = tools.find(
      (tool) => tool.name === "literature_search",
    );
    const literatureProperties = (
      literatureSearch?.inputSchema as {
        properties?: Record<string, { enum?: string[] }>;
      }
    )?.properties;
    // The removed answer/review workflow switch must not reappear.
    assert.isUndefined(literatureProperties?.workflow);
    for (const legacyName of [
      "query_library",
      "read_paper",
      "search_paper",
      "view_pdf_pages",
      "search_literature_online",
      "edit_current_note",
      "import_identifiers",
      "update_metadata",
    ]) {
      assert.notInclude(names, legacyName);
      assert.exists(
        registry.getTool(legacyName),
        `${legacyName} remains internally callable`,
      );
    }
    assert.exists(registry.getTool("web_search"));
    assert.exists(registry.getTool("web_read"));
    assert.notInclude(names, "web_search");
    assert.notInclude(names, "web_read");
    for (const name of ["file_io", "run_command", "zotero_script"]) {
      assert.equal(
        tools.find((tool) => tool.name === name)?.tier,
        "advanced",
        `${name} should be advanced`,
      );
    }
  });

  it("does not expose loose top-level schemas for model-visible built-ins", function () {
    const registry = createTestBuiltInRegistry();
    const looseTools = registry
      .listToolsForRequest(baseContext.request)
      .flatMap((tool) => {
        const schema = tool.inputSchema as { additionalProperties?: unknown };
        return schema.additionalProperties === true ? [tool.name] : [];
      });
    assert.deepEqual(looseTools, []);
  });

  it("refuses a restore that mixes object kinds", async function () {
    // One object kind per journalled action keeps the undo rating
    // unambiguous (reversible or not — never "partial").
    const registry = createTestBuiltInRegistry();
    const prepared = await registry.prepareExecution(
      {
        id: "restore-mixed",
        name: "library_delete",
        arguments: {
          mode: "restore",
          itemIds: [11],
          collectionIds: [42],
        },
      },
      baseContext,
    );
    assert.equal(prepared.kind, "result");
    if (prepared.kind === "result") {
      assert.isFalse(prepared.execution.result.ok);
      assert.include(
        String(
          (prepared.execution.result.content as { error?: string })?.error,
        ),
        "one kind of object per call",
      );
    }
  });

  it("advertises delegate fields on semantic facade schemas", function () {
    assert.containsAllKeys(schemaProperties("library_import"), [
      "kind",
      "identifier",
      "filePath",
      "targetCollectionId",
      "collectionId",
      "libraryID",
    ]);
    assert.containsAllKeys(schemaProperties("library_update"), [
      "kind",
      "action",
      "itemIds",
      "tags",
      "assignments",
      "targetCollectionId",
      "targetCollectionName",
      "collectionId",
      "metadata",
      "operations",
      "itemId",
      "paperContext",
    ]);
    assert.containsAllKeys(schemaProperties("library_delete"), [
      "mode",
      "itemIds",
      "masterItemId",
      "otherItemIds",
    ]);
  });

  it("exposes batch metadata operations in the update_metadata schema", function () {
    assert.containsAllKeys(schemaProperties("update_metadata"), [
      "metadata",
      "operations",
      "paperContext",
    ]);
  });

  it("infers library_import kind from the mutually exclusive payload field", function () {
    const registry = createTestBuiltInRegistry();
    const tool = registry.getTool("library_import");
    assert.exists(tool);
    const validation = tool!.validate({
      identifier: "doi1",
      targetCollectionId: 7,
    });
    assert.equal(validation.ok, true);
    if (!validation.ok) return;
    assert.equal(validation.value.delegateName, "import_identifiers");
    const ambiguous = tool!.validate({
      identifier: "doi1",
      filePath: "/tmp/a.pdf",
    });
    assert.equal(ambiguous.ok, false);
    if (ambiguous.ok) return;
    assert.include(ambiguous.error, "Could not determine what to import");
  });

  it("imports exactly one identifier per call", function () {
    const registry = createTestBuiltInRegistry();
    const tool = registry.getTool("library_import");
    assert.exists(tool);
    const validation = tool!.validate({
      kind: "identifiers",
      identifier: "doi1",
      targetCollectionId: 7,
    });
    assert.equal(validation.ok, true);
    if (!validation.ok) return;
    assert.equal(validation.value.delegateName, "import_identifiers");
    assert.equal(validation.value.delegateInput.operation.identifier, "doi1");
  });

  it("normalizes bracketed array strings for library delete and update", function () {
    const registry = createTestBuiltInRegistry();
    const deleteTool = registry.getTool("library_delete");
    const updateTool = registry.getTool("library_update");
    assert.exists(deleteTool);
    assert.exists(updateTool);

    const deleteValidation = deleteTool!.validate({
      mode: "trash",
      itemIds: "[101,102,]",
    });
    assert.equal(deleteValidation.ok, true);
    if (!deleteValidation.ok) return;
    assert.deepEqual(
      deleteValidation.value.delegateInput.operation.itemIds,
      [101, 102],
    );

    const updateValidation = updateTool!.validate({
      kind: "tags",
      action: "add",
      itemIds: "[101,102,]",
      tags: '["ml","vision",]',
    });
    assert.equal(updateValidation.ok, true);
    if (!updateValidation.ok) return;
    assert.deepEqual(
      updateValidation.value.delegateInput.operation.itemIds,
      [101, 102],
    );
    assert.deepEqual(updateValidation.value.delegateInput.operation.tags, [
      "ml",
      "vision",
    ]);
  });

  it("rejects non-bracketed string arrays for library delete and update", function () {
    const registry = createTestBuiltInRegistry();
    const deleteTool = registry.getTool("library_delete");
    const updateTool = registry.getTool("library_update");
    assert.exists(deleteTool);
    assert.exists(updateTool);

    assert.equal(
      deleteTool!.validate({
        mode: "trash",
        itemIds: "101,102",
      }).ok,
      false,
    );
    assert.equal(
      updateTool!.validate({
        kind: "tags",
        action: "add",
        itemIds: [101],
        tags: "ml,vision",
      }).ok,
      false,
    );
  });

  it("paper_read fails loudly for invalid explicit targets", async function () {
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {
        resolvePaperContextTarget: () => null,
        listPaperContexts: () => [
          {
            itemId: 1,
            contextItemId: 2,
            title: "Ambient paper",
          },
        ],
      } as never,
    );
    const validated = tool.validate({
      target: { itemId: 999, contextItemId: 1000 },
      sections: ["Abstract"],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    try {
      await tool.execute(validated.value, baseContext);
      assert.fail("paper_read should reject invalid explicit targets");
    } catch (error) {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /Could not resolve paper target itemId=999, contextItemId=1000/,
      );
    }
  });

  it("paper_read treats an exactly empty target as omitted through the tool registry", async function () {
    const activePaper = {
      itemId: 1,
      contextItemId: 2,
      title: "Readable paper",
    };
    let ensuredPaper: unknown;
    const registry = new AgentToolRegistry();
    registry.register(
      createPaperReadTool(
        {
          ensurePaperContext: async (paperContext: unknown) => {
            ensuredPaper = paperContext;
            return {
              chunks: ["method text"],
              chunkMeta: [
                {
                  chunkIndex: 0,
                  text: "method text",
                  sectionLabel: "Methods",
                  chunkKind: "methods",
                },
              ],
            };
          },
        } as never,
        {} as never,
        {} as never,
        {
          listPaperContexts: () => [activePaper],
          resolvePaperContextTarget: () => activePaper,
        } as never,
      ),
    );

    const request = resolvedAgentRequest({
      ...baseContext.request,
      userText: "Use the actual PDF/full text to explain the method.",
      conversationKind: "paper",
      activeItemId: activePaper.itemId,
      selectedPaperContexts: [activePaper],
    });
    assert.deepEqual(request.turnPaperScope.papers[0]?.roles, ["active"]);

    const prepared = await registry.prepareExecution(
      {
        id: "issue-393-empty-target",
        name: "paper_read",
        arguments: {
          target: {},
          sections: ["Methods"],
        },
      },
      {
        ...baseContext,
        request,
      },
    );

    assert.equal(prepared.kind, "result");
    if (prepared.kind !== "result") return;
    assert.isTrue(
      prepared.execution.result.ok,
      JSON.stringify(prepared.execution.result.content),
    );
    assert.deepInclude(ensuredPaper as Record<string, unknown>, activePaper);
  });

  it("paper_read rejects malformed non-empty selector syntax", function () {
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const emptyEntry = tool.validate({
      target: [{}],
      sections: ["Abstract"],
    });
    assert.equal(emptyEntry.ok, false);
    if (!emptyEntry.ok) {
      assert.include(emptyEntry.error, "empty_target_entry");
    }

    const visualOnly = tool.validate({
      target: { attachmentId: "upload-1" },
      sections: ["Abstract"],
    });
    assert.equal(visualOnly.ok, false);
    if (!visualOnly.ok) {
      assert.include(visualOnly.error, "selector_not_supported_for_mode");
    }

    const lateEmptyEntry = tool.validate({
      target: [
        ...Array.from({ length: 20 }, (_, index) => ({ itemId: index + 1 })),
        {},
      ],
      sections: ["Abstract"],
    });
    assert.equal(lateEmptyEntry.ok, false);
    if (!lateEmptyEntry.ok) {
      assert.include(lateEmptyEntry.error, "empty_target_entry");
    }

    // Image reads are single-target: a selector array fails even with
    // images:true.
    const visualTargets = tool.validate({
      images: true,
      target: [{ itemId: 1 }],
    });
    assert.equal(visualTargets.ok, false);
    if (!visualTargets.ok) {
      assert.include(visualTargets.error, "selector_not_supported_for_mode");
    }

    const imagePaperTarget = tool.validate({
      images: true,
      target: { itemId: 1 },
      pages: [1],
    });
    assert.equal(imagePaperTarget.ok, true);

    // attachmentId/name selectors stay legal for image reads.
    const attachmentImageTarget = tool.validate({
      images: true,
      target: { attachmentId: "upload-1" },
      pages: [1],
    });
    assert.equal(attachmentImageTarget.ok, true);
  });

  it("paper_read fails loudly when a provided pages value cannot be parsed", function () {
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    for (const badPages of ["PDF 11-12", "", [], [0], [-2], "abc"]) {
      const validated = tool.validate({ pages: badPages });
      assert.equal(
        validated.ok,
        false,
        `pages ${JSON.stringify(badPages)} should fail validation`,
      );
      if (!validated.ok) {
        assert.include(validated.error, "Could not parse pages");
      }
    }

    // Parseable forms keep validating: bare range, prefixed range, array.
    assert.equal(tool.validate({ pages: "11-12" }).ok, true);
    assert.equal(tool.validate({ pages: "pp. 11-12" }).ok, true);
    assert.equal(tool.validate({ pages: [11, 12] }).ok, true);
    assert.equal(tool.validate({ pages: 11 }).ok, true);
  });

  it("paper_read fails loudly when called without a locator", function () {
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    for (const args of [{}, { target: { itemId: 1 } }]) {
      const validated = tool.validate(args);
      assert.equal(
        validated.ok,
        false,
        `${JSON.stringify(args)} should fail validation`,
      );
      if (!validated.ok) {
        assert.include(validated.error, "paper_read requires a locator");
      }
    }
  });

  it("paper_read advertises selector-shaped target coordinates", function () {
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const schema = tool.spec.inputSchema as {
      properties?: {
        target?: {
          anyOf?: Array<{ type?: string; minItems?: number }>;
        };
      };
    };
    const [singleSelector, selectorArray] =
      schema.properties?.target?.anyOf || [];
    assert.equal(singleSelector?.type, "object");
    assert.equal(selectorArray?.type, "array");
    assert.equal(selectorArray?.minItems, 1);
  });

  it("paper_read refuses active-reader fallback in collection-scoped library chat", async function () {
    const activeReaderPaper = {
      itemId: 99,
      contextItemId: 199,
      title: "Chandra Paper",
    };
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async () => ({
          chunks: ["should not be read"],
          chunkMeta: [
            {
              chunkIndex: 0,
              text: "should not be read",
              sectionLabel: "Abstract",
              chunkKind: "abstract",
            },
          ],
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: (request: AgentToolContext["request"]) =>
          request.conversationKind === "global" ||
          request.selectedCollectionContexts?.length
            ? []
            : [activeReaderPaper],
        resolvePaperContextTarget: () => activeReaderPaper,
      } as never,
    );
    const validated = tool.validate({ sections: ["Abstract"] });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    try {
      await tool.execute(validated.value, {
        ...baseContext,
        request: {
          ...baseContext.request,
          conversationKind: "global",
          activeItemId: activeReaderPaper.itemId,
          selectedCollectionContexts: [
            { collectionId: 4, name: "Computational_Psychiatry", libraryID: 1 },
          ],
        },
      });
      assert.fail("Expected library chat to require explicit paper targets");
    } catch (error) {
      assert.include(
        error instanceof Error ? error.message : String(error),
        "No paper target in library chat",
      );
    }
  });

  it("paper_read keeps active-paper fallback in paper chat", async function () {
    const activeReaderPaper = {
      itemId: 99,
      contextItemId: 199,
      title: "Active Paper",
    };
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async (paperContext: unknown) => ({
          chunks: ["active paper abstract"],
          chunkMeta: [
            {
              chunkIndex: 0,
              text: "active paper abstract",
              sectionLabel: "Abstract",
              chunkKind: "abstract",
              paperContext,
            },
          ],
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [activeReaderPaper],
        resolvePaperContextTarget: () => activeReaderPaper,
      } as never,
    );
    const validated = tool.validate({ sections: ["Abstract"] });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const output = await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        conversationKind: "paper",
        activeItemId: activeReaderPaper.itemId,
      },
    });
    const first = (output as { results: Array<Record<string, unknown>> })
      .results[0];
    assert.deepInclude(
      first.paperContext as Record<string, unknown>,
      activeReaderPaper,
    );
  });

  it("paper_read still accepts explicit collection-enumerated targets in library chat", async function () {
    const collectionPaper = {
      itemId: 11,
      contextItemId: 22,
      title: "Collection Paper",
    };
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async () => ({
          chunks: ["collection paper abstract"],
          chunkMeta: [
            {
              chunkIndex: 0,
              text: "collection paper abstract",
              sectionLabel: "Abstract",
              chunkKind: "abstract",
            },
          ],
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [],
        resolvePaperContextTarget: () => collectionPaper,
      } as never,
    );
    const validated = tool.validate({
      target: [{ itemId: 11, contextItemId: 22 }],
      sections: ["Abstract"],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const output = await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        conversationKind: "global",
        selectedCollectionContexts: [
          { collectionId: 4, name: "Computational_Psychiatry", libraryID: 1 },
        ],
      },
    });
    const first = (output as { results: Array<Record<string, unknown>> })
      .results[0];
    assert.deepEqual(first.paperContext, collectionPaper);
  });

  it("paper_read labels without images fail with an actionable fix", function () {
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const validated = tool.validate({ labels: ["Figure 3"] });
    assert.equal(validated.ok, false);
    if (!validated.ok) return;
    assert.include(validated.error, "labels select extracted figure/table crops");
    assert.include(validated.error, "Add images:true");
  });

  it("paper_read visual still renders explicit PDF pages for MinerU papers", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "MinerU Figure Paper",
      firstCreator: "Miller",
      year: "2025",
      mineruCacheDir: "/tmp/mineru-paper",
    };
    let requestedPages: number[] = [];
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {
        preparePagesForModel: async ({ pages }: { pages: number[] }) => {
          requestedPages = pages;
          return {
            target: {
              source: "library",
              title: "MinerU Figure Paper",
              paperContext,
              contextItemId: 22,
              itemId: 11,
            },
            pages: [
              {
                pageIndex: 3,
                pageLabel: "4",
                imagePath: "/tmp/page-4.png",
                contentHash: "hash-page-4",
              },
            ],
            artifacts: [
              {
                kind: "image" as const,
                mimeType: "image/png",
                storedPath: "/tmp/page-4.png",
                pageIndex: 3,
                pageLabel: "4",
              },
            ],
            pageTexts: { 3: "Rendered page text" },
          };
        },
      } as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({
      target: { paperContext },
      pages: [4],
      images: true,
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        userText: "Render page 4 from the raw PDF",
        selectedPaperContexts: [paperContext],
      },
    })) as {
      content?: { pageCount?: number };
      artifacts?: unknown[];
    };

    assert.deepEqual(requestedPages, [3]);
    assert.equal(output.content?.pageCount, 1);
    assert.lengthOf(output.artifacts || [], 1);
  });

  it("paper_read exposes a coordinate schema without a mode enum", function () {
    const registry = createTestBuiltInRegistry();
    const tool = registry.getTool("paper_read");
    assert.exists(tool);
    const schema = tool!.spec.inputSchema as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };

    assert.isFalse(schema.additionalProperties);
    assert.deepEqual(Object.keys(schema.properties || {}).sort(), [
      "images",
      "labels",
      "pages",
      "readFullReason",
      "sections",
      "target",
    ]);
  });

  it("paper_read figures accepts library PDFs without MinerU cache", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "PDF Figure Paper",
      firstCreator: "Miller",
      year: "2025",
    };
    const extractionContexts: unknown[] = [];
    let receivedQuery: unknown = "unset";
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
      {
        extractFigures: async ({ input, paperContexts }) => {
          receivedQuery = input.query;
          extractionContexts.push(...paperContexts);
          return {
            mode: "figures",
            status: "ok",
            query: "Figure 1",
            figures: [
              {
                id: "figure-1",
                label: "Figure 1",
                cropPath:
                  "/tmp/zotero/llm-for-zotero-pdf-figure-crops/22/figure_crops/crops/figure-1.png",
              },
            ],
          };
        },
      },
    );
    const validated = tool.validate({
      labels: ["Figure 1"],
      images: true,
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const output = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        userText: "Explain Figure 1",
        selectedPaperContexts: [paperContext],
      },
    })) as Record<string, unknown>;

    assert.equal(output.mode, "figures");
    assert.equal(output.status, "ok");
    // labels are joined into the crop extractor's query string.
    assert.equal(receivedQuery, "Figure 1");
    assert.deepInclude(
      extractionContexts[0] as Record<string, unknown>,
      paperContext,
    );
  });

  it("paper_read figures hydrates MinerU cache metadata from the Zotero attachment", async function () {
    const scopedPaperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Scoped Figure Paper",
      firstCreator: "Miller",
      year: "2025",
    };
    const extractionContexts: unknown[] = [];
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [scopedPaperContext],
        resolvePaperContextTarget: () => scopedPaperContext,
        getAllChildAttachmentInfos: async () => [
          {
            contextItemId: 22,
            title: "Scoped Figure Paper.pdf",
            contentType: "application/pdf",
            indexingState: "indexed",
            mineruCacheDir: "/tmp/mineru-paper",
          },
        ],
      } as never,
      {
        extractFigures: async ({ paperContexts }) => {
          extractionContexts.push(...paperContexts);
          return {
            mode: "figures",
            status: "ok",
            query: "Explain Figure 1",
            figures: [
              {
                id: "figure-1",
                label: "Figure 1",
                cropPath: "/tmp/mineru-paper/figure_crops/crops/figure-1.png",
              },
            ],
          };
        },
      },
    );
    const validated = tool.validate({
      labels: ["Figure 1"],
      images: true,
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const output = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        userText: "Explain Figure 1",
        selectedPaperContexts: [scopedPaperContext],
      },
    })) as Record<string, unknown>;

    assert.equal(output.status, "ok");
    assert.deepInclude(extractionContexts[0] as Record<string, unknown>, {
      ...scopedPaperContext,
      libraryID: 1,
      mineruCacheDir: "/tmp/mineru-paper",
      contentSourceMode: "mineru",
    });
  });

  it("paper_read figures returns extracted PDF crops and never MinerU image artifacts", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "MinerU Figure Paper",
      firstCreator: "Miller",
      year: "2025",
      mineruCacheDir: "/tmp/mineru-paper",
    };
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
      {
        extractFigures: async () => ({
          mode: "figures",
          status: "ok",
          query: "Explain Figure 1",
          figures: [
            {
              id: "figure-1",
              label: "Figure 1",
              baseLabel: "Figure 1",
              pageNumber: 2,
              cropPath: "/tmp/mineru-paper/figure_crops/crops/figure-1.png",
              captionText: "Figure 1. A precise crop.",
              rect: { left: 10, top: 20, width: 300, height: 200 },
              confidence: 0.96,
              source: "caption-bounded-region",
              warnings: [],
              mineruBlockId: "block-1",
              mineruImagePaths: ["/tmp/mineru-paper/images/fig1-panel.png"],
            },
          ],
          expectedFigures: [
            {
              label: "Figure 1",
              baseLabel: "Figure 1",
              pageNumber: 2,
              captionPageNumber: 2,
              status: "ok",
            },
            {
              label: "Figure 2",
              baseLabel: "Figure 2",
              pageNumber: 4,
              captionPageNumber: 5,
              status: "no_confident_candidate",
            },
          ],
          missingFigures: [
            {
              label: "Figure 2",
              baseLabel: "Figure 2",
              pageNumber: 4,
              captionPageNumber: 5,
              status: "no_confident_candidate",
            },
          ],
          artifacts: [
            {
              kind: "image" as const,
              mimeType: "image/png",
              storedPath: "/tmp/mineru-paper/figure_crops/crops/figure-1.png",
              title: "Figure 1",
              pageIndex: 1,
              pageLabel: "2",
              paperContext,
            },
          ],
        }),
      },
    );
    const validated = tool.validate({
      labels: ["Figure 1"],
      images: true,
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const output = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        userText: "Explain Figure 1",
        selectedPaperContexts: [paperContext],
      },
    })) as {
      content?: {
        mode?: string;
        status?: string;
        expectedFigures?: Array<{ label?: string }>;
        missingFigures?: Array<{ label?: string }>;
        figures?: Array<{ cropPath?: string; mineruImagePaths?: string[] }>;
      };
      artifacts?: Array<{ storedPath?: string }>;
    };

    assert.equal(output.content?.mode, "figures");
    assert.equal(output.content?.status, "ok");
    assert.equal(
      output.content?.figures?.[0]?.cropPath,
      "/tmp/mineru-paper/figure_crops/crops/figure-1.png",
    );
    assert.deepEqual(
      output.content?.missingFigures?.map((figure) => figure.label),
      ["Figure 2"],
    );
    assert.deepEqual(output.content?.figures?.[0]?.mineruImagePaths, [
      "/tmp/mineru-paper/images/fig1-panel.png",
    ]);
    assert.deepEqual(
      (output.artifacts || []).map((artifact) => artifact.storedPath),
      ["/tmp/mineru-paper/figure_crops/crops/figure-1.png"],
    );
  });

  it("paper_read figures returns cached PDF crops before source-PDF extraction", async function () {
    const originalIOUtils = globalScope.IOUtils;
    const cropPath = "/tmp/mineru-paper/figure_crops/crops/figure-1.png";
    const manifest = {
      sections: [],
      allFigures: [
        {
          label: "Figure 1",
          baseLabel: "Figure 1",
          page: 2,
          caption: "Figure 1. A cached crop.",
        },
      ],
      allTables: [],
    };
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "MinerU Figure Paper",
      firstCreator: "Miller",
      year: "2025",
      mineruCacheDir: "/tmp/mineru-paper",
    };
    const files = new Map<string, Uint8Array>([
      [
        "/tmp/mineru-paper/manifest.json",
        encoder.encode(JSON.stringify(manifest)),
      ],
      [cropPath, encoder.encode("png")],
      [
        "/tmp/mineru-paper/figure_crops/figure_geometry.json",
        encoder.encode(
          JSON.stringify({
            version: PDF_FIGURE_CROP_CACHE_VERSION,
            attachmentId: 22,
            manifestHash: buildPdfFigureCropManifestHash(manifest),
            pdfFingerprint: buildPdfFigureCropPdfFingerprint(paperContext),
            renderScale: 1.8,
            algorithmVersion: PDF_FIGURE_CROP_ALGORITHM_VERSION,
            generatedAt: 1,
            expectedFigures: [
              {
                label: "Figure 1",
                baseLabel: "Figure 1",
                pageNumber: 2,
                status: "ok",
                cropPath: "/var/folders/tmp/old-crop.png",
              },
            ],
            missingFigures: [],
            entries: [
              {
                id: "figure-1",
                label: "Figure 1",
                baseLabel: "Figure 1",
                pageNumber: 2,
                cropPath,
                captionText: "Figure 1. A cached crop.",
                rect: { left: 10, top: 20, width: 300, height: 200 },
                confidence: 0.96,
                source: "pdf-image-object",
                warnings: [],
                mineruImagePaths: [],
              },
            ],
          }),
        ),
      ],
    ]);
    globalScope.IOUtils = {
      read: async (path: string) => {
        const bytes = files.get(path);
        if (!bytes) throw new Error(`missing ${path}`);
        return bytes;
      },
      write: async (path: string, bytes: Uint8Array) => {
        files.set(path, bytes);
      },
      makeDirectory: async () => undefined,
    };
    let rawCalled = false;
    try {
      const registry = createBuiltInToolRegistry({
        zoteroGateway: {
          listPaperContexts: () => [paperContext],
          resolvePaperContextTarget: () => paperContext,
        } as never,
        pdfService: {} as never,
        pdfPageService: {
          extractFiguresFromSourcePdf: async () => {
            rawCalled = true;
            throw new Error("source extraction should not run");
          },
        } as never,
        retrievalService: {} as never,
      });
      const tool = registry.getTool("paper_read");
      assert.exists(tool);
      // images:true without labels is the "all figures" preset.
      const validated = tool!.validate({ images: true });
      assert.equal(validated.ok, true);
      if (!validated.ok) return;

      const output = (await tool!.execute(validated.value, {
        ...baseContext,
        request: resolvedAgentRequest({
          ...baseContext.request,
          userText: "Explain Figure 1",
          selectedPaperContexts: [paperContext],
        }),
      })) as {
        content?: { status?: string; figures?: Array<{ cropPath?: string }> };
        artifacts?: Array<{ storedPath?: string }>;
      };

      assert.isFalse(rawCalled);
      assert.equal(output.content?.status, "ok");
      assert.deepEqual(
        output.content?.figures?.map((figure) => figure.cropPath),
        [cropPath],
      );
      assert.deepEqual(
        output.artifacts?.map((artifact) => artifact.storedPath),
        [cropPath],
      );
    } finally {
      if (originalIOUtils === undefined) {
        delete globalScope.IOUtils;
      } else {
        globalScope.IOUtils = originalIOUtils;
      }
    }
  });

  it("paper_read visual renders PDF pages when MinerU cache is absent", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "PDF Figure Paper",
      firstCreator: "Miller",
      year: "2025",
    };
    let requestedPages: number[] = [];
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {
        preparePagesForModel: async ({ pages }: { pages: number[] }) => {
          requestedPages = pages;
          return {
            target: {
              source: "library",
              title: "PDF Figure Paper",
              paperContext,
              contextItemId: 22,
              itemId: 11,
            },
            pages: [
              {
                pageIndex: 1,
                pageLabel: "2",
                imagePath: "/tmp/page-2.png",
                contentHash: "hash-page-2",
              },
            ],
            artifacts: [
              {
                kind: "image" as const,
                mimeType: "image/png",
                storedPath: "/tmp/page-2.png",
                pageIndex: 1,
                pageLabel: "2",
              },
            ],
            pageTexts: { 1: "Rendered page text" },
          };
        },
      } as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({
      target: { paperContext },
      pages: [2],
      images: true,
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        userText: "Explain Figure 1",
        selectedPaperContexts: [paperContext],
      },
    })) as {
      content?: { pageCount?: number };
      artifacts?: unknown[];
    };

    assert.deepEqual(requestedPages, [1]);
    assert.equal(output.content?.pageCount, 1);
    assert.lengthOf(output.artifacts || [], 1);
  });

  it("paper_query returns grouped per-paper evidence while preserving flat results", async function () {
    const firstPaper = {
      itemId: 11,
      contextItemId: 22,
      title: "First Paper",
      firstCreator: "Huys",
      year: "2016",
    };
    const secondPaper = {
      itemId: 33,
      contextItemId: 44,
      title: "Second Paper",
      firstCreator: "Montague",
      year: "2012",
    };
    const tool = createPaperQueryTool(
      {
        ensurePaperContext: async () => ({ chunks: ["methods"] }),
      } as never,
      {
        retrieveEvidence: async () => [
          {
            paperContext: firstPaper,
            chunkIndex: 1,
            sectionLabel: "Methods",
            text: "First method passage.",
            score: 4.5,
            citationLabel: "Huys, 2016",
            sourceLabel: "(Huys, 2016)",
            pageIndex: 4,
            pageLabel: "5",
          },
          {
            paperContext: secondPaper,
            chunkIndex: 2,
            sectionLabel: "Methods",
            text: "Second method passage.",
            score: 3.5,
            citationLabel: "Montague, 2012",
            sourceLabel: "(Montague, 2012)",
            pageIndex: 7,
            pageLabel: "8",
          },
        ],
      } as never,
      {
        resolvePaperContextTarget: ({ itemId }: { itemId?: number }) =>
          itemId === firstPaper.itemId ? firstPaper : secondPaper,
        listPaperContexts: () => [firstPaper, secondPaper],
      },
    );
    const validated = tool.validate({
      query: "methods methodology method section",
      target: [
        { itemId: 11, contextItemId: 22 },
        { itemId: 33, contextItemId: 44 },
      ],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      mode?: string;
      results?: unknown[];
      quoteCitations?: Array<{
        id: string;
        quoteText: string;
        citationLabel: string;
        pageHintIndex?: number;
        pageHintLabel?: string;
      }>;
      papers?: Array<{
        status?: string;
        sourceLabel?: string;
        passages?: Array<{
          text?: string;
          sectionLabel?: string;
          pageLabel?: string;
          quoteCitationId?: string;
        }>;
      }>;
    };
    assert.equal(output.mode, "targeted");
    assert.lengthOf(output.results || [], 2);
    assert.lengthOf(output.papers || [], 2);
    assert.deepEqual(
      output.papers?.map((paper) => paper.status),
      ["matched", "matched"],
    );
    assert.equal(output.papers?.[0]?.sourceLabel, "(Huys, 2016)");
    assert.equal(output.papers?.[0]?.passages?.[0]?.sectionLabel, "Methods");
    assert.equal(
      output.papers?.[1]?.passages?.[0]?.text,
      "Second method passage.",
    );
    assert.lengthOf(output.quoteCitations || [], 2);
    assert.equal(
      output.quoteCitations?.[0]?.quoteText,
      "First method passage.",
    );
    assert.equal(output.quoteCitations?.[0]?.citationLabel, "(Huys, 2016)");
    assert.equal(output.quoteCitations?.[0]?.pageHintIndex, 4);
    assert.equal(output.quoteCitations?.[0]?.pageHintLabel, "5");
    assert.equal(output.papers?.[0]?.passages?.[0]?.pageLabel, "5");
    assert.equal(
      output.papers?.[0]?.passages?.[0]?.quoteCitationId,
      output.quoteCitations?.[0]?.id,
    );
    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.isFunction(onSuccess);
    if (typeof onSuccess !== "function") return;
    assert.equal(
      onSuccess({ label: "Query Paper", content: output }),
      "Found 2 passages in 2 sources",
    );
  });

  it("paper_read full processes every extractable chunk and returns coverage", async function () {
    const paperContext = {
      itemId: 51,
      contextItemId: 52,
      title: "Agent Full Read Paper",
    };
    const chunks = Array.from(
      { length: 6 },
      (_, index) => `Section ${index + 1}\nAgent evidence ${index}.`,
    );
    const seen = new Set<number>();
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async () => ({
          title: paperContext.title,
          chunks,
          chunkMeta: chunks.map((text, chunkIndex) => ({
            chunkIndex,
            text,
            normalizedText: text,
            chunkKind: "body",
          })),
          chunkStats: [],
          docFreq: {},
          avgChunkLength: 0,
          fullLength: chunks.join("\n\n").length,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        resolvePaperContextTarget: () => paperContext,
        listPaperContexts: () => [paperContext],
      } as never,
      undefined,
      async (batch) => {
        for (const chunk of batch.chunks) seen.add(chunk.chunkIndex);
        return {
          digest: `Read ${batch.chunks.map((chunk) => chunk.chunkIndex).join(",")}`,
          relevantChunkIds: batch.chunks.map((chunk) => chunk.chunkIndex),
        };
      },
    );
    const validated = tool.validate({
      target: { itemId: 51, contextItemId: 52 },
      readFullReason: "verify chunk coverage",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        userText: "Read the complete text.",
      },
    })) as {
      mode: string;
      status: string;
      coverageReceipt: {
        complete: boolean;
        processedChunks: number;
        totalChunks: number;
      };
    };

    assert.equal(output.mode, "full");
    assert.equal(output.status, "complete");
    assert.isTrue(output.coverageReceipt.complete);
    assert.equal(output.coverageReceipt.processedChunks, 6);
    assert.equal(output.coverageReceipt.totalChunks, 6);
    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5],
    );
  });

  it("paper_read full uses a tool-free native Codex completion in the production registry", async function () {
    const originalSpawn = CodexAppServerProcess.spawn;
    const originalToolkit = (
      globalThis as typeof globalThis & { ztoolkit?: unknown }
    ).ztoolkit;
    const originalZotero = globalThis.Zotero;
    const paperContext = {
      itemId: 53,
      contextItemId: 54,
      title: "Native Full Read Paper",
    };
    const chunks = ["Native evidence zero.", "Native evidence one."];
    let appServerSpawnCount = 0;
    let requestBody: Record<string, unknown> | null = null;
    CodexAppServerProcess.spawn = async () => {
      appServerSpawnCount += 1;
      throw new Error("paper_read full must not launch an agent thread");
    };
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: { get: () => "" },
    } as typeof Zotero;
    (
      globalThis as typeof globalThis & {
        ztoolkit: { getGlobal: (name: string) => unknown; log: () => void };
      }
    ).ztoolkit = {
      getGlobal: (name: string) => {
        if (name === "process") return { env: { HOME: "/home/tester" } };
        if (name === "IOUtils") {
          return {
            exists: async () => true,
            read: async () =>
              new TextEncoder().encode(
                JSON.stringify({
                  tokens: { access_token: "test-access-token" },
                }),
              ),
          };
        }
        if (name === "fetch") {
          return async (_url: string, init?: RequestInit) => {
            requestBody = JSON.parse(String(init?.body || "{}")) as Record<
              string,
              unknown
            >;
            return {
              ok: true,
              status: 200,
              statusText: "OK",
              body: undefined,
              json: async () => ({
                output_text:
                  '{"digest":"Read every native chunk","relevantChunkIds":[0,1]}',
              }),
              text: async () => "",
            };
          };
        }
        return undefined;
      },
      log: () => undefined,
    };

    try {
      const registry = createBuiltInToolRegistry({
        zoteroGateway: {
          resolvePaperContextTarget: () => paperContext,
          listPaperContexts: () => [paperContext],
        } as never,
        pdfService: {
          ensurePaperContext: async () => ({
            title: paperContext.title,
            chunks,
            chunkMeta: chunks.map((text, chunkIndex) => ({
              chunkIndex,
              text,
              normalizedText: text,
              chunkKind: "body",
            })),
            chunkStats: [],
            docFreq: {},
            avgChunkLength: 0,
            fullLength: chunks.join("\n\n").length,
          }),
        } as never,
        pdfPageService: {} as never,
        retrievalService: {} as never,
      });
      const tool = registry.getTool("paper_read");
      assert.exists(tool);
      const validated = tool!.validate({
        target: { paperContext },
        readFullReason: "verify chunk coverage",
      });
      assert.equal(validated.ok, true);
      if (!validated.ok) return;

      const output = (await tool!.execute(validated.value, {
        ...baseContext,
        request: resolvedAgentRequest({
          ...baseContext.request,
          userText: "Read the complete text.",
          authMode: "codex_app_server",
          model: "gpt-5.5",
          apiBase: "/tmp/codex",
          selectedPaperContexts: [paperContext],
        }),
      })) as {
        status: string;
        coverageReceipt: {
          complete: boolean;
          processedChunks: number;
          totalChunks: number;
        };
      };

      assert.equal(output.status, "complete", JSON.stringify(output));
      assert.isTrue(output.coverageReceipt.complete);
      assert.equal(output.coverageReceipt.processedChunks, 2);
      assert.equal(output.coverageReceipt.totalChunks, 2);
      assert.equal(appServerSpawnCount, 0);
      assert.equal(requestBody?.model, "gpt-5.5");
      assert.notProperty(requestBody || {}, "tools");
      assert.notProperty(requestBody || {}, "tool_choice");
      assert.include(JSON.stringify(requestBody?.input), chunks[0]);
      assert.include(JSON.stringify(requestBody?.input), chunks[1]);
    } finally {
      CodexAppServerProcess.spawn = originalSpawn;
      (
        globalThis as typeof globalThis & {
          ztoolkit?: typeof originalToolkit;
        }
      ).ztoolkit = originalToolkit;
      (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
        originalZotero;
    }
  });

  it("paper_read full resolves active, ordinal, and all-selected targets", async function () {
    const firstPaper = {
      itemId: 61,
      contextItemId: 62,
      title: "First Selected Paper",
    };
    const activePaper = {
      itemId: 71,
      contextItemId: 72,
      title: "Active Selected Paper",
    };
    const prepared: string[] = [];
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async (paperContext: typeof firstPaper) => {
          prepared.push(paperContext.title);
          const text = `Complete text for ${paperContext.title}`;
          return {
            title: paperContext.title,
            chunks: [text],
            chunkMeta: [
              {
                chunkIndex: 0,
                text,
                normalizedText: text,
                chunkKind: "body",
              },
            ],
            chunkStats: [],
            docFreq: {},
            avgChunkLength: 0,
            fullLength: text.length,
          };
        },
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [firstPaper, activePaper],
        resolvePaperContextTarget: ({
          itemId,
          contextItemId,
        }: {
          itemId?: number;
          contextItemId?: number;
        }) =>
          [firstPaper, activePaper].find(
            (paper) =>
              (!itemId || paper.itemId === itemId) &&
              (!contextItemId || paper.contextItemId === contextItemId),
          ) || null,
      } as never,
      undefined,
      async (batch) => ({
        digest: `Read ${batch.paperTitle}`,
        relevantChunkIds: [0],
      }),
    );
    const legacyMode = tool.validate({ mode: "full" });
    assert.equal(legacyMode.ok, false);
    if (legacyMode.ok) return;
    assert.include(
      legacyMode.error,
      "no longer takes 'mode'",
      "the legacy mode enum must fail closed with a migration hint",
    );
    assert.include(
      legacyMode.error,
      "readFullReason",
      "the migration hint must point at the readFullReason coordinate",
    );

    const validated = tool.validate({
      readFullReason: "verify every reference entry against its DOI",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;

    const explicit = tool.validate({
      target: { paperContext: activePaper },
      readFullReason: "the user named this exact paper",
    });
    assert.equal(explicit.ok, true);
    if (!explicit.ok) return;
    // An explicit model-supplied target is trusted (the readFullReason
    // argument is the explicit gate now); it must read exactly that paper
    // regardless of how the user phrased the request.
    await tool.execute(explicit.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        conversationKind: "paper",
        activeItemId: activePaper.itemId,
        selectedPaperContexts: [activePaper, firstPaper],
        userText: "Rather than read the full paper, summarize the abstract.",
      },
    });
    assert.deepEqual(prepared, [activePaper.title]);
    prepared.length = 0;

    await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        conversationKind: "paper",
        activeItemId: activePaper.itemId,
        selectedPaperContexts: [firstPaper, activePaper],
        userText: "Read the complete paper before answering.",
      },
    });
    assert.deepEqual(prepared, [activePaper.title]);

    prepared.length = 0;
    await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        conversationKind: "paper",
        activeItemId: activePaper.itemId,
        selectedPaperContexts: [activePaper, firstPaper],
        userText: "Read the complete first selected paper.",
      },
    });
    assert.deepEqual(prepared, [firstPaper.title]);

    prepared.length = 0;
    const allSelectedOutput = (await tool.execute(validated.value, {
      ...baseContext,
      request: {
        ...baseContext.request,
        conversationKind: "paper",
        activeItemId: activePaper.itemId,
        selectedPaperContexts: [firstPaper, activePaper],
        userText: "Read all selected papers in full.",
      },
    })) as { coverageReceipt: { paperCount: number } };
    assert.deepEqual(prepared, [firstPaper.title]);
    assert.equal(allSelectedOutput.coverageReceipt.paperCount, 1);
  });

  it("paper_read pages returns exact page text without semantic retrieval", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Page Scoped Paper",
      firstCreator: "Huys",
      year: "2016",
    };
    let retrievalCalls = 0;
    let requestedPages: number[] = [];
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async () => {
          throw new Error(
            "semantic retrieval should not prepare paper context",
          );
        },
      } as never,
      {
        retrieveEvidence: async () => {
          retrievalCalls += 1;
          return [];
        },
      } as never,
      {
        readPageTexts: async ({ pages }: { pages: number[] }) => {
          requestedPages = pages;
          return {
            target: {
              source: "library",
              title: "Page Scoped Paper",
              mimeType: "application/pdf",
              storedPath: "/tmp/page-scoped.pdf",
              paperContext,
              contextItemId: 22,
              itemId: 11,
            },
            pages: [
              {
                pageIndex: 1,
                pageLabel: "2",
                text: "Only page two text should be returned.",
              },
            ],
          };
        },
      } as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({
      pages: [2],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      results?: Array<Record<string, unknown>>;
      quoteCitations?: Array<{
        quoteText: string;
        citationLabel: string;
        pageHintIndex?: number;
        pageHintLabel?: string;
      }>;
      papers?: Array<{
        passages?: Array<{ pageLabel?: string; text?: string }>;
      }>;
    };
    assert.equal(retrievalCalls, 0);
    assert.deepEqual(requestedPages, [1]);
    assert.lengthOf(output.results || [], 1);
    assert.equal(output.results?.[0]?.pageLabel, "2");
    assert.equal(
      output.papers?.[0]?.passages?.[0]?.text,
      "Only page two text should be returned.",
    );
    assert.equal(output.papers?.[0]?.passages?.[0]?.pageLabel, "2");
    assert.lengthOf(output.quoteCitations || [], 1);
    assert.equal(
      output.quoteCitations?.[0]?.quoteText,
      "Only page two text should be returned.",
    );
    assert.equal(output.quoteCitations?.[0]?.citationLabel, "(Huys, 2016)");
    assert.equal(output.quoteCitations?.[0]?.pageHintIndex, 1);
    assert.equal(output.quoteCitations?.[0]?.pageHintLabel, "2");
  });

  it("paper_read pages groups explicit page reads across multiple targets", async function () {
    const firstPaper = {
      itemId: 11,
      contextItemId: 22,
      title: "First Page Paper",
      firstCreator: "Huys",
      year: "2016",
    };
    const secondPaper = {
      itemId: 33,
      contextItemId: 44,
      title: "Second Page Paper",
      firstCreator: "Montague",
      year: "2012",
    };
    const pageReadItemIds: number[] = [];
    const tool = createPaperReadTool(
      {} as never,
      {
        retrieveEvidence: async () => {
          throw new Error(
            "semantic retrieval should not run for explicit pages",
          );
        },
      } as never,
      {
        readPageTexts: async ({
          paperContext,
        }: {
          paperContext: typeof firstPaper;
          pages: number[];
        }) => {
          pageReadItemIds.push(paperContext.itemId);
          return {
            target: {
              source: "library",
              title: paperContext.title,
              mimeType: "application/pdf",
              storedPath: `/tmp/${paperContext.itemId}.pdf`,
              paperContext,
              contextItemId: paperContext.contextItemId,
              itemId: paperContext.itemId,
            },
            pages: [
              {
                pageIndex: 2,
                pageLabel: "3",
                text:
                  paperContext.itemId === firstPaper.itemId
                    ? "First page-scoped passage."
                    : "Second page-scoped passage.",
              },
            ],
          };
        },
      } as never,
      {
        listPaperContexts: () => [firstPaper, secondPaper],
        resolvePaperContextTarget: ({ itemId }: { itemId?: number }) =>
          itemId === firstPaper.itemId ? firstPaper : secondPaper,
      } as never,
    );
    const validated = tool.validate({
      pages: [3],
      target: [
        { itemId: 11, contextItemId: 22 },
        { itemId: 33, contextItemId: 44 },
      ],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      results?: unknown[];
      papers?: Array<{
        sourceLabel?: string;
        passages?: Array<{ text?: string; pageLabel?: string }>;
      }>;
    };
    assert.deepEqual(pageReadItemIds, [11, 33]);
    assert.lengthOf(output.results || [], 2);
    assert.lengthOf(output.papers || [], 2);
    assert.equal(output.papers?.[0]?.sourceLabel, "(Huys, 2016)");
    assert.equal(
      output.papers?.[0]?.passages?.[0]?.text,
      "First page-scoped passage.",
    );
    assert.equal(
      output.papers?.[1]?.passages?.[0]?.text,
      "Second page-scoped passage.",
    );
    assert.equal(output.papers?.[1]?.passages?.[0]?.pageLabel, "3");
  });

  it("paper_query dedupes duplicate default paper contexts", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Memory Palace Paper",
      firstCreator: "Chandra et al.",
      year: "2025",
    };
    let retrievedPapers: unknown[] = [];
    const tool = createPaperQueryTool(
      {
        ensurePaperContext: async () => ({ chunks: ["memory"] }),
      } as never,
      {
        retrieveEvidence: async ({
          papers,
        }: {
          papers: (typeof paperContext)[];
        }) => {
          retrievedPapers = papers;
          return [
            {
              paperContext,
              chunkIndex: 1,
              sectionLabel: "Results",
              text: "First memory palace passage.",
              score: 4.5,
              citationLabel: "Chandra et al., 2025",
              sourceLabel: "(Chandra et al., 2025)",
            },
            {
              paperContext,
              chunkIndex: 2,
              sectionLabel: "Discussion",
              text: "Second memory palace passage.",
              score: 3.5,
              citationLabel: "Chandra et al., 2025",
              sourceLabel: "(Chandra et al., 2025)",
            },
          ];
        },
      } as never,
      {
        listPaperContexts: () => [paperContext, { ...paperContext }],
        resolvePaperContextTarget: () => paperContext,
      },
    );
    const validated = tool.validate({
      query: "memory palace",
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      results?: unknown[];
      papers?: unknown[];
    };
    assert.lengthOf(retrievedPapers, 1);
    assert.lengthOf(output.results || [], 2);
    assert.lengthOf(output.papers || [], 1);
    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.isFunction(onSuccess);
    if (typeof onSuccess !== "function") return;
    assert.equal(
      onSuccess({ label: "Query Paper", content: output }),
      "Found 2 passages in (Chandra et al., 2025)",
    );
  });

  it("paper_query dedupes duplicate explicit targets", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Memory Palace Paper",
      firstCreator: "Chandra et al.",
      year: "2025",
    };
    let retrievedPapers: unknown[] = [];
    const tool = createPaperQueryTool(
      {
        ensurePaperContext: async () => ({ chunks: ["memory"] }),
      } as never,
      {
        retrieveEvidence: async ({
          papers,
        }: {
          papers: (typeof paperContext)[];
        }) => {
          retrievedPapers = papers;
          return [
            {
              paperContext,
              chunkIndex: 1,
              sectionLabel: "Results",
              text: "Memory palace passage.",
              score: 4.5,
              citationLabel: "Chandra et al., 2025",
              sourceLabel: "(Chandra et al., 2025)",
            },
          ];
        },
      } as never,
      {
        listPaperContexts: () => [],
        resolvePaperContextTarget: () => paperContext,
      },
    );
    const validated = tool.validate({
      query: "memory palace",
      target: [
        { itemId: 11, contextItemId: 22 },
        { itemId: 11, contextItemId: 22 },
      ],
    });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      results?: unknown[];
      papers?: unknown[];
    };
    assert.lengthOf(retrievedPapers, 1);
    assert.lengthOf(output.results || [], 1);
    assert.lengthOf(output.papers || [], 1);
  });

  it("paper_read targeted success text counts passages separately from papers", function () {
    const tool = createPaperReadTool({} as never, {} as never, {} as never);
    const onSuccess = tool.presentation?.summaries?.onSuccess;
    assert.isFunction(onSuccess);
    if (typeof onSuccess !== "function") return;
    assert.equal(
      onSuccess({
        label: "Read Paper",
        content: {
          mode: "targeted",
          results: Array.from({ length: 8 }, (_, index) => ({
            chunkIndex: index,
          })),
          papers: [{ sourceLabel: "(Chandra et al., 2025)", passages: [] }],
        },
      }),
      "Read 8 passages from (Chandra et al., 2025)",
    );
    assert.equal(
      onSuccess({
        label: "Read Paper",
        content: {
          mode: "targeted",
          results: Array.from({ length: 4 }, (_, index) => ({
            chunkIndex: index,
          })),
          papers: [
            { sourceLabel: "(Chandra et al., 2025)", passages: [] },
            { sourceLabel: "(Miller, 2024)", passages: [] },
          ],
        },
      }),
      "Read 4 passages from 2 sources",
    );
    assert.equal(
      onSuccess({
        label: "Read Paper",
        content: {
          mode: "targeted",
          papers: [
            {
              sourceLabel: "(Chandra et al., 2025)",
              passages: [{ text: "one" }, { text: "two" }],
            },
          ],
        },
      }),
      "Read 2 passages from (Chandra et al., 2025)",
    );
  });

  describe("paper_read coordinate validation", function () {
    const tool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const cases: Array<{
      name: string;
      args: Record<string, unknown>;
      errorIncludes: string[];
    }> = [
      {
        name: "legacy mode argument fails with a paper_query migration hint",
        args: { mode: "targeted", pages: [2] },
        errorIncludes: ["no longer takes 'mode'", "paper_query"],
      },
      {
        name: "legacy query argument fails with a paper_query migration hint",
        args: { query: "hippocampal evidence" },
        errorIncludes: ["no longer takes 'query'", "paper_query"],
      },
      {
        name: "legacy targets argument fails with a target migration hint",
        args: { targets: [{ itemId: 1, contextItemId: 2 }] },
        errorIncludes: ["no longer takes 'targets'"],
      },
      {
        name: "sections and pages are mutually exclusive locators",
        args: { sections: ["Methods"], pages: [3] },
        errorIncludes: ["at most one of sections, pages, labels"],
      },
      {
        name: "images cannot combine with sections",
        args: { sections: ["Methods"], images: true },
        errorIncludes: ["cannot select by sections"],
      },
      {
        name: "labels require images",
        args: { labels: ["Figure 3"] },
        errorIncludes: ["Add images:true"],
      },
      {
        name: "readFullReason excludes locator arguments",
        args: { readFullReason: "verify every reference", pages: [3] },
        errorIncludes: ["redundant with it"],
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, function () {
        const validated = tool.validate(testCase.args);
        assert.isFalse(validated.ok, JSON.stringify(testCase.args));
        if (validated.ok) return;
        for (const fragment of testCase.errorIncludes) {
          assert.include(validated.error, fragment);
        }
      });
    }
  });

  it("paper_read sections returns only the matched section text", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Sectioned Paper",
      firstCreator: "Miller",
      year: "2025",
    };
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async () => ({
          chunks: ["abstract text", "intro text", "related work text"],
          chunkMeta: [
            {
              chunkIndex: 0,
              text: "abstract text",
              sectionLabel: "Abstract",
              chunkKind: "abstract",
            },
            {
              chunkIndex: 1,
              text: "intro text",
              sectionLabel: "1 Introduction",
              chunkKind: "introduction",
            },
            {
              chunkIndex: 2,
              text: "related work text",
              sectionLabel: "2 Related Work",
              chunkKind: "introduction",
            },
          ],
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({ sections: ["related work"] });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      mode?: string;
      status?: string;
      results?: Array<{
        text?: string;
        sectionLabel?: string;
        chunkIndex?: number;
      }>;
      papers?: Array<{
        status?: string;
        passages?: Array<{ text?: string }>;
      }>;
    };

    assert.equal(output.mode, "sections");
    assert.equal(output.status, "matched");
    assert.lengthOf(output.results || [], 1);
    assert.equal(output.results?.[0]?.text, "related work text");
    assert.equal(output.results?.[0]?.sectionLabel, "2 Related Work");
    assert.equal(output.results?.[0]?.chunkIndex, 2);
    assert.deepEqual(
      (output.papers?.[0]?.passages || []).map((passage) => passage.text),
      ["related work text"],
    );
  });

  it("paper_read sections slices whole sections from a real section index", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Indexed Paper",
      firstCreator: "Garcia",
      year: "2024",
    };
    const sourceText =
      "# Abstract\nShort abstract.\n\n# 1 Introduction\nIntro paragraph.\n\n# 2 Related Work\nFirst related-work paragraph.\n\nSecond related-work paragraph spanning another chunk-sized block.\n\n# 3 Methods\nMethods text.\n";
    const heading = (title: string) => sourceText.indexOf(title);
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async () => ({
          chunks: ["chunked text"],
          chunkMeta: [
            {
              chunkIndex: 0,
              text: "chunked text",
              chunkKind: "body",
            },
          ],
          sectionIndex: [
            {
              heading: "Abstract",
              charStart: heading("# Abstract"),
              charEnd: heading("# 1 Introduction"),
            },
            {
              heading: "1 Introduction",
              charStart: heading("# 1 Introduction"),
              charEnd: heading("# 2 Related Work"),
            },
            {
              heading: "2 Related Work",
              charStart: heading("# 2 Related Work"),
              charEnd: heading("# 3 Methods"),
              page: 11,
            },
            {
              heading: "3 Methods",
              charStart: heading("# 3 Methods"),
              charEnd: sourceText.length,
            },
          ],
          sourceText,
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({ sections: ["Related Work"] });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      mode?: string;
      status?: string;
      results?: Array<{
        text?: string;
        sectionLabel?: string;
        pageStart?: number;
      }>;
      unmatched?: Array<{ requested?: string[] }>;
    };

    // The whole contiguous section comes back even though the chunk list
    // never mentioned it — the section index is the source of truth.
    assert.equal(output.mode, "sections");
    assert.equal(output.status, "matched");
    assert.lengthOf(output.results || [], 1);
    assert.equal(output.results?.[0]?.sectionLabel, "2 Related Work");
    assert.include(
      output.results?.[0]?.text || "",
      "First related-work paragraph.",
    );
    assert.include(
      output.results?.[0]?.text || "",
      "Second related-work paragraph",
    );
    assert.equal(output.results?.[0]?.pageStart, 11);
    assert.isUndefined(output.unmatched);
  });

  it("paper_read sections reports unmatched names with suggestions", async function () {
    const paperContext = {
      itemId: 11,
      contextItemId: 22,
      title: "Sectioned Paper",
      firstCreator: "Miller",
      year: "2025",
    };
    const tool = createPaperReadTool(
      {
        ensurePaperContext: async () => ({
          chunks: ["abstract text", "intro text", "related work text"],
          chunkMeta: [
            {
              chunkIndex: 0,
              text: "abstract text",
              sectionLabel: "Abstract",
              chunkKind: "abstract",
            },
            {
              chunkIndex: 1,
              text: "intro text",
              sectionLabel: "1 Introduction",
              chunkKind: "introduction",
            },
            {
              chunkIndex: 2,
              text: "related work text",
              sectionLabel: "2 Related Work",
              chunkKind: "introduction",
            },
          ],
        }),
      } as never,
      {} as never,
      {} as never,
      {
        listPaperContexts: () => [paperContext],
        resolvePaperContextTarget: () => paperContext,
      } as never,
    );
    const validated = tool.validate({ sections: ["Nonexistent Section"] });
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      mode?: string;
      status?: string;
      papers?: Array<{
        status?: string;
        requested?: string[];
        suggestions?: string[];
        availableSections?: string[];
      }>;
      guidance?: string;
    };

    assert.equal(output.mode, "sections");
    assert.equal(output.status, "no_matching_sections");
    assert.deepEqual(output.papers?.[0]?.requested, ["Nonexistent Section"]);
    assert.isArray(output.papers?.[0]?.suggestions);
    assert.deepEqual(output.papers?.[0]?.availableSections, [
      "Abstract",
      "1 Introduction",
      "2 Related Work",
    ]);
    assert.include(String(output.guidance || ""), "paper_query");
  });

  it("matches simple-paper-qa for understand-this-paper typo requests", function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["simple-paper-qa.md"])]);
    assert.include(
      getMatchedSkillIds(
        resolvedSkillRequest({
          userText: "can you help me understand this ppaer",
          selectedPaperContexts: [
            { itemId: 1, contextItemId: 2, title: "Paper" },
          ],
        }),
      ),
      "simple-paper-qa",
    );
  });

  it("compare-papers guidance prefers one targeted batched read for method comparisons", function () {
    const raw = BUILTIN_SKILL_FILES["compare-papers.md"];
    assert.include(raw, "contexts: paper-set,library-corpus");
    assert.include(raw, "start with one batched targeted read");
    assert.include(
      raw,
      "A selected Zotero collection/folder is also a valid comparison corpus",
    );
    assert.include(raw, "prefer one scoped `library_retrieve(");
    assert.include(
      raw,
      "Make follow-up `paper_query({ ... })` calls only for concrete missing dimensions",
    );
    assert.include(raw, "Apply the system citation contract");
    assert.notInclude(raw, "include short direct-source blockquotes");
  });

  it("matches compare-papers for collection-scoped comparison requests", function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["compare-papers.md"])]);

    assert.include(
      getMatchedSkillIds(
        resolvedSkillRequest({
          userText: "compare the methods of all papers in this folder",
          selectedCollectionContexts: [
            { collectionId: 4, name: "Computational_Psychiatry", libraryID: 1 },
          ],
        }),
      ),
      "compare-papers",
    );
  });

  it("allows compare-papers slash selection for selected collections", function () {
    const skill = parseSkill(BUILTIN_SKILL_FILES["compare-papers.md"]);

    assert.deepEqual(
      getSkillContextEligibility(skill, {
        userText: "",
        selectedCollectionContexts: [
          { collectionId: 4, name: "Computational_Psychiatry", libraryID: 1 },
        ],
      }),
      { eligible: true },
    );
  });

  it("matches evidence-based-qa for collection-scoped evidence requests", function () {
    setUserSkills([parseSkill(BUILTIN_SKILL_FILES["evidence-based-qa.md"])]);

    assert.include(
      getMatchedSkillIds(
        resolvedSkillRequest({
          userText: "find evidence in these papers for this claim",
          selectedCollectionContexts: [
            { collectionId: 4, name: "Computational_Psychiatry", libraryID: 1 },
          ],
        }),
      ),
      "evidence-based-qa",
    );
  });

  it("allows evidence-based-qa slash selection for selected collections", function () {
    const skill = parseSkill(BUILTIN_SKILL_FILES["evidence-based-qa.md"]);

    assert.deepEqual(
      getSkillContextEligibility(skill, {
        userText: "",
        selectedCollectionContexts: [
          { collectionId: 4, name: "Computational_Psychiatry", libraryID: 1 },
        ],
      }),
      { eligible: true },
    );
  });

  it("keeps multi-context skills selectable without attached context", function () {
    const evidenceSkill = parseSkill(
      BUILTIN_SKILL_FILES["evidence-based-qa.md"],
    );
    const compareSkill = parseSkill(BUILTIN_SKILL_FILES["compare-papers.md"]);

    assert.deepEqual(
      getSkillContextEligibility(evidenceSkill, { userText: "" }),
      { eligible: true },
    );
    assert.deepEqual(
      getSkillContextEligibility(compareSkill, { userText: "" }),
      { eligible: true },
    );
  });
});
