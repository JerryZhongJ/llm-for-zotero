import { assert } from "chai";
import { buildAgentContextBudgetState } from "../src/agent/context/budgetPolicy";
import { estimateTextTokens } from "../src/utils/modelInputCap";
import {
  buildAgentSemanticCheckpoint,
  compactAgentTranscript,
  readAgentSemanticCheckpointRootGoal,
} from "../src/agent/context/transcriptCompactor";
import type { AgentModelMessage } from "../src/agent/types";

describe("agent transcript compactor", function () {
  it("uses the profile context limit when deciding compaction thresholds", function () {
    const budget = buildAgentContextBudgetState({
      messages: [{ role: "user", content: "current request" }],
      model: "claude-haiku-4-5",
      profileOverride: {
        forModel: "claude-haiku-4-5",
        limits: { contextWindowTokens: 10_000, inputTokens: 10_000 },
      },
    });

    assert.equal(budget.contextWindow, 10_000);
    assert.equal(budget.targetTokens, 5_800);
  });

  it("creates rehydratable handles for dropped tool messages", function () {
    const messages: AgentModelMessage[] = [
      { role: "user", content: "old catalog request" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "old-call",
            name: "library_search",
            arguments: { entity: "items", mode: "list" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "old-call",
        name: "library_search",
        content: JSON.stringify({
          totalCount: 2,
          returnedCount: 2,
          results: [
            { itemId: 1, title: "Paper A" },
            { itemId: 2, title: "Paper B" },
          ],
        }),
      },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current request" },
      { role: "assistant", content: "current answer" },
    ];
    const baseBudget = buildAgentContextBudgetState({
      messages,
      model: "claude-haiku-4-5",
      inputTokenCap: 32_000,
      forceCompact: true,
    });
    const budget = {
      ...baseBudget,
      recentTailTokens: 1,
      summaryTokens: 120,
      policy: {
        ...baseBudget.policy,
        minRecentMessages: 2,
      },
    };
    const result = compactAgentTranscript({
      messages,
      budget,
      force: true,
      conversationKey: 9,
      resourceSignature: "scope-a",
    });

    assert.isTrue(result.compacted);
    assert.lengthOf(result.handleRecords, 1);
    assert.match(result.handleRecords[0].handle, /^trh_/);
    assert.lengthOf(
      (result.handleRecords[0].content as { results: unknown[] }).results,
      2,
    );
    assert.include(
      String(result.summaryMessage?.content),
      result.handleRecords[0].handle,
    );
  });
});

describe("CJK summary budget", function () {
  it("keeps the compact checkpoint within its token budget for CJK content", function () {
    const messages: AgentModelMessage[] = Array.from(
      { length: 12 },
      (_, index) =>
        index % 2 === 0
          ? {
              role: "user" as const,
              content: `问题${index}：${"神经科学研究进展。".repeat(40)}`,
            }
          : {
              role: "assistant" as const,
              content: `回答${index}：${"表征漂移的证据分析。".repeat(40)}`,
            },
    );
    messages.push({ role: "user", content: "最后的问题" });

    const result = compactAgentTranscript({
      messages,
      budget: {
        policy: { minRecentMessages: 2 } as any,
        recentTailTokens: 200,
        summaryTokens: 400,
      } as any,
      force: true,
    });

    assert.isTrue(result.compacted);
    const summary = result.summaryMessage;
    assert.isOk(summary);
    assert.isAtMost(
      estimateTextTokens(
        typeof summary?.content === "string" ? summary.content : "",
      ),
      400,
    );
  });
});

describe("continuation checkpoint featured answer", function () {
  const longAnswer = [
    "MARKER_HEAD_METHODS AND SETUP.",
    "filler ".repeat(300),
    "MARKER_MIDDLE_OMITTED",
    "filler ".repeat(300),
    "Papers to import: MARKER_TAIL_CHECKLIST item-1, item-2, item-3.",
  ].join(" ");

  const answerTurn: AgentModelMessage[] = [
    { role: "user", content: "User request: snowball the references" },
    { role: "assistant", content: longAnswer },
  ];

  it("preserves head and tail of the latest assistant final answer", function () {
    const { checkpoint } = buildAgentSemanticCheckpoint({
      messages: answerTurn,
      summaryTokens: 800,
      conversationKey: 41,
    });
    const content =
      typeof checkpoint.content === "string" ? checkpoint.content : "";
    assert.include(content, "Latest assistant answer:");
    assert.include(content, "MARKER_HEAD_METHODS");
    assert.include(content, "MARKER_TAIL_CHECKLIST");
    assert.include(content, "…");
    assert.notInclude(content, "MARKER_MIDDLE_OMITTED");
    assert.isAtMost(estimateTextTokens(content), 800);
  });

  it("features the latest answer once and keeps older answers as summary lines", function () {
    const { checkpoint } = buildAgentSemanticCheckpoint({
      messages: [
        { role: "user", content: "User request: earlier question" },
        { role: "assistant", content: "Earlier verbatim answer." },
        ...answerTurn,
      ],
      summaryTokens: 800,
      conversationKey: 42,
    });
    const content =
      typeof checkpoint.content === "string" ? checkpoint.content : "";
    const featuredCount = (content.match(/Latest assistant answer:/g) || [])
      .length;
    assert.equal(featuredCount, 1);
    const checklistOccurrences = (content.match(/MARKER_TAIL_CHECKLIST/g) || [])
      .length;
    assert.equal(checklistOccurrences, 1);
    assert.include(content, "Recent visible assistant state:");
    assert.include(content, "Earlier verbatim answer.");
  });

  it("keeps compact mode unchanged (no featured answer section)", function () {
    const messages: AgentModelMessage[] = [
      ...answerTurn,
      { role: "user", content: "current request" },
    ];
    const result = compactAgentTranscript({
      messages,
      budget: {
        policy: { minRecentMessages: 1 } as any,
        recentTailTokens: 1,
        summaryTokens: 800,
      } as any,
      force: true,
      conversationKey: 43,
    });
    assert.isTrue(result.compacted);
    const content =
      typeof result.summaryMessage?.content === "string"
        ? result.summaryMessage.content
        : "";
    assert.notInclude(content, "Latest assistant answer:");
  });

  it("does not leak the featured answer into the root goal", function () {
    const { checkpoint } = buildAgentSemanticCheckpoint({
      messages: answerTurn,
      summaryTokens: 800,
      conversationKey: 44,
    });
    const rootGoal = readAgentSemanticCheckpointRootGoal(checkpoint);
    assert.isOk(rootGoal);
    assert.notInclude(String(rootGoal), "MARKER_TAIL_CHECKLIST");
    assert.notInclude(String(rootGoal), "Latest assistant answer:");
  });

  it("drops the featured section and keeps tool handles under tiny budgets", function () {
    const messages: AgentModelMessage[] = [
      { role: "user", content: "User request: tiny budget" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "tiny-call",
            name: "library_search",
            arguments: { entity: "items" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "tiny-call",
        name: "library_search",
        content: JSON.stringify({ totalCount: 1, results: [{ itemId: 1 }] }),
      },
      { role: "assistant", content: "Short answer." },
    ];
    const { checkpoint, handleRecords } = buildAgentSemanticCheckpoint({
      messages,
      summaryTokens: 100,
      conversationKey: 45,
    });
    const content =
      typeof checkpoint.content === "string" ? checkpoint.content : "";
    assert.notInclude(content, "Latest assistant answer:");
    assert.include(content, "Stored compacted tool-result handles:");
    assert.isAbove(handleRecords.length, 0);
    for (const record of handleRecords) {
      assert.include(content, record.handle);
    }
  });
});
