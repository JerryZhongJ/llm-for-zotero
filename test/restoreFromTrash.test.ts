import { assert } from "chai";
import { LibraryMutationService } from "../src/agent/services/libraryMutationService";
import { createRestoreFromTrashTool } from "../src/agent/tools/write/restoreFromTrash";
import { replayLibraryInverse } from "./helpers/replayLibraryInverse";

/**
 * Restoring was previously reachable only as the inverse of a mutation the
 * agent had just performed, so anything the *user* trashed — or anything
 * trashed in an earlier session — could not be recovered by asking.
 */
describe("restore_from_trash", function () {
  function makeGateway(overrides: Record<string, unknown> = {}) {
    const calls: {
      items: unknown[];
      collections: unknown[];
      searches: unknown[];
      trashed: unknown[];
      deleted: unknown[];
      deletedSearches: unknown[];
    } = {
      items: [],
      collections: [],
      searches: [],
      trashed: [],
      deleted: [],
      deletedSearches: [],
    };
    const gateway = {
      restoreItems: async (params: { itemIds: number[] }) => {
        calls.items.push(params);
        // Only ids that were actually trashed come back.
        const restored = params.itemIds.filter((id) => id !== 999);
        return { restoredCount: restored.length, itemIds: restored };
      },
      restoreCollections: async (params: { collectionIds: number[] }) => {
        calls.collections.push(params);
        const restored = params.collectionIds.filter((id) => id !== 999);
        return { restoredCount: restored.length, collectionIds: restored };
      },
      restoreSavedSearches: async (params: { savedSearchIds: number[] }) => {
        calls.searches.push(params);
        const restored = params.savedSearchIds.filter((id) => id !== 999);
        return { restoredCount: restored.length, savedSearchIds: restored };
      },
      trashItems: async (params: unknown) => {
        calls.trashed.push(params);
        return { trashedCount: 1, items: [] };
      },
      snapshotCollectionForDelete: ({
        collectionId,
      }: {
        collectionId: number;
      }) => ({
        name: `Collection ${collectionId}`,
        libraryID: 1,
        itemIds: [],
        childCollectionCount: 0,
      }),
      deleteCollection: async (params: unknown) => {
        calls.deleted.push(params);
      },
      deleteSavedSearch: async (params: { savedSearchId: number }) => {
        calls.deletedSearches.push(params);
        return { savedSearchId: params.savedSearchId, status: "trashed" };
      },
      getItem: () => null,
      // State capture for the collections/savedSearches sections reads
      // through these; null = "not present" is all the plan needs.
      getCollection: () => null,
      getSavedSearch: () => null,
      ...overrides,
    };
    return { gateway, calls };
  }

  const context = { request: { conversationKey: 1, libraryID: 1 } } as never;

  it("restores items, collections and saved searches in one call", async function () {
    const { gateway, calls } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    // The service layer still executes mixed operations: journal rows
    // recorded before the tool interface became single-responsibility must
    // stay replayable. New calls go through the split tool below.
    const outcome = await service.executeOperation(
      {
        type: "restore_from_trash",
        itemIds: [11, 12],
        collectionIds: [42],
        savedSearchIds: [7],
      },
      context,
    );

    assert.deepEqual(calls.items, [{ itemIds: [11, 12] }]);
    assert.deepEqual(calls.collections, [{ collectionIds: [42] }]);
    assert.deepEqual(calls.searches, [{ savedSearchIds: [7] }]);

    const result = (outcome.result as { result: Record<string, number> })
      .result;
    assert.equal(result.restoredItemCount, 2);
    assert.equal(result.restoredCollectionCount, 1);
    assert.equal(result.restoredSavedSearchCount, 1);
    assert.equal(result.restoredCount, 4);
  });

  it("re-trashes only what it actually restored", async function () {
    const { gateway, calls } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    // 999 was never in the trash, so restoring is a no-op for it. The inverse
    // must not sweep it up — that would trash an item the user still had.
    const outcome = await service.executeOperation(
      { type: "restore_from_trash", itemIds: [11, 999] },
      context,
    );
    assert.deepEqual(outcome.inverse?.inverseOperations, [
      { type: "trash_items", itemIds: [11] },
    ]);
    await replayLibraryInverse(service, outcome, context);

    assert.deepEqual(calls.trashed, [{ itemIds: [11] }]);
  });

  it("re-trashes only the collections and searches actually restored", async function () {
    const { gateway, calls } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    const outcome = await service.executeOperation(
      {
        type: "restore_from_trash",
        collectionIds: [42, 999],
        savedSearchIds: [7, 999],
      },
      context,
    );
    assert.deepEqual(outcome.inverse?.inverseOperations, [
      { type: "delete_collection", collectionId: 42 },
      { type: "delete_saved_search", savedSearchId: 7 },
    ]);
    await replayLibraryInverse(service, outcome, context);

    assert.deepEqual(calls.deleted, [{ collectionId: 42 }]);
    assert.deepEqual(calls.deletedSearches, [{ savedSearchId: 7 }]);
  });

  it("records no undo when nothing needed restoring", async function () {
    const { gateway } = makeGateway({
      restoreItems: async () => ({ restoredCount: 0, itemIds: [] }),
    });
    const service = new LibraryMutationService(gateway as never);

    const outcome = await service.executeOperation(
      { type: "restore_from_trash", itemIds: [999] },
      context,
    );

    assert.notExists(outcome.inverse);
  });

  it("rejects a call that names nothing to restore", function () {
    const { gateway } = makeGateway();
    const tool = createRestoreFromTrashTool(gateway as never);

    const empty = tool.validate({});
    assert.isFalse(empty.ok);

    const zeroed = tool.validate({ itemIds: [] });
    assert.isFalse(zeroed.ok);

    const valid = tool.validate({ collectionIds: [42] });
    assert.isTrue(valid.ok);
  });

  it("accepts exactly one object kind per call", function () {
    const { gateway } = makeGateway();
    const tool = createRestoreFromTrashTool(gateway as never);

    // Mixing kinds made the journalled action's undo rating an ambiguous
    // "partial"; one kind per call keeps it cleanly reversible.
    const mixed = tool.validate({ itemIds: [11], collectionIds: [42] });
    assert.isFalse(mixed.ok);

    const itemsOnly = tool.validate({ itemIds: [11] });
    assert.isTrue(itemsOnly.ok);

    const searchesOnly = tool.validate({ savedSearchIds: [7] });
    assert.isTrue(searchesOnly.ok);
  });

  it("rates every single-kind restore as fully reversible", async function () {
    const { gateway } = makeGateway();
    const service = new LibraryMutationService(gateway as never);

    // Items: the inverse (re-trash) is knowable before execution.
    const itemsPlan = await service.planOperation(
      { type: "restore_from_trash", itemIds: [11] },
      context,
    );
    assert.equal(itemsPlan.reversibility, "full");

    // Collections/searches: subcollections ride along with their parent, so
    // the inverse is frozen from Zotero's actual result (deferred) — still
    // a promised lossless undo, never a "partial".
    const collectionsPlan = await service.planOperation(
      { type: "restore_from_trash", collectionIds: [42] },
      context,
    );
    assert.equal(collectionsPlan.reversibility, "full");
    assert.isTrue(collectionsPlan.deferredInverse);
  });
});
