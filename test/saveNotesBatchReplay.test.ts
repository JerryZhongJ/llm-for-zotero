import { assert } from "chai";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { replayLibraryInverse } from "./helpers/replayLibraryInverse";

/**
 * The `note_write_batch` tool is retired — note writing goes through the
 * singular `note_write` per note, and the runtime merges several pending
 * writes into one batch confirmation. The `save_notes_batch` mutation
 * handler stays: it is the journal operation type for replay and inverse
 * execution of already-recorded actions.
 */
describe("save_notes_batch journal semantics", function () {
  let saved: Array<{ itemId: number; content: string }>;
  let trashed: number[][];
  let nextNoteId: number;

  function gateway(overrides: Record<string, unknown> = {}) {
    return {
      getItem: (id: number) =>
        id === 999
          ? null
          : {
              id,
              getDisplayTitle: () => `Paper ${id}`,
              getField: () => "",
            },
      saveAnswerToNote: async (params: {
        item: { id: number };
        content: string;
      }) => {
        saved.push({ itemId: params.item.id, content: params.content });
        return { noteId: nextNoteId++ };
      },
      trashItems: async (params: { itemIds: number[] }) => {
        trashed.push(params.itemIds);
        return { trashedCount: params.itemIds.length, items: [] };
      },
      ...overrides,
    };
  }

  const context = {
    request: { conversationKey: 1, libraryID: 1 },
    modelName: "test-model",
  } as never;

  beforeEach(function () {
    saved = [];
    trashed = [];
    nextNoteId = 500;
  });

  it("writes one note per item in a single operation", async function () {
    const service = new LibraryMutationService(gateway() as never);
    const outcome = await service.executeOperation(
      {
        type: "save_notes_batch",
        notes: [
          { targetItemId: 1, content: "Summary of one" },
          { targetItemId: 2, content: "Summary of two" },
        ],
      },
      context,
    );

    assert.deepEqual(
      saved.map((entry) => entry.itemId),
      [1, 2],
    );
    const result = (outcome.result as { result: Record<string, number> })
      .result;
    assert.equal(result.createdCount, 2);
  });

  it("keeps going when one target is bad", async function () {
    const service = new LibraryMutationService(gateway() as never);
    const outcome = await service.executeOperation(
      {
        type: "save_notes_batch",
        notes: [
          { targetItemId: 1, content: "ok" },
          { targetItemId: 999, content: "missing target" },
          { targetItemId: 2, content: "also ok" },
        ],
      },
      context,
    );
    // One bad id must not cost the other forty-nine notes.
    const result = (
      outcome.result as {
        result: { createdCount: number; failedCount: number };
      }
    ).result;
    assert.equal(result.createdCount, 2);
    assert.equal(result.failedCount, 1);
  });

  it("undoes the whole set by trashing the notes it wrote", async function () {
    const service = new LibraryMutationService(gateway() as never);
    const outcome = await service.executeOperation(
      {
        type: "save_notes_batch",
        notes: [
          { targetItemId: 1, content: "a" },
          { targetItemId: 2, content: "b" },
        ],
      },
      context,
    );
    await replayLibraryInverse(service, outcome, context as never);
    assert.deepEqual(trashed, [[500, 501]]);
  });
});
