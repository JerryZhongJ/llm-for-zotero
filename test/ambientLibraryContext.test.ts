import { assert } from "chai";
import {
  getAmbientCollectionFromActivePane,
  getFirstSelectedLibraryContextItem,
  resolveLibraryChatAmbientContext,
} from "../src/modules/contextPanel/ambientContext";

type PaneStub = Record<string, unknown>;

function regularItemStub(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    libraryID: 1,
    isAttachment: () => false,
    isRegularItem: () => true,
    getAttachments: () => [],
    getField: (field: string) =>
      field === "title"
        ? "Selected paper"
        : field === "firstCreator"
          ? "Author"
          : "",
    ...overrides,
  };
}

/**
 * Minimal Zotero stub covering the surfaces ambientContext.ts touches:
 * Prefs (preference gate), getActiveZoteroPane (selection + collection),
 * Collections (registry round-trip), Items (attachment lookups).
 */
function stubZotero(options: {
  ambientPref?: boolean;
  pane?: PaneStub | null;
  collections?: Record<number, { libraryID?: unknown } | false>;
}): void {
  globalThis.Zotero = {
    Prefs: {
      get: (key: string) =>
        key.endsWith(".libraryChatAmbientContext")
          ? options.ambientPref !== false
          : undefined,
    },
    getActiveZoteroPane: () => options.pane ?? null,
    Collections: {
      get: (id: number) => options.collections?.[id] ?? false,
    },
    Items: {
      get: () => null,
    },
  } as never;
}

describe("ambientLibraryContext", function () {
  const originalZotero = globalThis.Zotero;

  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("collects the first regular item from the pane selection", function () {
    const first = regularItemStub({ id: 11 });
    const pane = {
      getSelectedItems: () => [
        { id: 1, isAttachment: () => false, isRegularItem: () => false },
        first,
      ],
    };
    assert.equal(getFirstSelectedLibraryContextItem(pane as never), first);
    assert.isNull(getFirstSelectedLibraryContextItem(null));
    assert.isNull(
      getFirstSelectedLibraryContextItem({
        getSelectedItems: () => {
          throw new Error("boom");
        },
      } as never),
    );
  });

  it("returns the open collection only for registered collections", function () {
    stubZotero({
      pane: {
        getSelectedCollection: () => ({ id: 3, libraryID: 1, name: "ML" }),
      },
      collections: { 3: { libraryID: 1 } },
    });
    assert.deepEqual(getAmbientCollectionFromActivePane(), {
      collectionId: 3,
      libraryID: 1,
      name: "ML",
    });

    // Saved searches / feeds are not registered collections.
    stubZotero({
      pane: {
        getSelectedCollection: () => ({ id: 4, libraryID: 1, name: "X" }),
      },
      collections: {},
    });
    assert.isNull(getAmbientCollectionFromActivePane());

    // No pane / no selection row.
    stubZotero({ pane: null });
    assert.isNull(getAmbientCollectionFromActivePane());
    stubZotero({ pane: { getSelectedCollection: () => null } });
    assert.isNull(getAmbientCollectionFromActivePane());
  });

  it("mirrors the pane state for global conversations when enabled", function () {
    stubZotero({
      pane: {
        getSelectedCollection: () => ({ id: 3, libraryID: 1, name: "ML" }),
        getSelectedItems: () => [regularItemStub()],
      },
      collections: { 3: { libraryID: 1 } },
    });
    const ambient = resolveLibraryChatAmbientContext({
      conversationKind: "global",
      libraryID: 1,
    });
    assert.equal(ambient.collectionContext?.name, "ML");
    assert.equal(ambient.paperContext?.title, "Selected paper");
  });

  it("returns nothing for paper conversations or when disabled", function () {
    stubZotero({
      pane: {
        getSelectedCollection: () => ({ id: 3, libraryID: 1, name: "ML" }),
        getSelectedItems: () => [regularItemStub()],
      },
      collections: { 3: { libraryID: 1 } },
    });
    assert.deepEqual(
      resolveLibraryChatAmbientContext({
        conversationKind: "paper",
        libraryID: 1,
      }),
      {},
    );

    stubZotero({
      ambientPref: false,
      pane: {
        getSelectedCollection: () => ({ id: 3, libraryID: 1, name: "ML" }),
        getSelectedItems: () => [regularItemStub()],
      },
      collections: { 3: { libraryID: 1 } },
    });
    assert.deepEqual(
      resolveLibraryChatAmbientContext({
        conversationKind: "global",
        libraryID: 1,
      }),
      {},
    );
  });

  it("drops cross-library ambient resources instead of surfacing them", function () {
    stubZotero({
      pane: {
        getSelectedCollection: () => ({ id: 3, libraryID: 7, name: "Other" }),
        getSelectedItems: () => [regularItemStub({ libraryID: 7 })],
      },
      collections: { 3: { libraryID: 7 } },
    });
    const ambient = resolveLibraryChatAmbientContext({
      conversationKind: "global",
      libraryID: 1,
    });
    // Ambient state must never fail a turn: cross-library entries vanish.
    assert.isUndefined(ambient.collectionContext);
    assert.isUndefined(ambient.paperContext);
  });
});
