import { assert } from "chai";
import { createPaperQueryTool } from "../src/agent/tools/read/paperQuery";
import { createPaperReadTool } from "../src/agent/tools/read/paperRead";
import type { AgentToolContext } from "../src/agent/types";

describe("paper_query", function () {
  const baseContext: AgentToolContext = {
    request: {
      conversationKey: 77,
      mode: "agent",
      userText: "find the method",
      libraryID: 1,
    },
    item: null,
    currentAnswerText: "",
    modelName: "gpt-5.5",
  };

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

  function buildTool(retrievalEvidence: unknown[]) {
    return createPaperQueryTool(
      {
        ensurePaperContext: async () => ({ chunks: ["methods"] }),
      } as never,
      {
        retrieveEvidence: async () => retrievalEvidence,
      } as never,
      {
        resolvePaperContextTarget: ({ itemId }: { itemId?: number }) =>
          itemId === firstPaper.itemId ? firstPaper : secondPaper,
        listPaperContexts: () => [firstPaper, secondPaper],
      } as never,
    );
  }

  it("requires a query", function () {
    const tool = buildTool([]);
    const validated = tool.validate({} as never);
    assert.isFalse(validated.ok);
    if (validated.ok) return;
    assert.include(validated.error, "requires a query");
  });

  it("rejects legacy retrieval params", function () {
    const tool = buildTool([]);
    const validated = tool.validate({
      query: "methods",
      queryVariants: ["method"],
    } as never);
    assert.isFalse(validated.ok);
  });

  it("accepts target as one selector or an array", function () {
    const tool = buildTool([]);
    const single = tool.validate({
      query: "methods",
      target: { itemId: 11, contextItemId: 22 },
    } as never);
    assert.isTrue(single.ok);
    const multiple = tool.validate({
      query: "methods",
      target: [
        { itemId: 11, contextItemId: 22 },
        { itemId: 33, contextItemId: 44 },
      ],
    } as never);
    assert.isTrue(multiple.ok);
  });

  it("reaches retrieveEvidence with the query and returns grouped evidence", async function () {
    let seenQuestion = "";
    let seenVariantOptions: unknown = "unset";
    const tool = createPaperQueryTool(
      { ensurePaperContext: async () => ({ chunks: ["methods"] }) } as never,
      {
        retrieveEvidence: async (params: Record<string, unknown>) => {
          seenQuestion = String(params.question);
          seenVariantOptions = params.queryVariants ?? "absent";
          return [
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
          ];
        },
      } as never,
      {
        resolvePaperContextTarget: ({ itemId }: { itemId?: number }) =>
          itemId === firstPaper.itemId ? firstPaper : secondPaper,
        listPaperContexts: () => [firstPaper, secondPaper],
      } as never,
    );
    const validated = tool.validate({
      query: "how is the method evaluated",
      target: [
        { itemId: 11, contextItemId: 22 },
        { itemId: 33, contextItemId: 44 },
      ],
    } as never);
    assert.isTrue(validated.ok);
    if (!validated.ok) return;
    const output = (await tool.execute(validated.value, baseContext)) as {
      mode?: string;
      results?: unknown[];
      papers?: Array<{ passages?: unknown[]; status?: string }>;
    };
    assert.equal(seenQuestion, "how is the method evaluated");
    assert.equal(seenVariantOptions, "absent");
    assert.equal(output.mode, "targeted");
    assert.equal(output.results?.length, 2);
    assert.equal(output.papers?.length, 2);
    assert.equal(output.papers?.[0].passages?.length, 1);
    assert.equal(output.papers?.[0].status, "matched");
  });

  it("coexists with paper_read in the built-in registry surface", function () {
    // paper_read keeps its own surface; paper_query is additive. The exact
    // registry check lives in toolSurfaceRefactor/mcpSurfaceDrift; here we
    // only assert the two factories produce distinct tool names.
    const readTool = createPaperReadTool(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const queryTool = buildTool([]);
    assert.equal(readTool.spec.name, "paper_read");
    assert.equal(queryTool.spec.name, "paper_query");
  });
});
