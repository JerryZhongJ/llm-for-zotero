import { assert } from "chai";
import { describe, it } from "mocha";

import { buildLibraryImportTraceSummaryForTests } from "../src/agent/tools";

describe("library import trace summary", function () {
  it("lists imported titles and the target collection name", function () {
    const summary = buildLibraryImportTraceSummaryForTests({
      result: {
        operation: "import_identifiers",
        operationId: "op-1",
        result: {
          succeeded: 2,
          failed: 0,
          targetCollectionName: "Reading List",
          items: [
            {
              identifier: "10.1/a",
              status: "imported",
              itemId: 11,
              title: "Paper A",
            },
            {
              identifier: "10.1/b",
              status: "imported",
              itemId: 12,
              title: "Paper B",
            },
          ],
        },
      },
    });
    assert.equal(summary, 'Imported "Paper A", "Paper B" to Reading List');
  });

  it("collapses long import lists behind a +N more marker", function () {
    const items = [1, 2, 3, 4, 5].map((index) => ({
      identifier: `10.1/${index}`,
      status: "imported",
      itemId: index,
      title: `Paper ${index}`,
    }));
    const summary = buildLibraryImportTraceSummaryForTests({
      result: {
        operation: "import_identifiers",
        operationId: "op-2",
        result: {
          succeeded: 5,
          failed: 1,
          targetCollectionName: "Methods",
          items: [
            ...items,
            { identifier: "10.1/x", status: "not_found", reason: "no DOI" },
          ],
        },
      },
    });
    assert.equal(
      summary,
      'Imported "Paper 1", "Paper 2", "Paper 3" +2 more to Methods 1 failed',
    );
  });

  it("falls back to a readable count when imports carry no titles", function () {
    const summary = buildLibraryImportTraceSummaryForTests({
      result: {
        operation: "import_local_files",
        operationId: "op-3",
        result: {
          succeeded: 1,
          failed: 0,
          items: [{ filePath: "/tmp/a.pdf", status: "imported", itemId: 21 }],
        },
      },
    });
    assert.equal(summary, "Imported 1 item");
  });

  it("returns null for payloads without import outcomes", function () {
    assert.isNull(buildLibraryImportTraceSummaryForTests({}));
  });

  it("names the reason when nothing was imported", function () {
    const payload = (result: Record<string, unknown>) => ({
      result: { operation: "import_identifiers", operationId: "op-z", result },
    });
    assert.equal(
      buildLibraryImportTraceSummaryForTests(
        payload({
          succeeded: 0,
          failed: 0,
          items: [
            { identifier: "10.1/x", status: "not_found" },
            { identifier: "10.1/y", status: "not_found" },
          ],
        }),
      ),
      "No items imported — 2 not found",
    );
    assert.equal(
      buildLibraryImportTraceSummaryForTests(
        payload({
          succeeded: 0,
          failed: 1,
          items: [{ identifier: "10.1/z", status: "error" }],
        }),
      ),
      "Not imported — identifier failed to import",
    );
    assert.equal(
      buildLibraryImportTraceSummaryForTests(
        payload({
          succeeded: 0,
          failed: 0,
          items: [{ identifier: "10.1/w", status: "not_found" }],
        }),
      ),
      "Not imported — identifier not found",
    );
    assert.equal(
      buildLibraryImportTraceSummaryForTests(
        payload({ succeeded: 0, failed: 0, items: [] }),
      ),
      "No items imported",
    );
  });

  it("renders the singular outcome object (one status, produced items list)", function () {
    const outcomePayload = (outcome: Record<string, unknown>) => ({
      result: {
        operation: "import_identifiers",
        operationId: "op-s",
        result: outcome,
      },
    });
    assert.equal(
      buildLibraryImportTraceSummaryForTests(
        outcomePayload({
          status: "imported",
          items: [{ itemId: 11, title: "Paper A" }],
          targetCollectionName: "Reading List",
        }),
      ),
      'Imported "Paper A" to Reading List',
    );
    assert.equal(
      buildLibraryImportTraceSummaryForTests(
        outcomePayload({
          status: "imported",
          items: [
            { itemId: 11, title: "Paper A" },
            { itemId: 12, title: "Paper B" },
            { itemId: 13, title: "Paper C" },
            { itemId: 14, title: "Paper D" },
          ],
        }),
      ),
      'Imported "Paper A", "Paper B", "Paper C" +1 more',
    );
    assert.equal(
      buildLibraryImportTraceSummaryForTests(
        outcomePayload({
          status: "imported",
          items: [{ itemId: 11 }, { itemId: 12 }],
        }),
      ),
      "Imported 2 items",
    );
    assert.equal(
      buildLibraryImportTraceSummaryForTests(
        outcomePayload({
          status: "not_found",
          items: [],
          reason: "no DOI",
        }),
      ),
      "Not imported — no DOI",
    );
    assert.equal(
      buildLibraryImportTraceSummaryForTests(
        outcomePayload({ status: "error", items: [], reason: "boom" }),
      ),
      "Not imported — boom",
    );
  });
});
