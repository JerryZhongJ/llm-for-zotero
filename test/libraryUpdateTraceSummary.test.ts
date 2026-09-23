import { assert } from "chai";
import { describe, it } from "mocha";

import { buildLibraryUpdateTraceSummaryForTests } from "../src/agent/tools";

const SUCCESS = { result: { operation: "apply_tags", operationId: "op-1" } };

describe("library update trace summary", function () {
  it("names added tags", function () {
    const summary = buildLibraryUpdateTraceSummaryForTests(
      { kind: "tags", action: "add", tags: ["machine learning", "vision"] },
      SUCCESS,
    );
    assert.equal(summary, 'Tags added: "machine learning", "vision"');
  });

  it("collapses long tag lists behind a +N more marker", function () {
    const summary = buildLibraryUpdateTraceSummaryForTests(
      {
        kind: "tags",
        action: "remove",
        tags: ["a", "b", "c", "d", "e"],
      },
      SUCCESS,
    );
    assert.equal(summary, 'Tags removed: "a", "b", "c" +2 more');
  });

  it("names the replaced tag set", function () {
    const summary = buildLibraryUpdateTraceSummaryForTests(
      { kind: "tags", action: "set", tags: ["final"] },
      SUCCESS,
    );
    assert.equal(summary, 'Tags set to "final"');
  });

  it("names the tag rename", function () {
    const summary = buildLibraryUpdateTraceSummaryForTests(
      { kind: "tag", action: "rename", tag: "typoed", newTag: "fixed" },
      SUCCESS,
    );
    assert.equal(summary, 'Tag renamed "typoed" → "fixed"');
  });

  it("names the target collection and distinguishes move from add", function () {
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        {
          kind: "collections",
          action: "add",
          mode: "move",
          targetCollectionName: "Reading List",
        },
        SUCCESS,
      ),
      'Moved to collection "Reading List"',
    );
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        { kind: "collections", action: "add", targetCollectionId: 7 },
        SUCCESS,
        { collection: (id) => (id === 7 ? "Methods" : null) },
      ),
      'Added to collection "Methods"',
    );
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        { kind: "collections", action: "remove", collectionId: 7 },
        SUCCESS,
        { collection: (id) => (id === 7 ? "Methods" : null) },
      ),
      'Removed from collection "Methods"',
    );
  });

  it("counts multi-item metadata and parent updates", function () {
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        {
          kind: "metadata",
          operations: [{}, {}, {}],
        },
        SUCCESS,
      ),
      "Metadata updated on 3 items",
    );
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        { kind: "metadata", itemIds: [1, 2, 3], operations: [{}, {}, {}] },
        SUCCESS,
      ),
      "Metadata updated on 3 items",
    );
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        { kind: "parent", assignments: [{ itemId: 1 }, { itemId: 2 }] },
        SUCCESS,
      ),
      "Parent item updated on 2 items",
    );
  });

  it("distinguishes related link from unlink", function () {
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        { kind: "related", action: "add", itemId: 1, relatedItemIds: [2] },
        SUCCESS,
      ),
      "Related items linked",
    );
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        { kind: "related", action: "remove", itemId: 1, relatedItemIds: [2] },
        SUCCESS,
      ),
      "Related items unlinked",
    );
  });

  it("returns null for pending calls, errors, and unrecognized payloads", function () {
    assert.isNull(
      buildLibraryUpdateTraceSummaryForTests({ kind: "tags" }, undefined),
    );
    assert.isNull(
      buildLibraryUpdateTraceSummaryForTests(
        { kind: "tags" },
        { error: "boom" },
      ),
    );
    assert.isNull(buildLibraryUpdateTraceSummaryForTests({}, SUCCESS));
  });

  it("names the affected papers when titles resolve", function () {
    const labels = {
      item: (id: number) =>
        ({ 1: "Paper A", 2: "Paper B", 3: "Paper C", 5: "Paper E" })[id] ||
        null,
    };
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        { kind: "tags", action: "add", itemIds: [1], tags: ["ml"] },
        SUCCESS,
        labels,
      ),
      'Tags added to "Paper A": "ml"',
    );
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        {
          kind: "collections",
          action: "add",
          mode: "move",
          itemIds: [1, 2],
          targetCollectionName: "Reading List",
        },
        SUCCESS,
        labels,
      ),
      'Moved "Paper A", "Paper B" to collection "Reading List"',
    );
    // Unresolvable titles collapse behind the +N more marker, so the row
    // never claims a smaller operation than it was.
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        {
          kind: "collections",
          action: "remove",
          itemIds: [1, 4, 5, 6],
          collectionId: 7,
        },
        SUCCESS,
        { ...labels, collection: () => "Methods" },
      ),
      'Removed "Paper A", "Paper E" +2 more from collection "Methods"',
    );
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        { kind: "metadata", itemId: 2, metadata: { date: "2024" } },
        SUCCESS,
        labels,
      ),
      'Metadata updated on "Paper B"',
    );
    assert.equal(
      buildLibraryUpdateTraceSummaryForTests(
        { kind: "related", action: "add", itemId: 1, relatedItemIds: [2] },
        SUCCESS,
        labels,
      ),
      'Related items linked: "Paper A", "Paper B"',
    );
  });
});
