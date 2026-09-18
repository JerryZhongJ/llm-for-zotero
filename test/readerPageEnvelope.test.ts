import { assert } from "chai";
import {
  buildTurnContextEnvelope,
  renderTurnContextEnvelopeForModel,
} from "../src/agent/context/turnContextEnvelope";
import type { TurnContextEnvelopeInput } from "../src/agent/context/turnContextEnvelope";

function baseInput(): TurnContextEnvelopeInput {
  return {
    conversationKind: "paper",
    activeItemId: 11,
    activePaperTitle: "Reader Page Paper",
    selectedTexts: [],
    turnPaperScope: {
      libraryID: 1,
      conversationKind: "paper",
      papers: [],
      collections: [],
      tags: [],
      selectedPassagePaperRefs: [],
    },
  } as unknown as TurnContextEnvelopeInput;
}

describe("ambient reader page context in the turn envelope", function () {
  it("renders the open reader page line when present", function () {
    const envelope = buildTurnContextEnvelope({
      ...baseInput(),
      readerPageContext: {
        contextItemId: 22,
        pageNumber: 7,
        pageLabel: "7",
      },
    } as TurnContextEnvelopeInput);
    const rendered = renderTurnContextEnvelopeForModel(envelope);
    assert.include(rendered, "Open reader page:");
    assert.include(rendered, "contextItemId=22");
    assert.include(rendered, 'page="7"');
    assert.include(
      rendered,
      'Treat "this page" or "the current page" as that page',
    );
  });

  it("omits the line and stays non-empty when no reader is open", function () {
    const envelope = buildTurnContextEnvelope(baseInput());
    const rendered = renderTurnContextEnvelopeForModel(envelope);
    assert.notInclude(rendered, "Open reader page:");
    assert.include(rendered, "Zotero context for this turn:");
  });

  it("drops malformed reader page payloads instead of rendering noise", function () {
    const envelope = buildTurnContextEnvelope({
      ...baseInput(),
      readerPageContext: { contextItemId: 0, pageNumber: -1 },
    } as TurnContextEnvelopeInput);
    const rendered = renderTurnContextEnvelopeForModel(envelope);
    assert.notInclude(rendered, "Open reader page:");
  });
});
