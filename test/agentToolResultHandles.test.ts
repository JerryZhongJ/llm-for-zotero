import { assert } from "chai";
import {
  clearAgentToolResultHandleStore,
  createAgentToolResultHandleRecord,
  hasAgentToolResultHandles,
  upsertAgentToolResultHandles,
} from "../src/agent/store/toolResultHandles";
import { createToolResultReadTool } from "../src/agent/tools/read/toolResultRead";
import type { AgentRuntimeRequest, AgentToolContext } from "../src/agent/types";

function request(conversationKey: number): AgentRuntimeRequest {
  return {
    conversationKey,
    mode: "agent",
    userText: "read stored result",
  };
}

function context(params: {
  conversationKey: number;
  resourceSignature?: string;
}): AgentToolContext {
  return {
    request: request(params.conversationKey),
    item: null,
    currentAnswerText: "",
    modelName: "test-model",
    resourceSignature: params.resourceSignature,
  };
}

async function executeRead(
  args: unknown,
  toolContext: AgentToolContext,
): Promise<Record<string, unknown>> {
  const tool = createToolResultReadTool();
  const validation = tool.validate(args);
  assert.isTrue(validation.ok);
  if (!validation.ok) throw new Error(validation.error);
  return (await tool.execute(validation.value, toolContext)) as Record<
    string,
    unknown
  >;
}

describe("agent tool-result handles", function () {
  beforeEach(function () {
    clearAgentToolResultHandleStore();
  });

  it("reads paged catalog rows from an exact stored tool result", async function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey: 1,
      toolName: "library_search",
      toolCallId: "call-catalog",
      inputDigest: "digest-a",
      resourceSignature: "scope-a",
      content: {
        totalCount: 3,
        returnedCount: 3,
        filters: { collectionId: 42 },
        results: [
          { itemId: 10, title: "Paper A" },
          { itemId: 11, title: "Paper B" },
          { itemId: 12, title: "Paper C" },
        ],
      },
    });
    assert.exists(record);
    await upsertAgentToolResultHandles([record!]);

    const output = await executeRead(
      {
        handle: record!.handle,
        path: "results",
        offset: 1,
        limit: 1,
      },
      context({ conversationKey: 1, resourceSignature: "scope-a" }),
    );

    assert.equal(output.ok, true);
    assert.equal(output.handle, record!.handle);
    assert.equal(output.totalCount, 3);
    assert.equal(output.returnedCount, 1);
    assert.equal(output.nextOffset, 2);
    assert.deepEqual(output.items, [{ itemId: 11, title: "Paper B" }]);
  });

  it("keeps the tool always visible while tracking handle availability in memory", async function () {
    // No isAvailable predicate: the tools array must stay byte-stable across
    // steps (it serializes at the front of every request, ahead of the
    // prompt-cache breakpoints), so tool_result_read is listed even before
    // any handle exists and execute() reports the absence gracefully.
    const tool = createToolResultReadTool();
    assert.isUndefined(tool.isAvailable);
    assert.isFalse(hasAgentToolResultHandles(1));

    const record = createAgentToolResultHandleRecord({
      conversationKey: 1,
      toolName: "library_search",
      toolCallId: "call-catalog",
      content: { results: [{ itemId: 1 }] },
    });
    assert.exists(record);
    await upsertAgentToolResultHandles([record!]);
    assert.isTrue(hasAgentToolResultHandles(1));

    clearAgentToolResultHandleStore();
    assert.isFalse(hasAgentToolResultHandles(1));
  });

  it("reads evidence sections with source anchors intact", async function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey: 2,
      toolName: "library_retrieve",
      toolCallId: "call-evidence",
      resourceSignature: "scope-a",
      content: {
        coverage: { indexedTextScanned: 5 },
        snippets: [
          {
            itemId: 20,
            contextItemId: 30,
            title: "Evidence Paper",
            sectionLabel: "Results",
            pageLabel: "p. 7",
            quoteCitationId: "Q_1",
            text: "Important anchored evidence.",
          },
        ],
      },
    });
    assert.exists(record);
    await upsertAgentToolResultHandles([record!]);

    const output = await executeRead(
      { handle: record!.handle, path: "snippets" },
      context({ conversationKey: 2, resourceSignature: "scope-a" }),
    );

    const items = output.items as Record<string, unknown>[];
    assert.equal(items[0].itemId, 20);
    assert.equal(items[0].contextItemId, 30);
    assert.equal(items[0].sectionLabel, "Results");
    assert.equal(items[0].pageLabel, "p. 7");
    assert.equal(items[0].quoteCitationId, "Q_1");
  });

  it("rejects cross-conversation handle access", async function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey: 3,
      toolName: "library_search",
      toolCallId: "call-catalog",
      content: { results: [{ itemId: 1 }] },
    });
    assert.exists(record);
    await upsertAgentToolResultHandles([record!]);

    const output = await executeRead(
      { handle: record!.handle, path: "results" },
      context({ conversationKey: 4 }),
    );

    assert.equal(output.ok, false);
    assert.match(String(output.error), /current conversation/);
  });

  it("blocks stale-scope handles by default and allows explicit stale reads", async function () {
    const record = createAgentToolResultHandleRecord({
      conversationKey: 5,
      toolName: "library_retrieve",
      toolCallId: "call-evidence",
      resourceSignature: "scope-old",
      content: { snippets: [{ text: "Old scoped evidence" }] },
    });
    assert.exists(record);
    await upsertAgentToolResultHandles([record!]);

    const output = await executeRead(
      { handle: record!.handle, path: "snippets" },
      context({ conversationKey: 5, resourceSignature: "scope-new" }),
    );

    assert.equal(output.ok, false);
    assert.equal(output.stale, true);
    assert.equal(output.currentResourceSignature, "scope-new");
    assert.equal(output.resourceSignature, "scope-old");
    assert.notProperty(output, "items");
    assert.notProperty(output, "value");
    assert.notProperty(output, "excerpt");
    assert.notProperty(output, "availablePaths");
    assert.notProperty(output, "snippetsCount");
    assert.include(
      String((output.warnings as string[])[0]),
      "resource scope has changed",
    );
    assert.include(String(output.error), "Re-run the source tool");

    const staleAllowed = await executeRead(
      { handle: record!.handle, path: "snippets", allowStale: true },
      context({ conversationKey: 5, resourceSignature: "scope-new" }),
    );
    assert.equal(staleAllowed.ok, true);
    assert.equal(staleAllowed.stale, true);
    assert.equal(staleAllowed.currentResourceSignature, "scope-new");
    assert.deepEqual(staleAllowed.items, [{ text: "Old scoped evidence" }]);
    assert.include(
      String((staleAllowed.warnings as string[])[0]),
      "allowStale",
    );
  });
});
