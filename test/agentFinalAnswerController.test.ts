import { assert } from "chai";
import { AgentFinalAnswerController } from "../src/agent/finalization/finalAnswerController";
import type { AgentRuntimeRequest } from "../src/agent/types";

function makeRequest(
  overrides: Partial<AgentRuntimeRequest> = {},
): AgentRuntimeRequest {
  return {
    conversationKey: 1,
    mode: "agent",
    userText: "Answer the question",
    model: "test-model",
    turnPaperScope: {
      active: [],
      added: [],
      pinned: [],
      selected: [],
      collections: [],
      tags: [],
    },
    ...overrides,
  } as AgentRuntimeRequest;
}

describe("AgentFinalAnswerController", function () {
  it("allows one collection evidence correction then accepts the next final", async function () {
    const request = makeRequest({
      userText: "What methods do these papers share?",
      classifiedIntent: {
        retrievalIntent: "summarize",
        wantedSections: ["methods"],
        actionIntents: [],
      },
      turnPaperScope: {
        active: [],
        added: [],
        pinned: [],
        selected: [],
        collections: [{ collectionId: 3, name: "C", libraryID: 1 }],
        tags: [],
      },
    });
    const controller = new AgentFinalAnswerController(request, []);

    const first = await controller.evaluate({
      candidateText: "Shallow answer.",
      canCorrect: true,
      toolExecutionRecords: [],
    });
    assert.equal(first.kind, "correct");
    if (first.kind === "correct") {
      assert.notProperty(first, "actionContractRejection");
    }

    const second = await controller.evaluate({
      candidateText: "Disclosed partial answer.",
      canCorrect: true,
      toolExecutionRecords: [],
    });
    assert.equal(second.kind, "accept");
  });

  it("returns a clean assistant copy for a web-attribution correction", async function () {
    const controller = new AgentFinalAnswerController(makeRequest(), []);

    const decision = await controller.evaluate({
      candidateText: "An unsupported current claim.",
      canCorrect: true,
      toolExecutionRecords: [
        { name: "web_search", ok: true, content: { results: [] } },
      ],
    });

    assert.equal(decision.kind, "correct");
    if (decision.kind !== "correct") return;
    assert.notProperty(decision, "actionContractRejection");
    assert.equal(decision.assistantContent, "An unsupported current claim.");
    assert.include(decision.correction, "Correct the web attribution");
  });
});
